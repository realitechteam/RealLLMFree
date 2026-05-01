# syntax=docker/dockerfile:1.7

# ── Stage 1: install + build ──────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder

# better-sqlite3 ships prebuilt binaries for Node 20 on linux-x64/arm64, but the
# build toolchain is needed as a fallback for unsupported platforms.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace manifests first for layer caching.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/

RUN npm ci

# Now copy source and build both workspaces.
COPY shared shared
COPY server server
COPY client client

RUN npm run build -w server \
 && npm run build -w client


# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/data \
    PUBLIC_DEPLOY=1

WORKDIR /app

# Production deps only. Copy manifests then prune dev deps.
COPY package.json package-lock.json ./
COPY shared shared
COPY server/package.json server/
COPY client/package.json client/

RUN npm ci --omit=dev

# Built artefacts and the shared types (consumed at runtime via package alias).
COPY --from=builder /app/server/dist server/dist
COPY --from=builder /app/client/dist client/dist

# Persistent volume target — Railway mounts a volume at /data via the platform
# config (railway.json + `railway volume add`). Note: Railway rejects Docker
# `VOLUME` directives, so we only ensure the directory exists.
RUN mkdir -p /data

EXPOSE 3001

# Healthcheck used by both Docker and Railway.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3001) +'/api/ping').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/index.js"]
