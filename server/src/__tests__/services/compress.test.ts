import { describe, it, expect } from 'vitest';
import { compressMessages } from '../../services/compress.js';
import type { ChatMessage } from '@realllmfree/shared/types.js';

function toolMsg(content: string): ChatMessage {
  return { role: 'tool', content, tool_call_id: 'call_1' };
}

describe('compressMessages', () => {
  it('passes through small payloads untouched', () => {
    const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    const r = compressMessages(msgs);
    expect(r.messages).toEqual(msgs);
    expect(r.savedBytes).toBe(0);
  });

  it('never alters user or assistant messages, even when long', () => {
    const long = 'x'.repeat(5000);
    const msgs: ChatMessage[] = [
      { role: 'user', content: long },
      { role: 'assistant', content: long },
    ];
    const r = compressMessages(msgs);
    expect(r.messages[0].content).toBe(long);
    expect(r.messages[1].content).toBe(long);
    expect(r.savedBytes).toBe(0);
  });

  it('compresses git diff hunks with long unchanged context', () => {
    const ctx = (' unchanged context line\n').repeat(80);
    const diff =
      'diff --git a/src/foo.ts b/src/foo.ts\n' +
      '--- a/src/foo.ts\n' +
      '+++ b/src/foo.ts\n' +
      '@@ -1,80 +1,80 @@\n' +
      ctx +
      '-old line\n' +
      '+new line\n' +
      ctx;
    const r = compressMessages([toolMsg(diff)]);
    const out = r.messages[0].content as string;
    expect(out).toContain('diff --git');
    expect(out).toContain('-old line');
    expect(out).toContain('+new line');
    expect(out).toContain('unchanged lines');
    expect(r.savedBytes).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(diff.length);
  });

  it('dedupes repeated grep results', () => {
    const grep = Array.from({ length: 80 }, (_, i) =>
      `src/file${i % 5}.ts:${i + 1}:matched line content`).join('\n');
    const r = compressMessages([toolMsg(grep)]);
    const out = r.messages[0].content as string;
    // 80 lines, 5 unique signatures → exactly 5 unique result lines kept.
    expect(out.split('\n').filter(l => l.includes('.ts:'))).toHaveLength(5);
    expect(r.savedBytes).toBeGreaterThan(0);
  });

  it('collapses long find output by directory', () => {
    const lines = [
      ...Array.from({ length: 50 }, (_, i) => `node_modules/lodash/file${i}.js`),
      ...Array.from({ length: 30 }, (_, i) => `src/components/comp${i}.tsx`),
    ];
    const r = compressMessages([toolMsg(lines.join('\n'))]);
    const out = r.messages[0].content as string;
    expect(out).toMatch(/more files in node_modules\/lodash\//);
    expect(out).toMatch(/more files in src\/components\//);
    expect(out.length).toBeLessThan(lines.join('\n').length);
  });

  it('collapses adjacent identical log lines into ×N count', () => {
    const log = Array.from({ length: 60 }, () =>
      '2026-05-01T12:34:56.789Z INFO heartbeat ok').join('\n');
    const r = compressMessages([toolMsg(log)]);
    const out = r.messages[0].content as string;
    expect(out).toMatch(/×60/);
    expect(out.split('\n').length).toBeLessThan(5);
    expect(r.savedBytes).toBeGreaterThan(0);
  });

  it('hard-truncates above MAX_BYTES with explicit marker', () => {
    const huge = 'x'.repeat(40_000);
    const r = compressMessages([toolMsg(huge)]);
    const out = r.messages[0].content as string;
    expect(out).toContain('chars truncated to fit context budget');
    expect(out.length).toBeLessThan(huge.length);
  });

  it('falls back to original when compression would inflate output', () => {
    // Random content that doesn't match any compressor heuristic — but is over
    // MIN_BYTES so the function still tries.
    const random = 'a single line of text without any structure '.repeat(50);
    const r = compressMessages([toolMsg(random)]);
    // Either unchanged (no kind matched) or strictly smaller — never bigger.
    const out = r.messages[0].content as string;
    expect(out.length).toBeLessThanOrEqual(random.length);
  });
});
