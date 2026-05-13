# syntax=docker/dockerfile:1
# Pane v1: single-container deploy. SQLite by default; mount /app/data for persistence.
# Slim (Debian/glibc) image because Prisma's default `binaryTargets` ship a glibc
# build for `debian-openssl-3.0.x`. Alpine works but needs an extra binary target.

# ---------- stage 1: build ----------
FROM node:20-slim AS build
WORKDIR /app

# Install deps (incl. dev) to compile + generate the Prisma client.
COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---------- stage 2: runtime ----------
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
# Default to an in-container SQLite path; users can override with -e DATABASE_URL.
ENV DATABASE_URL=file:/app/data/pane.db

# Prod deps only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Generated client + migrations + compiled JS.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000

# Apply migrations on every boot (idempotent), then start the relay.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
