# Publishing pane to npm

Manual checklist for cutting a release of `@pane/core` and `@pane/cli`.
The relay (`@pane/relay`) is **not** published to npm — it ships as a Docker
image / source clone. Its `package.json` has `private: true` to enforce this.

## One-time setup

1. `npm login` (account: your npm user).
2. Claim the `@pane` scope. On first publish npm will create it automatically
   for a personal scope, but for an org scope:
   ```sh
   npm org create pane
   ```
   If the name is taken, **stop and reconsider the package names** — do not
   silently rename. The CLI binary (`pane`) is independent of package names
   and stays the same regardless.

## Per-release checklist

Run from the repo root unless noted.

1. **Working tree clean, on `main`, in sync with `origin/main`.**

   ```sh
   git status      # must be clean
   git pull --ff-only origin main
   ```

2. **Bump versions** in lock-step across `@pane/core` and `@pane/cli`. Update
   the `@pane/core` dependency in `packages/cli/package.json` to match. Also
   bump the `VERSION` constant in `packages/cli/src/index.ts` (used by
   `pane --version`).

3. **Install + build + typecheck + test from clean.**

   ```sh
   rm -rf node_modules packages/*/node_modules packages/*/dist
   npm ci
   npm run build
   npm run typecheck
   npm run test
   ```

4. **Verify pack contents (no secrets, no `src/`, no tests).**

   ```sh
   ( cd packages/core && npm pack --dry-run )
   ( cd packages/cli  && npm pack --dry-run )
   ```

   Expect:
   - `@pane/core`: `dist/*.{js,d.ts}`, `LICENSE`, `README.md`, `package.json`.
   - `@pane/cli`: `dist/**/*.js`, `LICENSE`, `README.md`, `package.json`.
     The shebang on `dist/index.js` must survive (`head -1` shows
     `#!/usr/bin/env node`) and the file must be executable.

5. **Publish core first, then cli.**
   `@pane/cli` depends on `@pane/core` from the registry, not the workspace,
   so order matters.

   ```sh
   npm publish --workspace @pane/core   --access public
   npm publish --workspace @pane/cli    --access public
   ```

   For a dry rehearsal, add `--dry-run`.

6. **Smoke test from a clean directory.**

   ```sh
   cd /tmp && mkdir pane-smoke && cd pane-smoke
   npx @pane/cli@latest --version
   npx @pane/cli@latest --help
   ```

7. **Tag and push.**

   ```sh
   git tag v<X.Y.Z>
   git push origin main --tags
   ```

8. **Create a GitHub release** from the tag with a short changelog.

## Notes

- The relay is intentionally not published. To run a relay, use the Docker
  image or clone the repo. See `packages/relay/README.md`.
- Provenance (`--provenance`) requires publishing from GitHub Actions with
  `id-token: write`. Not configured yet — add this when there's a CI publish
  workflow.
- `@pane/core` is Node-only today (uses `ws`, not the browser `WebSocket`).
  Don't advertise it as isomorphic until that changes.
