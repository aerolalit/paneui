// Single source of truth for the CLI version string.
//
// - `pane --version` prints this verbatim.
// - Every PaneClient construction passes it as `cliVersion`, which panes
//   as the `x-pane-cli-version` header on every relay request — drives the
//   relay's version-skew check (HTTP 426 `cli_upgrade_required`).
//
// Keep this in lockstep with packages/cli/package.json's `version` field;
// they're consulted in different places (here for the runtime header,
// package.json for npm publish + dependency resolution).
export const VERSION = "0.0.27";
