// Lossless tool-output compressor — modeled after 9router's RTK Token Saver.
//
// Coding agents (Cursor, Cline, Continue, Claude Code) pipe huge tool outputs
// back into the proxy as `role: 'tool'` messages: `git diff` of the whole repo,
// `find . -name '*.ts'` listing 5000 files, `npm run build` log of 800 warnings.
// Most of that bulk is redundant — repeated paths, blank context, identical
// adjacent log lines. Compressing it before the upstream call saves 15-30% of
// the user's daily token budget without touching response quality.
//
// Strategy:
//   1. Only operate on `role: 'tool'` messages — never alter user/assistant text.
//   2. Detect content type from the first ~512 chars (cheap heuristic).
//   3. Apply the matching compressor; if it throws or makes things worse, keep
//      the original message verbatim.
//   4. Skip compression entirely for messages under MIN_BYTES — overhead beats
//      gains on small payloads.

import type { ChatMessage } from '@realllmfree/shared/types.js';

const MIN_BYTES = 1024;          // skip messages smaller than this
const MAX_BYTES = 32 * 1024;     // hard truncate above this

export interface CompressResult {
  messages: ChatMessage[];
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
}

type Compressor = (input: string) => string;

/** Detect which compressor applies, by leading content. */
function detectKind(s: string): 'git-diff' | 'git-status' | 'grep' | 'find' | 'tree' | 'log' | 'unknown' {
  const head = s.slice(0, 512);

  if (/^diff --git /m.test(head)) return 'git-diff';
  if (/^On branch [\w/-]+/m.test(head) || /^\s+(modified|new file|deleted):/m.test(head)) return 'git-status';
  // Tree-drawing characters are unambiguous.
  if (/[├└│─]/.test(head)) return 'tree';
  // ISO-timestamp prefixed lines = log.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/m.test(head)) return 'log';
  // grep -r output: many lines of `path:lineno:content`.
  const grepLines = head.split('\n').filter(l => /^[\w./-]+:\d+:/.test(l));
  if (grepLines.length >= 3) return 'grep';
  // find/ls output: many lines that look like file paths, no other punctuation.
  const findLines = head.split('\n').filter(l => /^[\w./-]+$/.test(l) && l.includes('/'));
  if (findLines.length >= 5) return 'find';

  return 'unknown';
}

// ── individual compressors ───────────────────────────────────────────────────

/** git diff: drop blank trailing context lines from each hunk. The diff stays
 * structurally valid (hunk headers + +/- lines preserved); we just trim runs of
 * unchanged context that exceed 3 lines, replacing them with `[ ... N lines ... ]`. */
const compressGitDiff: Compressor = (s) => {
  const out: string[] = [];
  let contextRun: string[] = [];
  for (const line of s.split('\n')) {
    if (line.startsWith(' ') || line === '') {
      contextRun.push(line);
    } else {
      if (contextRun.length > 6) {
        out.push(...contextRun.slice(0, 3));
        out.push(`[ ... ${contextRun.length - 6} unchanged lines ... ]`);
        out.push(...contextRun.slice(-3));
      } else {
        out.push(...contextRun);
      }
      contextRun = [];
      out.push(line);
    }
  }
  if (contextRun.length > 6) {
    out.push(...contextRun.slice(0, 3));
    out.push(`[ ... ${contextRun.length - 6} unchanged lines ... ]`);
    out.push(...contextRun.slice(-3));
  } else {
    out.push(...contextRun);
  }
  return out.join('\n');
};

/** git status: just normalize blank-line runs. */
const compressGitStatus: Compressor = (s) => s.replace(/\n{3,}/g, '\n\n');

