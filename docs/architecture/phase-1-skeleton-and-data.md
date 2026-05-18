# Phase 1: Skeleton + data layer

## Scope

In:
- The TypeScript project skeleton: `package.json`, `tsconfig.json`, ESM, dev/build/test scripts.
- The data layer: `prisma/schema.prisma` with the four models (`Agent`, `Session`, `Participant`, `Event`), the first migration, the generated client.
- `src/keys.ts`: pure functions for API-key + token generation, hashing, prefixing.
- `src/config.ts`: env parsing + validation.
- `src/db.ts`: the `PrismaClient` singleton.
- `src/bootstrap.ts`: on boot, reconcile the `agents` table with the `API_KEY` env var.
- `src/index.ts`: the entrypoint. Load config, run migrations (in prod), run bootstrap, start an HTTP server with just `GET /healthz`.

Out:
- Any real endpoint (phase 2).
- The `/s/*` human-facing routes, the iframe, CSP (phase 3).
- The MCP server, the Dockerfile (phase 4).

## Architecture

### Runtime, language, build

- **Node 20+** baseline. Keep Bun working: ESM only (`"type": "module"`), `node:`-prefixed core imports, no APIs Bun lacks.
- **Dev**: `tsx watch src/index.ts` (fast, no build step). **DECIDED**: `tsx`, not `ts-node`.
- **Build**: `tsc` to `dist/`, then `node dist/index.js`. This is an app, not a library. No bundler needed. **DECIDED**: `tsc`, not `tsup` / `esbuild`. Revisit only if cold-start or image size becomes a problem.
- **Test**: `vitest`. Unit tests for `keys.ts` and `config.ts`. Integration tests land in phase 2 (they need the HTTP layer).
- **Validation**: `zod` for env parsing and static request-body parsing (the shapes the relay itself defines). `ajv` for dynamic per-session event-data validation (the schemas the agent ships at session-create time). **DECIDED**: two libs, distinct purposes.

### Package layout

```
pane/
  package.json
  tsconfig.json
  .dockerignore                # phase 4
  Dockerfile                   # phase 4
  prisma/
    schema.prisma
    migrations/                # committed
  src/
    index.ts                   # entrypoint: config -> migrate(prod) -> bootstrap -> http+ws server
    config.ts                  # zod schema over process.env, exported singleton
    db.ts                      # PrismaClient singleton (avoids connection churn in dev/HMR)
    keys.ts                    # generateApiKey / generateToken / hashKey / keyPrefix; pure, only node:crypto
    bootstrap.ts               # reconcile agents table with API_KEY env
    log.ts                     # tiny leveled logger (or pino; lean: tiny hand-rolled)
    http/                      # phase 2: app.ts, auth.ts, routes/*, errors.ts, broadcast.ts, validation.ts
    ws/                        # phase 2: handler.ts (WebSocket lifecycle, replay-on-connect)
    bridge/                    # phase 3: shell.ts, content.ts, shim.ts
    mcp/                       # phase 4: server.ts
  docs/
```

`src/mcp/server.ts` is just a second entrypoint in the same package (a `bin`), not a separate package. **DECIDED**: one package for v1. (If client wrappers proliferate later, split into `packages/`; not now.)

### Config / env vars

`src/config.ts` parses `process.env` through a `zod` schema, throws on boot if something required is missing or malformed, and exports the parsed object. The full v1 set:

