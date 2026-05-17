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

# Prisma needs libssl to pick the right query-engine binary; node:20-slim ships
# without it, so Prisma guesses (openssl-1.1.x) and warns. Install it explicitly.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Workspace manifests first, for layer caching. Only the relay workspace is
# needed to build the relay (it depends on no other workspace package).
COPY package.json package-lock.json ./
COPY packages/relay/package.json ./packages/relay/package.json
# --ignore-scripts: the root `prepare` script runs `husky`, a dev-only git-hook
# installer with no role inside the image (and the .git dir is not in context).
RUN npm ci --workspace @pane/relay --include-workspace-root --ignore-scripts

COPY packages/relay/prisma ./packages/relay/prisma
# `npm run generate` runs scripts/prisma-generate.mjs, so the scripts dir must
# be present. With no DATABASE_URL set at build time it auto-selects the
# default sqlite schema.
COPY packages/relay/scripts ./packages/relay/scripts
RUN npm run generate --workspace @pane/relay

COPY packages/relay/tsconfig.json packages/relay/tsconfig.client.json ./packages/relay/
COPY packages/relay/src ./packages/relay/src
RUN npm run build --workspace @pane/relay

# ---------- stage 2: runtime ----------
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production

# libssl for the Prisma query engine (see build stage).
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
# Default to an in-container SQLite path; users can override with -e DATABASE_URL.
ENV DATABASE_URL=file:/app/data/pane.db

# Prod deps only. --ignore-scripts: skip the root `prepare`/husky hook (husky is
# a devDependency and is absent under --omit=dev — without this, `npm ci` fails).
COPY package.json package-lock.json ./
COPY packages/relay/package.json ./packages/relay/package.json
RUN npm ci --omit=dev --workspace @pane/relay --include-workspace-root --ignore-scripts

# Generated client + migrations + compiled JS.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/packages/relay/dist ./packages/relay/dist
COPY packages/relay/prisma ./packages/relay/prisma

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
# `migrate deploy` with no --schema uses the default sqlite schema. A Postgres
# deployment must run against schema.postgres.prisma — handled in the hosted
# build path (issue #40), not this default self-host image.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
