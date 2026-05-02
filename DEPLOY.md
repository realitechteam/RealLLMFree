# Deploy — Railway + Cloudflare

This is the canonical path for putting RealLLMFree online: **Railway** runs the container, **Cloudflare** fronts it for DNS + TLS + WAF. Persistent state (SQLite DB, encrypted keys) lives on a Railway volume.

> Self-hosting on a Pi or VPS? `Dockerfile` works the same — `docker run -p 3001:3001 -v rlf-data:/data -e ENCRYPTION_KEY=... realllmfree`. Skip the Railway section.

## 1. Generate the encryption key

You'll set this as a Railway env var. Once chosen it is **load-bearing forever** — the SQLite DB is encrypted with a key wrapped by it. Lose it = lose every stored provider key.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save the 64-char hex output somewhere safe (1Password / vault).

## 2. Push to GitHub

Railway deploys from a Git repo. Either fork the repo or push your own:

```bash
git remote add origin git@github.com:<you>/realllmfree.git
git push -u origin main
```

## 3. Create the Railway service

1. Railway dashboard → **New Project** → **Deploy from GitHub repo** → pick the repo.
2. Railway sees `railway.json` + `Dockerfile` and builds from the multi-stage Dockerfile automatically. Build takes ~2–3 min.
3. Once it's up, expose it: service → **Settings** → **Networking** → **Generate Domain** (gives you `xxx.up.railway.app`).

## 4. Configure environment variables

Service → **Variables** → add:

| Variable | Value | Notes |
|---|---|---|
| `ENCRYPTION_KEY` | 64-char hex from step 1 | Required. Server crashes on boot without it. |
| `PUBLIC_DEPLOY` | `1` | Forces unified-key auth on `/v1`, even from loopback. Don't ship without this. |
| `PORT` | *(leave blank — Railway injects it)* | The Dockerfile defaults to 3001 locally; Railway overrides at runtime. |
| `DATA_DIR` | `/data` | Already set in Dockerfile, but listing here so the volume mount is obvious. |

## 5. Mount a persistent volume

Without this, your DB resets on every redeploy and you lose every key.

Service → **Settings** → **Volumes** → **+ New Volume**:
- Mount path: `/data`
- Size: 1 GB is plenty (the DB is < 50 MB even with months of analytics).

Redeploy after attaching. On first boot the server logs your initial unified API key to stdout — copy it from the deploy logs:

```
  Your unified API key: realllmfree-<48 hex chars>
```

You can rotate this later from the dashboard's Keys page.

## 6. Smoke-test

```bash
curl https://xxx.up.railway.app/api/ping
# {"status":"ok","timestamp":"..."}

curl https://xxx.up.railway.app/v1/chat/completions \
  -H "Authorization: Bearer realllmfree-<your-key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
```

The dashboard is at the same domain (`/`).

## 7. Cloudflare in front (when domain is ready)

1. Add your domain in Cloudflare → it gives you nameservers; point the registrar at them.
2. DNS tab → **Add record** → `CNAME` → `api` (or `@`) → `xxx.up.railway.app` → **Proxy: ON** (orange cloud).
3. Railway service → **Settings** → **Networking** → **Custom Domain** → add `api.yourdomain.com`. Railway will issue a cert via ACME; Cloudflare will reverse-proxy.
4. Cloudflare → **SSL/TLS** → set mode to **Full (strict)** so the edge → Railway hop also uses TLS.

### Cloudflare gotchas

- **Streaming**: Cloudflare buffers responses by default, which breaks SSE. Add a Configuration Rule → match `/v1/chat/completions` → set **Cache Level: Bypass** and **Disable Performance** (or use a Worker that explicitly streams). Test with `curl -N` and `stream: true`.
- **Cloudflare's 100s timeout** on the Free plan kills long completions. If you see truncated streams, either upgrade or add a Worker with `cf.proxy_read_timeout`.
- **req.ip**: the app already calls `app.set('trust proxy', true)`, so `X-Forwarded-For` from Cloudflare is honored. Combined with `PUBLIC_DEPLOY=1`, the unified-key check is enforced on every request from the edge.

## 8. After deploy

- Open `/keys` in the dashboard, paste your provider keys, hit Save.
- `/fallback` to reorder priority. The router learns 429 patterns over time, but the static priority is your starting point.
- `/analytics` to confirm requests are landing.

## Optional: enable Kiro AI for free Claude Sonnet 4.5

Kiro AI is the highest-quality free-tier model in the catalog (Anthropic Sonnet 4.5
via AWS Builder ID OAuth). It's NOT enabled by default because it requires running
the [`jwadow/kiro-gateway`](https://github.com/jwadow/kiro-gateway) sidecar, which
in turn needs credentials extracted from a logged-in Kiro IDE / Kiro CLI session.

### One-time setup

1. **Get Kiro credentials**:
   - Install Kiro IDE: https://kiro.dev/
   - Sign in with **AWS Builder ID** (free, no credit card)
   - Find the credentials file at `~/.aws/sso/cache/kiro-auth-token.json`
     (Linux/macOS) or `%USERPROFILE%\.aws\sso\cache\kiro-auth-token.json` (Windows)
   - Copy its `refreshToken` value (a long JWT-like string)

2. **Pick a proxy password** — any random string. Save it; you'll paste it as the
   "API key" on the Keys page later.
   ```bash
   PROXY_KEY=$(openssl rand -hex 24)   # e.g. "9f2a3b…"
   ```

### Local Docker (single-machine setup)

```bash
docker run -d \
  -p 8000:8000 \
  -e PROXY_API_KEY="$PROXY_KEY" \
  -e REFRESH_TOKEN="<paste refreshToken from kiro-auth-token.json>" \
  --name kiro-gateway \
  ghcr.io/jwadow/kiro-gateway:latest
```

Then on the RealLLMFree server, set:
```
KIRO_GATEWAY_URL=http://host.docker.internal:8000/v1
```
…and on the Keys page paste `$PROXY_KEY` as a `kiro` API key.

### Railway sibling service

1. Railway project → **+ New** → **Empty Service** → name it `kiro-gateway`.
2. Settings → **Source** → **Docker Image** → `ghcr.io/jwadow/kiro-gateway:latest`.
3. Variables → set `PROXY_API_KEY` (random) and `REFRESH_TOKEN` (from step 1 above).
4. Networking → **Internal Domain** is auto-assigned, e.g. `kiro-gateway.railway.internal`.
5. Back on the `realllmfree` service → Variables → set
   `KIRO_GATEWAY_URL=http://kiro-gateway.railway.internal:8000/v1`. Redeploy.
6. RealLLMFree dashboard → Keys → add a `kiro` row, paste the `PROXY_API_KEY`.
7. Fallback page → re-enable the kiro models (they default to disabled). Sonnet 4.5
   has rank 1 and will become the top-priority route once enabled with a working key.

### Rotating the Kiro refresh token

The Builder ID refresh token expires periodically (Kiro IDE refreshes it
automatically while you use the IDE). If the gateway starts returning 403s, log
back into Kiro IDE briefly, copy the new `refreshToken`, update the
`REFRESH_TOKEN` env on `kiro-gateway`, and restart it.

## Rollback / disaster recovery

- **Bad deploy:** Railway → **Deployments** → click a previous green build → **Redeploy**.
- **Volume corruption:** the DB is encrypted at rest; you cannot restore it from anywhere except a snapshot of `/data/realllmfree.db`. Take periodic snapshots if you care: Railway → service → volume → **Snapshots**.
- **Key rotation:** Dashboard → Keys page → rotate the unified key. Old key is invalidated immediately.
