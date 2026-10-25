<!-- standards-version: 1.10.0 -->

# AGENTS.md

This file tells AI coding agents how the Tailscale MCP repo works and how to contribute correctly.

## Repository overview

This is an MCP server. It contains:

- **`src/`** -- TypeScript source code (`src/index.ts` is the stdio entry point, `src/config.ts` parses env vars)
- **`src/providers/`** -- provider adapters implementing the `TailscaleProvider` interface (`types.ts`); `CliProvider` is the only one and is constructed in `src/index.ts`
- **`src/tools/`** -- the registered MCP tools (stdio transport only), registered with `registerTool` plus annotations and output schemas (`schemas.ts`)
- **`src/__tests__/`** -- vitest suites; offline, with a mocked CLI runner
- **`package.json`** -- npm package manifest (version source of truth)
- **`mcp-tools.json`** -- generated from the registered tools (`npm run gen:tools`); never edit by hand
- **`docs/`** -- documentation and GitHub Pages site
- **`CHANGELOG.md`** -- release history

## Branching and commit model

- **Single branch**: `main` only. No develop/release branches.
- **Conventional commits** are required. Use them to decide your version bump, then apply it in your PR (`npm version <patch|minor|major> --no-git-tag-version`); `release.yml` tags and publishes that version on merge, and CI never writes to `main`:
  - `feat:` or `feat(scope):` -- bump the **minor** version
  - `feat!:` or a `BREAKING CHANGE` trailer -- bump the **major** version
  - everything else (`fix:`, `chore:`, `docs:`, etc.) -- bump the **patch** version
- Commit messages should be concise and describe the "why", not the "what".

## CI/CD workflows

### `ci.yml` (runs on PR and push to main)

Runs on Node 22 and 24 (Linux), plus Node 24 on Windows and macOS:
- Typecheck of src and tests (`npm run typecheck`)
- TypeScript build (`npm run build`)
- Test suite (`npm test`, vitest, offline), which includes the `mcp-tools.json` drift check

A separate job runs `npm audit --omit=dev --audit-level=high`.

### `release.yml` (runs on push to main)

Reads the version from `package.json` and, if there is no matching tag yet, pushes the `v<version>` tag (plus the floating `vMAJOR` and `vMAJOR.MINOR` tags), creates a GitHub Release, and dispatches `publish.yml`. It only pushes tags and never writes to `main`; bump the version in your PR.

### `publish.yml` (runs on release published or workflow_dispatch)

Publishes the package to npm through trusted publishing (OIDC, no token) with provenance, using a pinned npm. It is idempotent: it skips a version that is already published.

### `drift-check.yml`

Checks this repo against the ecosystem standards for drift.

### `pages.yml` (deploys docs/ to GitHub Pages)

Deploys `docs/` on push to main.

### `stale.yml`

Weekly. Tracked issues (bug, feature, enhancement, security-hardening, P1/P2, milestones) never go stale; others go stale after 90 days, PRs after 30. See CONTRIBUTING.md.

### `label-sync.yml`

Labels PRs by changed paths (`code`, `tests`, `documentation`, `ci`). Runs on `pull_request_target` and never checks out PR code.

All `uses:` references are pinned to commit SHAs with a version comment; keep it that way when adding steps.

## Version management

- The **source of truth** for the current version is `package.json`.
- Bump it in your PR with `npm version <patch|minor|major> --no-git-tag-version` (keeps the lockfile in sync), following conventional-commit intent. The README's npm badge is dynamic, so it needs no edit.
- On merge, `release.yml` tags that version and publishes it. `main` is protected and is never written to by CI.

## Code conventions

- No hardcoded credentials -- CI scans for password/token/api_key patterns.
- Conventional commits; bump the version deliberately in your PR (CI tags and publishes it).
- `mcp-tools.json` is generated from the tools registered in `src/tools/`: run `npm run gen:tools` after changing a tool (CI fails if it is stale).

## Adding content

### New provider adapter

1. Implement the `TailscaleProvider` interface (`src/providers/types.ts`) in `src/providers/`
2. Construct it in `src/index.ts` and pass it to `registerAll`
3. Inject process/network access so tests stay offline
4. Use `feat:` commit prefix

### New tool

1. Register the tool in `src/tools/` with `server.registerTool`, including a `title`, all four annotation hints, and an `outputSchema` (in `schemas.ts`)
2. Regenerate `mcp-tools.json` with `npm run gen:tools`
3. Add vitest tests
4. Use `feat:` commit prefix

## License

CC-BY-NC-ND-4.0. All contributions fall under this license.
