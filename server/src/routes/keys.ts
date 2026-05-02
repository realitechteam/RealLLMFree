import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';

export const keysRouter = Router();

const PLATFORMS = [
  'google', 'groq', 'cerebras', 'sambanova', 'nvidia', 'mistral',
  'openrouter', 'github', 'huggingface', 'cohere', 'cloudflare',
  'zhipu', 'moonshot', 'minimax', 'opencode', 'kiro',
] as const;

const addKeySchema = z.object({
  platform: z.enum(PLATFORMS),
  key: z.string().min(1),
  label: z.string().optional(),
});

// List all keys (masked)
keysRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all() as any[];

  const keys = rows.map(row => {
    let maskedKey = '****';
    try {
      const realKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      maskedKey = maskKey(realKey);
    } catch {
      maskedKey = '[decrypt failed]';
    }
    return {
      id: row.id,
      platform: row.platform,
      label: row.label,
      maskedKey,
      status: row.status,
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      lastCheckedAt: row.last_checked_at,
    };
  });

  res.json(keys);
});

// Add a key
keysRouter.post('/', (req: Request, res: Response) => {
  const parsed = addKeySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const { platform, key, label } = parsed.data;
  const { encrypted, iv, authTag } = encrypt(key);

  const db = getDb();
  const result = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `).run(platform, label ?? '', encrypted, iv, authTag);

  res.status(201).json({
    id: result.lastInsertRowid,
    platform,
    label: label ?? '',
    maskedKey: maskKey(key),
    status: 'unknown',
    enabled: true,
  });
});

// Bulk import: paste a multi-line .env-style blob and import every recognised line
// at once. Lines look like `groq=gsk_xxx` or `openrouter=sk-or-v1-xxx`. Comments
// (#...) and blank lines are skipped. For Cloudflare, the value must be
// `account_id:token`.
const bulkSchema = z.object({ text: z.string().min(1) });

interface BulkResult {
  ok: { line: number; platform: string; id: number }[];
  skipped: { line: number; reason: string; raw: string }[];
}

keysRouter.post('/bulk', (req: Request, res: Response) => {
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'text body is required' } });
    return;
  }

  const result: BulkResult = { ok: [], skipped: [] };
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'unknown', 1)
  `);

  const lines = parsed.data.text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq < 0) {
      result.skipped.push({ line: i + 1, reason: 'expected platform=key format', raw: trimmed.slice(0, 30) });
      continue;
    }

    // Normalise: lowercase platform, strip optional quotes, accept common .env-style aliases
    let platform = trimmed.slice(0, eq).trim().toLowerCase();
    let value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    // .env aliases like GROQ_API_KEY → groq
    platform = platform.replace(/_api_?key$/, '').replace(/_token$/, '');
    if (platform === 'gemini') platform = 'google';
    if (platform === 'kimi') platform = 'moonshot';
    if (platform === 'zai' || platform === 'glm') platform = 'zhipu';

    if (!(PLATFORMS as readonly string[]).includes(platform)) {
      result.skipped.push({ line: i + 1, reason: `unknown platform "${platform}"`, raw: platform });
      continue;
    }
    if (!value) {
      result.skipped.push({ line: i + 1, reason: 'empty value', raw: platform });
      continue;
    }

    try {
      const { encrypted, iv, authTag } = encrypt(value);
      const insertResult = insert.run(platform, '', encrypted, iv, authTag);
      result.ok.push({ line: i + 1, platform, id: Number(insertResult.lastInsertRowid) });
    } catch (err: any) {
      result.skipped.push({ line: i + 1, reason: err.message ?? 'insert failed', raw: platform });
    }
  }

  res.status(result.ok.length > 0 ? 201 : 200).json(result);
});

// Delete a key
keysRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  res.json({ success: true });
});

// Toggle enable/disable
keysRouter.patch('/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: { message: 'Invalid key ID' } });
    return;
  }

  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { message: 'enabled must be a boolean' } });
    return;
  }

  const db = getDb();
  const result = db.prepare('UPDATE api_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);

  if (result.changes === 0) {
    res.status(404).json({ error: { message: 'Key not found' } });
    return;
  }

  res.json({ success: true, enabled });
});
