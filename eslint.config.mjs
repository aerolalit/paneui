// ESLint 9 flat config for the pane monorepo.
//
// Scope: packages/*/src/**/*.ts. Rule set is the plain (non-type-checked)
// typescript-eslint `recommended` set — pragmatic and fast, kept for
// consistency rather than to rewrite the existing (already-good) code.
// eslint-config-prettier is applied last to disable stylistic rules that
// would fight Prettier.

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // Global ignores — generated output, deps, Prisma artifacts, build dirs.
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.prisma/**",
      "**/generated/**",
      "packages/relay/prisma/migrations/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/coverage/**",
      "**/*.config.js",
      "**/*.config.mjs",
      "**/*.config.ts",
    ],
  },

  // Base recommended sets, scoped to the linted source + test trees.
  {
    files: ["packages/*/src/**/*.ts", "packages/*/test/**/*.ts"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // Relay browser-side client code: DOM globals (window, document,
  // WebSocket). typescript-eslint leaves no-undef off, but provide the
  // browser globals anyway so any future plain-JS rule behaves correctly.
  {
    files: [
      "packages/relay/src/bridge/client/**/*.ts",
      "packages/relay/test/browser/**/*.ts",
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },

  // Test files: allow `any` and non-null assertions — test fixtures and
  // mocks legitimately need both, and forcing precision there is noise.
  {
    files: [
      "**/*.test.ts",
      "**/*.e2e.test.ts",
      "**/*.integration.test.ts",
      "**/*.pwspec.ts",
      "**/test/**/*.ts",
      "**/test-helpers/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // Disable stylistic rules that conflict with Prettier — must be last.
  eslintConfigPrettier,
);
