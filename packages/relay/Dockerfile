# syntax=docker/dockerfile:1
# Pane relay v1: single-container deploy. SQLite by default; mount /app/data
# for persistence. Slim (Debian/glibc) image because Prisma's default
# `binaryTargets` ship a glibc build for `debian-openssl-3.0.x`. Alpine works
# but needs an extra binary target.
#
# BUILD CONTEXT: the monorepo root (the directory with the workspace
# package.json + package-lock.json), NOT packages/relay. From the repo root:
#
#   docker build -f packages/relay/Dockerfile -t pane .

# ---------- stage 1: build ----------
FROM node:20-slim AS build
WORKDIR /app

# Which Prisma engine the generated client targets. Default `sqlite` keeps the
# self-host image byte-for-byte identical to before; `--build-arg
# DATABASE_PROVIDER=postgres` bakes a postgresql-targeted client for the hosted
# deployment (issue #40). `prisma-generate.mjs` accepts `sqlite`/`postgres` as
# its forced-schema argv.
ARG DATABASE_PROVIDER=sqlite

# Prisma needs libssl to pick the right query-engine binary; node:20-slim ships
# without it, so Prisma guesses (openssl-1.1.x) and warns. Install it explicitly.
# python3 + make + g++ are present so better-sqlite3 can build its native
# binding from source (see the rebuild step below); the runtime stage stays
# slim and just copies the compiled package across.
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Workspace manifests first, for layer caching. The relay depends on the
# @paneui/core AND @paneui/mcp workspace packages (the latter supplies the
# shared MCP tool handlers + guide composition for the remote MCP endpoint), so
# all three workspaces are installed. @paneui/mcp itself depends only on
# @paneui/core, so the install graph is core ← mcp ← relay.
COPY package.json package-lock.json ./
COPY packages/relay/package.json ./packages/relay/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
# --ignore-scripts: the root `prepare` script runs `husky`, a dev-only git-hook
# installer with no role inside the image (and the .git dir is not in context).
RUN npm ci --workspace @paneui/relay --workspace @paneui/core \
    --workspace @paneui/mcp \
    --include-workspace-root --ignore-scripts

# Re-run install scripts for better-sqlite3 only — the `--ignore-scripts`
# above skipped its prebuild-install/node-gyp postinstall, so its native
# binding never landed. prebuild-install falls back to node-gyp when no
# matching prebuilt binary is published (e.g. brand-new Node patch releases),
# which is why python3 + g++ are installed in this stage. The compiled
# package is copied verbatim into the runtime stage further down. pg is
# pure JS so doesn't need this dance.
RUN npm rebuild better-sqlite3 --workspace @paneui/relay

# Build @paneui/core first — both the relay and @paneui/mcp import its compiled
# output.
COPY packages/core/tsconfig.json ./packages/core/tsconfig.json
COPY packages/core/src ./packages/core/src
RUN npm run build --workspace @paneui/core

# Build @paneui/mcp next — the relay imports its compiled dist (the shared tool
# handlers, guide composition, and prompt/resource registration).
COPY packages/mcp/tsconfig.json ./packages/mcp/tsconfig.json
COPY packages/mcp/src ./packages/mcp/src
RUN npm run build --workspace @paneui/mcp

COPY packages/relay/prisma ./packages/relay/prisma
# `npm run generate` runs scripts/prisma-generate.mjs, so the scripts dir must
# be present. The prisma dir now also includes prisma/postgres/ (schema +
# migrations) — copied implicitly since it sits under prisma/.
COPY packages/relay/scripts ./packages/relay/scripts
# Prisma 7 reads the datasource URL from prisma.config.ts (the schemas no
# longer carry `url = env(...)`). Without it, `prisma generate` / `migrate`
# bail with P1012 / "datasource.url property is required".
COPY packages/relay/prisma.config.ts ./packages/relay/prisma.config.ts

COPY packages/relay/tsconfig.json packages/relay/tsconfig.client.json ./packages/relay/
COPY packages/relay/src ./packages/relay/src
# `npm run build` triggers `prebuild:server`, which itself runs
# prisma-generate.mjs in auto-select mode (DATABASE_URL is unset at build time,
# so it picks sqlite). To make the FINAL baked client match DATABASE_PROVIDER
# we run an explicit, forced generate AFTER the build — its forced argv wins
# over whatever prebuild:server produced, so the postgres client is not
# clobbered. The default (sqlite) build is unaffected.
RUN npm run build --workspace @paneui/relay \
    && npm run generate --workspace @paneui/relay -- "${DATABASE_PROVIDER}"

