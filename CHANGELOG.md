# Changelog

All notable changes to Tailscale MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.1.4] - 2026-10-25

### Fixed

- `generate_ssh_config` no longer deletes user content when the managed markers in `~/.ssh/config` are orphaned, reversed, or duplicated. It returns `SSH_CONFIG_MARKERS_CORRUPT` and writes nothing (#31)
- `Host` aliases are the MagicDNS label (sanitized hostname fallback): always one SSH-safe token, with collisions suffixed and reported under `renamed`. Mullvad exit nodes and sharee nodes are skipped and reported under `skipped` (#32)
- ssh-config writes are atomic, keep a `config.tailscale-mcp.bak` backup, create files `0600`, keep existing modes, write through symlinks, and refuse to overwrite a config that can't be read (`SSH_CONFIG_UNREADABLE`) (#42)
- The macOS app-bundle CLI and Homebrew prefixes are found when `tailscale` is not on `PATH` (#53)
- Access denied from Serve/Funnel maps to `PERMISSION_DENIED` with the Linux operator remedy (#54)
- `stop_share` can remove a share mounted at a path, and mount paths are validated (#55)
- Test files are typechecked, and CI runs `npm run typecheck` (#35)

### Added

- `TAILSCALE_MCP_BIN` env var to point the server at a specific `tailscale` binary
- `generate_ssh_config` `includeShared` input, and `stop_share` `path` input
- `sharee` flag on nodes in `tailnet_status`

### Changed

- `stop_share` with `httpsPort`/`path` reports `stopped` as `{httpsPort, path}` instead of the bare port number

## [0.1.3] - 2026-10-25

### Changed

- `@modelcontextprotocol/sdk` bumped from 1.29.0 to 1.32.1
- npm publishing uses trusted publishing (OIDC) instead of a long-lived `NPM_TOKEN`
- Line endings normalized to LF via `.gitattributes`

## [0.1.2] - 2026-07-14

### Changed

- README badges: dynamic npm version badge and CI status badge (the version badge was hardcoded to 0.1.0)
- SECURITY.md now directs reports to GitHub private vulnerability reporting instead of a placeholder email
- PR auto-labeling matches this repo's paths (`src/`, tests) instead of inherited `skills/`/`rules/` paths

### Added

- Issue templates (bug report, feature request) and a pull request template

## [0.1.1] - 2026-07-14

First published release: everything listed under 0.1.0 below ships in this version. (The v0.1.0 tag was consumed by the initial scaffold before the tool surface landed, so the first npm publish is 0.1.1.)

## [0.1.0] - Unreleased

### Added

- `TailscaleProvider` interface and `CliProvider` (spawns the `tailscale` binary, PATH resolution with Windows fallback to the default install location, injectable process runner for offline tests)
- Error taxonomy with actionable remedies: `BINARY_NOT_FOUND`, `DAEMON_NOT_RUNNING`, `NEEDS_LOGIN`, `SERVE_NOT_ENABLED`, `CLI_ERROR`
- `generate_ssh_config` MCP tool: dry-run by default; dedicated-file write (`~/.ssh/tailscale_dev_config`) with returned `Include` instructions; optional direct `~/.ssh/config` editing that is idempotent between `# BEGIN/END tailscale-mcp` markers and never touches content outside them
- `share_port`, `share_status`, `stop_share` MCP tools: Serve/Funnel wrapper defaulting to tailnet-only Serve; `public: true` (Funnel, open internet) requires explicit opt-in and the tool description warns about exposure; structured `SERVE_NOT_ENABLED` error with the enablement remedy
- `ping_all` MCP tool: concurrent latency matrix over peers (bounded concurrency of 5, per-ping timeout) reporting direct vs DERP-relay paths or unreachable
- `tailnet_status` MCP tool: trimmed self + peers view (hostname, MagicDNS name, IPv4/IPv6, OS, online, last seen, exit-node flags, tags) with optional `onlineOnly` filter
- MCP server entrypoint over stdio; package renamed to `@tmhs/tailscale-mcp`
- Sanitized fixtures captured from a real tailnet (status running/stopped/needs-login, version)
- README: install, per-tool usage with example outputs, agentic-workflow example, Funnel security notes
- Initial project scaffold
- CI/CD workflows (ci, release, publish, drift-check, pages, stale, label-sync)
- GitHub Pages documentation site
