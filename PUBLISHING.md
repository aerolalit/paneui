# Publishing pane to npm

Releases of `@paneui/core` and `@paneui/cli` are cut by pushing a `v*` tag. The
`.github/workflows/release.yml` workflow does the actual `npm publish`, with
provenance attestations, so a release is always traceable to the exact commit
and workflow run.

`@paneui/relay` is **not** published — it ships as Docker / source clone. Its
`package.json` is `private: true` to enforce this.

## One-time setup

1. **Own the `@paneui` scope on npm.** The scope is already claimed; the
   only login the local machine needs is for any manual fallback publish:

   ```sh
   npm login
   ```

   (CI uses an automation token — see step 3 — so npm login on your machine
   is not required for the tag-triggered publish path.)

2. **Create an npm automation token** with publish rights on the `@paneui`
   scope. From <https://www.npmjs.com/> → Account → Access Tokens →
   "Generate New Token" → type **Automation**.

3. **Add the token to GitHub Actions secrets:**
   ```sh
   gh secret set NPM_TOKEN --repo aerolalit/paneui
   # paste the token when prompted
   ```

## Per-release checklist

1. **Working tree clean, on `main`, in sync with `origin/main`.**

   ```sh
   git status
   git pull --ff-only origin main
   ```

2. **Bump versions in lock-step.** All three of these must match:
   - `packages/core/package.json` — `version`
   - `packages/cli/package.json` — `version` AND `dependencies["@paneui/core"]`
   - `packages/cli/src/index.ts` — the `VERSION` constant (used by `pane --version`)

   Also bump for consistency:
   - `package.json` (root) — `version`
   - `packages/relay/package.json` — `version`

3. **Refresh `package-lock.json` so it reflects the bumped dependency:**

   ```sh
   npm install
   ```

4. **Smoke-check the pack contents locally** (optional but cheap):

   ```sh
   ( cd packages/core && npm pack --dry-run )
   ( cd packages/cli  && npm pack --dry-run )
   ```

   Expect `dist/`, `LICENSE`, `README.md`, `package.json` — no `src/`, no
   tests, no buildinfo. The CLI's `dist/index.js` must start with
   `#!/usr/bin/env node` and have the exec bit set.

5. **Commit, tag, push.**

   ```sh
   git add -A
   git commit -m "release: vX.Y.Z"
   git tag vX.Y.Z
   git push origin main --tags
   ```

6. **Watch the workflow.**

   ```sh
   gh run watch --repo aerolalit/paneui
   ```

   On success, both packages are live on npm with provenance attached
   (visible on each package's npm page).

7. **Smoke test the published packages** from a clean directory:

   ```sh
   cd /tmp && mkdir pane-smoke && cd pane-smoke
   npx @paneui/cli@latest --version
   npx @paneui/cli@latest --help
   ```

8. **Create a GitHub release** from the tag with a short changelog
   (`gh release create vX.Y.Z --generate-notes` is the easy path).

## Manual fallback

If CI is broken and a release can't wait, you can publish manually from a
clean checkout of the tagged commit:

```sh
git checkout vX.Y.Z
rm -rf node_modules packages/*/node_modules packages/*/dist
npm ci
npm run build
npm run test:unit

npm publish --workspace @paneui/core --access public
npm publish --workspace @paneui/cli  --access public
```

Manual publishes do **not** carry provenance. Use only as a fallback.

## Notes

- The relay is intentionally not published. To run a relay, use the Docker
  image or clone the repo. See `packages/relay/README.md`.
- `@paneui/core` is Node-only today (uses `ws`, not the browser `WebSocket`).
  Don't advertise it as isomorphic until that changes.
- Order matters even in CI: `@paneui/core` publishes before `@paneui/cli`,
  because `@paneui/cli`'s registry-resolved dependency on `@paneui/core` would
  otherwise 404.