# ---------- stage 2: runtime ----------
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# libssl for the Prisma query engine (see build stage).
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
# Default to an in-container SQLite path; users can override with -e DATABASE_URL.
ENV DATABASE_URL=file:/app/data/pane.db
# Default filesystem-backend blob dir to a path inside the persisted /app/data
# volume. The relay's code default is `./data/blobs` (relative to cwd) which
# resolves to /app/packages/relay/data inside the image — a read-only path for
# the non-root `node` user, so the boot would fail with EACCES on first
# mkdir. Pinning the env to /app/data/blobs lands blobs in the data volume
# alongside the SQLite DB, so they persist across restarts. Operators can
# still override with -e BLOB_STORE_FS_DIR=... See #172.
ENV BLOB_STORE_FS_DIR=/app/data/blobs

# Prod deps only. --ignore-scripts: skip the root `prepare`/husky hook (husky is
# a devDependency and is absent under --omit=dev — without this, `npm ci` fails).
# @paneui/core is installed too: the relay imports it, and npm wires up the
# node_modules/@paneui/core workspace symlink that the import resolves through.
COPY package.json package-lock.json ./
COPY packages/relay/package.json ./packages/relay/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
RUN npm ci --omit=dev --workspace @paneui/relay --workspace @paneui/core \
    --workspace @paneui/mcp \
    --include-workspace-root --ignore-scripts

# Generated client + migrations + compiled JS. @paneui/core's and @paneui/mcp's
# compiled dist are copied so the workspace symlinks resolve to real built
# output at runtime (the relay imports @paneui/mcp/tools etc.).
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
# better-sqlite3's native binding (.node) is built in the build stage (which
# has python3/g++); the runtime stage's `npm ci --ignore-scripts` left it
# missing, so the Prisma sqlite adapter would throw "Could not locate the
# bindings file" on first connect. Overlay the compiled package from build.
COPY --from=build /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/mcp/dist ./packages/mcp/dist
COPY --from=build /app/packages/relay/dist ./packages/relay/dist
COPY packages/relay/prisma ./packages/relay/prisma
# Migration runner (bounded retry wrapper around `prisma migrate deploy`).
COPY packages/relay/scripts ./packages/relay/scripts
# `migrate deploy` (run on every boot from CMD) reads DATABASE_URL through
# this config in Prisma 7 — the schemas no longer carry `url = env(...)`.
COPY packages/relay/prisma.config.ts ./packages/relay/prisma.config.ts
# The pane agent skill, served verbatim at GET /skills/pane/SKILL.md. The skill
# route resolves it relative to the relay package root (see routes/skill.ts),
# so it is copied into the package rather than to the image root.
COPY skills ./packages/relay/skills

WORKDIR /app/packages/relay
# Run as the unprivileged `node` user (uid 1000, ships with the base image).
# The data dir must be owned by it so the default SQLite DB is writable.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]
EXPOSE 3000
USER node

# Apply migrations on every boot (idempotent), then start the relay.
# `prisma` is a runtime dependency (see packages/relay/package.json), so it is
# present in node_modules after `npm ci --omit=dev` — `npx` resolves the local
# binary instead of downloading it on every boot.
#
# scripts/migrate-deploy.mjs wraps `prisma migrate deploy` in a small bounded
# retry (5 attempts, 3s apart) so a briefly-unavailable DB — e.g. a Postgres
# sidecar still starting — does not crash the container on boot. A genuinely
# broken DB still fails the boot after the attempts are exhausted.
#
# migrate-deploy.mjs is engine-aware: it detects sqlite vs postgres from the
# runtime DATABASE_URL and selects the matching schema (prisma/postgres/schema.prisma
# for postgres, whose migrations resolve from prisma/postgres/migrations/). So
# the same image entrypoint works for both engines — the generated client baked
# in at build time (DATABASE_PROVIDER build arg) just has to match the engine
# the container is run against.
CMD ["sh", "-c", "node scripts/migrate-deploy.mjs && node dist/index.js"]
