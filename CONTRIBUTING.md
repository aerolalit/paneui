# Contributing to Pane

Thanks for your interest in contributing. Pane is an early-stage, pre-1.0 project — issues, fixes, and design feedback are all welcome.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Repository layout

Pane is an npm-workspaces monorepo with three packages:

- **`packages/core`** (`@paneui/core`) — framework-free HTTP + WebSocket client library.
- **`packages/relay`** (`@paneui/relay`) — the relay server (Hono + Prisma, SQLite by default).
- **`packages/cli`** (`@paneui/cli`) — the `pane` command-line tool.

## Development setup

Requires **Node 20+**.

```sh
# Install all workspace dependencies from the repo root.
npm install
```

The relay uses Prisma and needs a generated client. The relay's `pre*` scripts
generate it automatically, but you can also run it explicitly:

```sh
npm run generate            # generates the Prisma client for the relay
```

Common root-level scripts:

```sh
npm run build               # build @paneui/core, @paneui/relay, and @paneui/cli
npm run typecheck           # type-check every workspace
npm test                    # run all test suites
npm run dev                 # run the relay in watch mode
```

## Running the tests

Tests live in the workspaces. From the repo root:

```sh
npm test                    # all suites across all workspaces
npm run test:unit           # unit tests only (excludes e2e/integration)
npm run test:e2e            # relay end-to-end + integration tests
```

Inside `packages/relay` you can also run individual suites:

```sh
npm run test:unit           # vitest, excludes *.e2e.test.ts / *.integration.test.ts
npm run test:e2e            # vitest, only *.e2e.test.ts / *.integration.test.ts
npm run test:browser        # Playwright browser tests
```

Before opening a PR, please make sure `npm run build`, `npm run typecheck`, and
`npm test` all pass.

## Filing a pull request

1. Fork the repo and create a topic branch (e.g. `fix/ws-reconnect`, `feat/sse-transport`, `docs/oss-readiness`).
2. Make your change with focused, reviewable commits.
3. Ensure build, typecheck, and tests pass.
4. Open a PR against `main` with a clear description of *what* changed and *why*. Link any related issue.
5. Keep PRs small where possible — one logical change per PR is easier to review.

## Commit message conventions

Commits follow the [Conventional Commits](https://www.conventionalcommits.org/) style,
matching the existing history:

```
<type>(<scope>): <summary>
```

Examples: `fix(relay): auto-select Prisma schema by DATABASE_URL`,
`feat(cli): add pane session watch`, `docs: add SECURITY.md`. Common types are `feat`,
`fix`, `docs`, `chore`, `refactor`, `test`. The scope (`relay`, `cli`, `core`) is
optional but encouraged.

**Do not include AI-assistant trailers in commits.** Commit messages must not
contain `Co-Authored-By:` lines for AI assistants, nor `Generated with ...`
attribution lines. Keep authorship to the humans who made the change.

## Questions

Open a GitHub issue for bugs, feature ideas, or design discussion. For security
issues, see [SECURITY.md](SECURITY.md) instead — do not file those publicly.
