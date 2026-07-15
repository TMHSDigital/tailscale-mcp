# Changelog

All notable changes to Tailscale MCP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

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
