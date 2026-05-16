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

# Workspace manifests first, for layer caching. Only the relay workspace is
# needed to build the relay (it depends on no other workspace package).
COPY package.json package-lock.json ./
COPY packages/relay/package.json ./packages/relay/package.json
RUN npm ci --workspace @pane/relay --include-workspace-root

COPY packages/relay/prisma ./packages/relay/prisma
RUN npm run generate --workspace @pane/relay

COPY packages/relay/tsconfig.json packages/relay/tsconfig.client.json ./packages/relay/
COPY packages/relay/src ./packages/relay/src
RUN npm run build --workspace @pane/relay

# ---------- stage 2: runtime ----------
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# Default to an in-container SQLite path; users can override with -e DATABASE_URL.
ENV DATABASE_URL=file:/app/data/pane.db

# Prod deps only.
COPY package.json package-lock.json ./
COPY packages/relay/package.json ./packages/relay/package.json
RUN npm ci --omit=dev --workspace @pane/relay --include-workspace-root

# Generated client + migrations + compiled JS.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/packages/relay/dist ./packages/relay/dist
COPY packages/relay/prisma ./packages/relay/prisma

WORKDIR /app/packages/relay
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000

# Apply migrations on every boot (idempotent), then start the relay.
# `prisma` is a runtime dependency (see packages/relay/package.json), so it is
# present in node_modules after `npm ci --omit=dev` — `npx` resolves the local
# binary instead of downloading it on every boot.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
