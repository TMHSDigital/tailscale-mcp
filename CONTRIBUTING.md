# Contributing to Tailscale MCP

Thank you for your interest in contributing.

## Getting Started

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes following the conventions below
4. Submit a pull request

## Conventions

### Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` -- new feature, provider adapter, or tool
- `fix:` -- bug fix
- `docs:` -- documentation changes
- `chore:` -- maintenance, dependency updates
- `refactor:` -- code restructuring

### Provider adapters

- Implement the `TailscaleProvider` interface (`src/providers/types.ts`) in `src/providers/`
- Wire it up in `src/index.ts`, where the provider is constructed and handed to `registerAll`. `CliProvider` is the only implementation today.
- Inject process or network access (as `CliProvider` does with its `runner` option) so tests stay offline

### Tools

- Register the tool in `src/tools/`
- Regenerate `mcp-tools.json` with `npm run gen:tools` (never edit it by hand; CI fails if it is stale)
- Add vitest tests

Bump the version in `package.json` in your PR (e.g. `npm version <patch|minor|major> --no-git-tag-version`); CI tags and publishes it on merge.

## Local development & debugging

```bash
npm install
npm run typecheck && npm run build && npm test
```

The tests never touch a real tailnet. To exercise your build against your own tailnet, open it in the MCP Inspector and call tools from its UI:

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

Or point an MCP client at your checkout instead of the npm package:

```json
{ "mcpServers": { "tailscale-dev": { "command": "node", "args": ["/path/to/tailscale-mcp/dist/index.js"] } } }
```

Logs go to stderr (stdout is the MCP channel). The environment variables in the README's configuration reference work the same way here, e.g. `TAILSCALE_MCP_READONLY=1` while experimenting.

## Pull Request Process

1. Ensure CI passes (`npm run typecheck`, `npm run build`, `npm test`)
2. Update `CHANGELOG.md` if the change is user-facing
3. Use a descriptive PR title following conventional commit format

## Issue triage

The issue tracker is the roadmap's record, so tracked work is never closed by a bot. `stale.yml` runs weekly with these rules:

- **Exempt from staleness:** issues labeled `bug`, `feature`, `enhancement`, `security-hardening`, `priority: P1`, `priority: P2`, `help wanted`, or `good first issue`, and any issue in a milestone.
- **Other issues** (typically questions waiting for a reply) are marked `stale` after 90 days without activity and closed 14 days later. Any comment resets the clock.
- **Pull requests** are marked stale after 30 days and closed 7 days later, except those labeled `security-hardening` or `dependencies`.

## Inbound license grant and DCO

This project's outbound license is CC-BY-NC-ND-4.0. Contributions are accepted inbound under a broader grant via the Developer Certificate of Origin (DCO). Both pieces are required because CC-BY-NC-ND-4.0 alone cannot cleanly accept third-party derivatives.

### Required grant

By submitting a contribution to this repository, you certify that you have the right to do so under the Developer Certificate of Origin (DCO) 1.1, and you grant TMHSDigital a perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use, reproduce, prepare derivative works of, publicly display, publicly perform, sublicense, and distribute your contribution under the project's current license (CC-BY-NC-ND-4.0) or any successor license chosen by the project.

### DCO sign-off

Every commit in a pull request must carry a `Signed-off-by:` trailer matching the commit author. Sign at commit time with the `-s` flag:

```bash
git commit -s -m "feat: add new tool"
```

This appends a line like `Signed-off-by: Jane Developer <jane@example.com>` to the commit message. The GitHub DCO App enforces this on every PR.

For the full inbound/outbound model and rationale, see [`standards/licensing.md`](https://github.com/TMHSDigital/Developer-Tools-Directory/blob/main/standards/licensing.md) in the Developer-Tools-Directory meta-repo.