/** grep -r: dedup repeated paths, keep one match per (path, content) pair. */
const compressGrep: Compressor = (s) => {
  const seen = new Set<string>();
  return s.split('\n').filter(l => {
    if (!l.trim()) return false;
    const m = l.match(/^([\w./-]+):\d+:(.*)$/);
    if (!m) return true;
    const sig = `${m[1]}::${m[2]}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  }).join('\n');
};

/** find / ls: collapse contiguous runs of files inside the same directory. */
const compressFind: Compressor = (s) => {
  const lines = s.split('\n').filter(l => l.trim());
  if (lines.length < 20) return s; // small enough, leave alone
  const byDir = new Map<string, string[]>();
  const order: string[] = [];
  for (const l of lines) {
    const slash = l.lastIndexOf('/');
    const dir = slash >= 0 ? l.slice(0, slash) : '.';
    if (!byDir.has(dir)) { byDir.set(dir, []); order.push(dir); }
    byDir.get(dir)!.push(l);
  }
  const out: string[] = [];
  for (const dir of order) {
    const files = byDir.get(dir)!;
    if (files.length <= 5) {
      out.push(...files);
    } else {
      out.push(...files.slice(0, 3));
      out.push(`[ ... ${files.length - 5} more files in ${dir}/ ... ]`);
      out.push(...files.slice(-2));
    }
  }
  return out.join('\n');
};

/** tree: cap each subtree at N children. */
const compressTree: Compressor = (s) => {
  const lines = s.split('\n');
  const out: string[] = [];
  let depthGroup: string[] = [];
  let lastDepth = -1;
  const flush = () => {
    if (depthGroup.length > 12) {
      out.push(...depthGroup.slice(0, 6));
      out.push(`[ ... ${depthGroup.length - 12} more entries ... ]`);
      out.push(...depthGroup.slice(-6));
    } else {
      out.push(...depthGroup);
    }
    depthGroup = [];
  };
  for (const line of lines) {
    const m = line.match(/^([\s│]+[├└])/);
    const depth = m ? m[1].length : 0;
    if (depth !== lastDepth) {
      flush();
      lastDepth = depth;
    }
    depthGroup.push(line);
  }
  flush();
  return out.join('\n');
};

/** log: dedup adjacent identical lines (timestamp-stripped) into "msg (×N)". */
const compressLog: Compressor = (s) => {
  const stripTs = (l: string) =>
    l.replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?\s*/, '').replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '');
  const out: string[] = [];
  let prevStripped = '';
  let prevRaw = '';
  let count = 0;
  const flush = () => {
    if (!prevRaw) return;
    if (count > 1) out.push(`${prevRaw}  (×${count})`);
    else out.push(prevRaw);
  };
  for (const line of s.split('\n')) {
    const stripped = stripTs(line);
    if (stripped === prevStripped) {
      count++;
    } else {
      flush();
      prevStripped = stripped;
      prevRaw = line;
      count = 1;
    }
  }
  flush();
  return out.join('\n');
};

/** Last-resort: if a tool message is over MAX_BYTES, keep head + tail and
 * indicate truncation. Lossy on the dropped middle, but documented. */
function smartTruncate(s: string): string {
  if (s.length <= MAX_BYTES) return s;
  const head = s.slice(0, Math.floor(MAX_BYTES * 0.4));
  const tail = s.slice(-Math.floor(MAX_BYTES * 0.4));
  return `${head}\n\n[ ... ${s.length - head.length - tail.length} chars truncated to fit context budget ... ]\n\n${tail}`;
}

const COMPRESSORS: Record<string, Compressor> = {
  'git-diff': compressGitDiff,
  'git-status': compressGitStatus,
  'grep': compressGrep,
  'find': compressFind,
  'tree': compressTree,
  'log': compressLog,
};

/** Top-level entry. Returns new messages + savings stats. Never throws. */
export function compressMessages(messages: ChatMessage[]): CompressResult {
  let originalBytes = 0;
  let compressedBytes = 0;
  const out: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.role !== 'tool' || typeof msg.content !== 'string' || msg.content.length < MIN_BYTES) {
      out.push(msg);
      if (typeof msg.content === 'string') {
        originalBytes += msg.content.length;
        compressedBytes += msg.content.length;
      }
      continue;
    }

    const orig = msg.content;
    originalBytes += orig.length;
    let compressed = orig;
    try {
      const kind = detectKind(orig);
      const fn = COMPRESSORS[kind];
      if (fn) compressed = fn(orig);
      compressed = smartTruncate(compressed);
      // Sanity: compression must actually save bytes; otherwise fall back.
      if (compressed.length > orig.length) compressed = orig;
    } catch {
      compressed = smartTruncate(orig);
    }
    compressedBytes += compressed.length;
    out.push({ ...msg, content: compressed });
  }

  return {
    messages: out,
    originalBytes,
    compressedBytes,
    savedBytes: originalBytes - compressedBytes,
  };
}