| Var | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | no | `file:./data/pane.db` | SQLite path (self-host). A `postgresql://...` URL for the hosted build (and then `provider` in `schema.prisma` must be `postgresql`. A build-time choice; see SPEC's Prisma note). |
| `PORT` | no | `3000` | HTTP listen port. |
| `PUBLIC_URL` | no (dev) | `http://localhost:${PORT}` | Base URL the relay is reachable at. Used to build session URLs (`${PUBLIC_URL}/s/${human_token}`). In any real deployment this MUST be set to the externally-reachable URL. |
| `API_KEY` | no | (none) | If set: bootstrap a `default` agent with this key (idempotent). See bootstrap below. |
| `REGISTRATION_MODE` | no | `closed` | Controls `POST /v1/register`: `closed` (default) → 404; `secret` → requires a bearer `REGISTRATION_SECRET`; `open` → public self-service. |
| `REGISTRATION_SECRET` | when `REGISTRATION_MODE=secret` | (none) | Shared bearer secret callers must present in `secret` mode; ignored otherwise. |
| `REGISTER_RATE_LIMIT` | no | `5` | Per-IP request cap on the `POST /v1/register` endpoint within the rate window (enforced in `secret` and `open` modes). `0` disables the limiter. |
| `REGISTER_RATE_WINDOW_SECONDS` | no | `3600` | Sliding-window length for `REGISTER_RATE_LIMIT`. |
| `MAX_ARTIFACT_BYTES` | no | `2_000_000` | Cap on `artifact.source` of `POST /v1/sessions`. |
| `MAX_EVENT_DATA_BYTES` | no | `65_536` | Cap on a single event's serialized `data`. |
| `MAX_PARTICIPANTS_PER_SESSION` | no | `32` | Cap on `participants.humans` in `POST /v1/sessions`. |
| `DEFAULT_TTL_SECONDS` | no | `3600` | Default session TTL. |
| `MAX_TTL_SECONDS` | no | `86_400` | Hard ceiling on requested TTL. |
| `TTL_SWEEP_SECONDS` | no | `60` | Sweeper interval (phase 4). `0` disables the in-process sweeper. |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error`. |

No secrets ever get logged. `config.ts` redacts `API_KEY` / `PANE_SECRET_KEY` / `DATABASE_URL` creds in any startup log line.

### Prisma schema

```prisma
// prisma/schema.prisma
// provider = "sqlite" for the self-host/default build; "postgresql" for the hosted build (build-time switch).

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

model Agent {
  id         String    @id @default(cuid())
  name       String                              // human label: "telegram-bot", "cv-maker"
  keyHash    String    @unique                   // sha256(full key); raw key never stored
  keyPrefix  String                              // first ~10 chars, "pane_a1b2c3"; display only
  createdAt  DateTime  @default(now())
  lastUsedAt DateTime?                           // bumped (fire-and-forget) on each authed request
  revokedAt  DateTime?                           // non-null = revoked; agents are never hard-deleted
  rateLimit  Int?                                // optional per-key session-create cap; null = unlimited
  sessions   Session[]

  @@index([keyHash])
}

model Session {
  id              String         @id              // cuid. The agent uses this in URLs; not the secret token.
  agentId         String
  agent           Agent          @relation(fields: [agentId], references: [id])

  // Artifact: the HTML/JS the agent wants rendered.
  artifactType    String                          // "html-inline" | "html-ref"
  artifactSource  String                          // TEXT (inline) or URL (ref); capped MAX_ARTIFACT_BYTES at the API
  artifactVersion Int            @default(1)      // bumps on PATCH

  // Schema: the per-session event vocabulary.
  eventSchema     Json                            // { events: { "<type>": { payload: <JSON Schema>, emittedBy: [...] } } }
  schemaVersion   Int            @default(1)      // bumps on additive PATCH

  status          String         @default("open") // "open" | "closed"
  createdAt       DateTime       @default(now())
  expiresAt       DateTime
  metadata        Json?

  // Webhook callback (best-effort, signed; durable delivery is /ee/).
  callbackUrl         String?
  callbackSecretEnc   String?                     // encrypted-at-rest copy of the shared HMAC secret (see phase 2)
  callbackFilter      Json?                       // array of event type patterns, e.g. ["review.*"]

  participants    Participant[]
  events          Event[]

  @@index([agentId])
  @@index([expiresAt])                            // for the TTL sweeper
}

model Participant {
  id           String   @id @default(cuid())
  sessionId    String
  session      Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  kind         String                             // "human" | "agent"
  identityId   String                             // the value that ends up in event.author.id
  tokenHash    String   @unique                   // sha256 of the auth token; raw token never stored
  tokenPrefix  String                             // display only
  joinedAt     DateTime?                          // stamped on first connect
  revokedAt    DateTime?

  @@index([sessionId])
  @@index([tokenHash])
}

model Event {
  id              BigInt   @id @default(autoincrement())   // BIGINT; doubles as the opaque poll cursor
  sessionId       String
  session         Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  authorKind      String                                  // "human" | "agent" | "system"
  authorId        String                                  // participant.identityId, or "system"
  type            String                                  // matches a key in session.eventSchema.events
  data            Json
  causationId     String?                                 // event id this one was a response to; metadata only
  idempotencyKey  String?                                 // set by the writer; for retry-safe writes
  ts              DateTime @default(now())

  @@index([sessionId, id])                                // ?since=N => WHERE sessionId=? AND id>? ORDER BY id
  @@unique([sessionId, authorId, idempotencyKey])         // dedup; NULL != NULL, so unkeyed writes coexist
}
```

Notes / gotchas:

- **`BigInt` + JSON.** Prisma returns `Event.id` as a JS `BigInt`, which `JSON.stringify` throws on. The API layer (phase 2) must convert `id` to a `string` before serializing. The `?since=` cursor is a string in the API (opaque), so the wire type is always string.
- **`BigInt` on SQLite.** SQLite integers are 64-bit, so `BigInt` autoincrement works there; on Postgres it maps to `BIGSERIAL`. No behavior difference for v1.
- **`Json` on SQLite.** Prisma supports `Json` on SQLite (recent versions); stored as TEXT. **VERIFY** at implementation time against the pinned version; fallback to `String` + a `JSON.parse / JSON.stringify` wrapper if the version doesn't support it. Don't block on it; have the fallback ready.
- **`cuid()` for the non-secret IDs** (`Agent.id`, `Session.id`, `Participant.id`). The auth-bearing values are the api_key (per agent) and the participant token (per identity); both are full-entropy random and live only as `sha256(...)` in the DB.
- **Idempotency uniqueness.** In SQLite and Postgres, `NULL != NULL` for unique-constraint purposes, so multiple rows with `idempotencyKey = NULL` coexist (the dedup fires only when the writer provides a key). Correct.
- **`causationId` is not a foreign key.** Metadata stamped by the writer. The referenced event might have been redacted, deleted, or never existed; the writer is responsible.

### Migrations

- Dev: `prisma migrate dev --name <desc>`. Generates SQL, applies it, regenerates the client. Commit `prisma/migrations/`.
- Prod / container: `prisma migrate deploy` runs on boot (in the Docker entrypoint, phase 4; also runnable as `npm run migrate:deploy`). `src/index.ts` does NOT run migrations itself in dev (you run `migrate dev` by hand); in prod the entrypoint script runs `migrate deploy` before `node dist/index.js`. **DECIDED**: migrations are an explicit step, not auto-run by the app process, except via the prod entrypoint script.

### Bootstrap (`src/bootstrap.ts`)

Runs once on boot, after migrations, before the server listens:

1. If `API_KEY` is set: `prisma.agent.upsert({ where: { keyHash: hashKey(API_KEY) }, create: { name: "default", keyHash: hashKey(API_KEY), keyPrefix: keyPrefix(API_KEY) }, update: {} })`. Idempotent. Restarting N times leaves exactly one `default` agent.
2. Else (no `API_KEY`): if `prisma.agent.count() === 0`, generate a fresh key, create an agent (`name: "default"`), and `log.warn` it once to stdout with an unmistakable banner: `"No API_KEY set and no agents exist. Generated one: <key>. Save it now, it will not be shown again."` Continue starting.
3. Else (no `API_KEY`, agents already exist): do nothing.

Rationale for step 2 (auto-mint rather than refuse-to-start): a `docker run pane` with no env should come up usable, the way SQLite-backed tools do. The key is printed exactly once; losing it means `docker exec` + the (phase 2) `/v1/register` path or a Prisma Studio poke. **OPEN**: confirm with Lalit that auto-mint-and-print is the behavior he wants vs. refuse-to-start-without-`API_KEY`.

### `src/keys.ts`

Pure, only `node:crypto`:

- `generateApiKey(): string` → `"pane_" + crypto.randomBytes(16).toString("hex")` (128 bits of entropy, 37-char string).
- `generateToken(): string` → `base64url(crypto.randomBytes(32))` (256 bits, ~43 chars). Used for participant tokens in phase 2.
- `hashKey(value: string): string` → `crypto.createHash("sha256").update(value).digest("hex")`.
- `keyPrefix(value: string): string` → `value.slice(0, 11)` for api keys, `value.slice(0, 8)` for tokens. Display only.

SHA-256, not bcrypt / argon2: the value is full-entropy random; there is nothing to brute-force; a fast hash is correct (same reasoning GitHub / Stripe use for token storage).

## Interfaces (what phase 1 must expose)

- `config` (default export of `src/config.ts`): a frozen object with all the vars above, types resolved (`PORT: number`, `MAX_ARTIFACT_BYTES: number`, etc.), creds redacted in `toString`.
- `prisma` (default export of `src/db.ts`): the shared `PrismaClient`.
- `generateApiKey()`, `generateToken()`, `hashKey(v)`, `keyPrefix(v)` from `src/keys.ts`.
- `runBootstrap(prisma, config): Promise<void>` from `src/bootstrap.ts`.
- `src/index.ts`: an executable that, run via `npm run dev` or `node dist/index.js`, starts a Hono app whose only route is `GET /healthz` → `200 {"status":"ok"}`.
- `package.json` scripts: `dev`, `build`, `start`, `migrate:dev`, `migrate:deploy`, `studio`, `test`, `typecheck`.

## Acceptance criteria

- `npm run dev` boots: loads + validates config (clear error if a required var is bad), runs bootstrap, listens on `PORT`. `curl localhost:3000/healthz` → `{"status":"ok"}`.
- `npm run migrate:dev` produces a clean migration. `npm run studio` shows four tables with the columns above.
- `API_KEY=foo npm run dev` started twice leaves exactly one `default` agent in the DB (idempotent upsert).
- With no `API_KEY` and an empty DB, boot prints a generated key once with the banner; a second boot does not mint another (count is now 1).
- `npm run build && npm start` works (the prod path) against a fresh `DATABASE_URL`.
- `npm run typecheck` is clean. `npm test` passes: `keys.ts` round-trip (generate → prefix is a slice of the value; hash is deterministic, 64 hex chars), `config.ts` rejects a malformed `PORT` and accepts the defaults.

## Open decisions

- **Zero-keys behavior**: auto-mint-and-print (lean) vs refuse-to-start-without-`API_KEY`. Confirm with Lalit. OPEN.
- **`Json` columns on the pinned Prisma version**: use `Json` if supported on SQLite (it should be), else `String` + a parse/stringify wrapper. Verify, have the fallback. OPEN (verification, not design).
- **Logger**: a ~20-line hand-rolled leveled logger (lean; keeps deps down) vs `pino`. OPEN, low stakes.
- Build tool (`tsc`), dev runner (`tsx`), validation libs (`zod` + `ajv`), single-package layout, explicit-migrations: all **DECIDED** above.
