# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Common commands

Run from the repo root unless noted. The repo is an npm workspaces monorepo (`shared`, `server`, `client`).

```bash
npm install                  # install all workspaces
npm run dev                  # server (:3001) + client (:5173) concurrently with HMR
npm test                     # vitest in server, then client lint pass
npm run build                # tsc + vite build for both workspaces
node server/dist/index.js    # run prod build (server also serves client/dist)
```

Workspace-specific:

```bash
npm test -w server                              # vitest run (server only)
npm run test:watch -w server                    # vitest watch
npx vitest run server/src/__tests__/services/router.test.ts -w server   # one test file
npx vitest run -t "fallback chain" -w server    # single test by name
npm run dev -w server                           # tsx watch
npm run dev -w client                           # vite only
npm run build -w server                         # tsc → server/dist
npm run build -w client                         # tsc -b && vite build → client/dist
npm run lint -w client                          # eslint (no lint config in server)
```

Encryption key bootstrap (required before first run):

```bash
cp .env.example .env
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))" >> .env
```

Server expects `ENCRYPTION_KEY` (64-char hex) in env or it will fail to start. SQLite DB lives at `server/data/realllmfree.db` (auto-created).

## Architecture

The repo is an OpenAI-compatible aggregating proxy in front of ~14 free-tier LLM providers. The single load-bearing path is `/v1/chat/completions`; everything else (dashboard, key management, analytics) is supporting infra.

**Request flow** (`server/src/routes/proxy.ts`):

1. Request hits `/v1/chat/completions`. Bearer token must match the unified key from `settings.unified_api_key` unless caller is loopback.
2. `routeRequest()` (`server/src/services/router.ts`) walks `fallback_config` ordered by `priority + dynamic_penalty`, picks the first model whose:
   - `models.enabled = 1`
   - has a registered provider adapter
   - has a non-`invalid` `api_keys` row for that platform
   - is not on cooldown and is under all rate limits (`canMakeRequest` / `canUseTokens`)
3. Multi-turn conversations get **sticky session** routing: the first user message + message-count fingerprint maps to the model that served it for 30 min, so the proxy doesn't switch models mid-conversation (causes hallucination spikes).
4. Provider adapter does the upstream call. On 429/5xx/timeout (`isRetryableError`), the proxy puts that `(platform, model, keyId)` triple on a 120s cooldown via `setCooldown`, calls `recordRateLimitHit` to bump that model's penalty (decays over time), adds it to a per-request `skipKeys` set, and re-routes — up to `MAX_RETRIES = 20`.
5. Streaming responses can't be retried once any byte has been written; non-streaming has full retry.
6. Every response gets `X-Routed-Via: <platform>/<model>` and `X-Fallback-Attempts: N` if `attempt > 0`.

**Provider adapters** (`server/src/providers/`):

- All inherit `BaseProvider` (`base.ts`) — abstract `chatCompletion`, `streamChatCompletion`, `validateKey`.
- Most providers are OpenAI-compatible — they're constructed inline in `providers/index.ts` from the generic `OpenAICompatProvider`. Adding such a provider = one `register(...)` call plus seed rows.
- Special cases that need their own file: `google.ts` (Gemini API has its own request/response shape and tool-calling is `functionDeclarations`/`functionResponse` — translated both ways), `cohere.ts`, `cloudflare.ts` (account-id+token in one key string), `huggingface.ts`.
- Tool calling: OpenAI-compat providers pass through `tools`/`tool_choice` unchanged; Google adapter does the bidirectional translation. Both round-trip `assistant.tool_calls` → `tool` role replies → final answer.

**Persistence and rate limits**:

- SQLite via `better-sqlite3` (synchronous; no async pool needed). Schema lives in `server/src/db/index.ts` `createTables()`.
- API keys are AES-256-GCM encrypted (`server/src/lib/crypto.ts`). The 32-byte content key is wrapped with a key derived from `ENCRYPTION_KEY` env var and stored in the `settings` table on first run; it's only decrypted in-memory just before a provider call.
- Rate-limit ledger (`server/src/services/ratelimit.ts`) is **in-memory sliding-window** per `(platform, model, keyId, kind)` where kind ∈ {rpm, rpd, tpm, tpd}. Restarts wipe usage counters — that's intentional and documented.
- Per-model dynamic penalties (`recordRateLimitHit` / `recordSuccess` in `router.ts`) are ALSO in-memory; they decay 1 unit per 2 min back to 0.

**Catalog migrations** (`db/index.ts`):

- `seedModels()` inserts the initial `models` + `fallback_config` rows. It only runs when the table is empty.
- `migrateModels`, `migrateModelsV2`…`migrateModelsV6` are **idempotent in-place upgrades**: they correct stale rate limits, rename obsolete model IDs (e.g. DeepSeek-R1 → V3.1, gpt-5 → gpt-4o), and add new probe-verified models. They run on every startup. When you add or correct a model, write a new `migrateModelsV{N+1}` rather than editing existing migrations — the seed data is the April-2026-snapshot baseline and live DBs depend on subsequent migrations stacking forward.
- Every migration that adds models must also backfill `fallback_config` rows (UNIQUE on `model_db_id`) — the existing helper at the end of each `apply` transaction does this; copy that pattern.

**Frontend** (`client/`):

- React 19 + Vite + Tailwind 4 + shadcn/ui. Pages in `client/src/pages/`: Playground, Keys, Fallback, Analytics. Routing in `App.tsx`.
- Talks to `/api/*` for admin (proxied to :3001 in dev) and `/v1/*` for the playground.
- In production, `server/src/app.ts` serves `client/dist/` as static files with an SPA fallback (all non-`/api/`/`/v1/` paths → `index.html`).

**Shared types** (`shared/types.ts`): re-exported via `@realllmfree/shared`. Server imports as `@realllmfree/shared/types.js` (note the `.js` — required because server is `"type": "module"` and TS resolves to `.js` at runtime).

## Conventions and gotchas

- **ES modules everywhere**. Server is `"type": "module"`; relative imports inside server must include the `.js` extension even though source files are `.ts`.
- **Don't edit historical `migrateModelsV*` functions** — they're applied to live DBs in order. Add a new `migrateModelsV{N+1}` and call it from `initDb()`.
- **Never read DB encryption key from anywhere but `process.env.ENCRYPTION_KEY`**. The wrapped content key in `settings` is decrypted with that env var at boot and held in-process only.
- **Streaming retries are impossible after first byte.** If you change `proxy.ts`, preserve the invariant that `res.write` cannot happen until the chosen provider's first chunk arrives — once headers/body are sent we can't fall back without breaking the SSE stream.
- **Sticky session key is `first_user_message[:100] + (multi|single)`**. If you change message normalisation (e.g. trim whitespace differently) you'll silently invalidate every active session.
- **Tests use `:memory:` SQLite** — `initDb(':memory:')` skips WAL and the data directory creation. Mirror that in any new test.
- **Client lint config is in `client/eslint.config.js`** (flat config, ESLint 9). The server has no lint step — vitest + tsc are the only checks.
- **CI** (`.github/workflows/ci.yml`) runs `npm test -w server` and both builds on Node 20. Client tests are not run in CI; client lint is not run in CI either.
