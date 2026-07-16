<!-- standards-version: 1.10.0 -->

# Roadmap

**Current:** v0.1.2 (published to npm)

Direction: stay the *safe, structured window into Tailscale* — dry-run defaults, explicit opt-in for anything dangerous, structured errors with remedies. Every new tool is judged against that bar before it ships.

Informed by [docs/research/Tailscale MCP Landscape Research.md](docs/research/Tailscale%20MCP%20Landscape%20Research.md) (July 2026). Two findings anchor the plan: the competitive field splits into local-only CLI wrappers and Admin-API-only enterprise engines — **nobody bridges both**; and **no server offers stateful dry-run pre-flights** (ACL validate/preview) even though that's exactly what agents need. Both gaps are this project's identity.

## v0.1.x — Foundation (shipped)

- [x] `TailscaleProvider` interface + `CliProvider` (injectable process runner, offline fixture-driven tests)
- [x] Error taxonomy with remedies (`BINARY_NOT_FOUND`, `DAEMON_NOT_RUNNING`, `NEEDS_LOGIN`, `SERVE_NOT_ENABLED`, `CLI_ERROR`)
- [x] Tool surface: `tailnet_status`, `generate_ssh_config`, `share_port`, `share_status`, `stop_share`, `ping_all`
- [x] stdio transport
- [x] CI/CD: build+test matrix (Node 20/22), tag-and-release, npm publish with provenance
- [x] GitHub Pages documentation site, community files, issue/PR templates, security policy

## v0.2.0 — Annotations + local surface expansion

No new credentials, no new trust boundary. Highest value-per-effort items first.

- [ ] **Tool annotations on every tool** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`). The spec treats unannotated tools as destructive/non-idempotent, and Claude Code uses `readOnlyHint` as a concurrency signal — today our read-only tools are being serialized and over-confirmed for no reason. Cheap, immediate, ships first.
- [ ] **LocalAPI provider — narrow scope**: `/localapi/v0/status` and `/localapi/v0/whois` only. These are the two high-stability endpoints (the CLI and GUIs depend on them); the LocalAPI as a whole is officially unstable, so `CliProvider` remains the default for everything else and the fallback for these. Platform IPC handled natively: Unix socket (Linux), ACL'd named pipe (Windows), sameuserproof (macOS).
- [ ] **`whois` tool** — resolve a tailnet IP to node + user identity ("who is hitting my shared port"); also the building block for identity-gated tools in v0.4
- [ ] **`exit_node` tools** — list advertised exit nodes; set/clear the active exit node (mutating: structured before/after state in the response)
- [ ] **`netcheck`** — DERP region latency, preferred relay, NAT detail; complements `ping_all` for "why is this path relayed"
- [ ] **`dns_status`** — MagicDNS config, resolvers, search domains
- [ ] Serve improvements: TCP forwarding mode, multiple simultaneous shares, `share_port` idempotency (re-share same port updates instead of erroring)
- [ ] Taildrop `send_file` via CLI (`tailscale file cp`); receive deferred — the `file-put` LocalAPI path is medium-stability and sandbox-entangled

## v0.3.0 — Admin API bridge (opt-in)

A new trust boundary: the Admin API needs OAuth client credentials. Everything here is **off unless credentials are provided via env** (`TS_API_CLIENT_ID`/`TS_API_CLIENT_SECRET`), scoped least-privilege, never logged or echoed. This is the "unified local + Admin API" gap no competitor fills.

- [ ] **`AdminApiProvider`** with documented least-privilege scope recipes per use case (read-only monitoring: `devices:core:read` + `dns:read`; GitOps validation: `policy_file:read`; provisioning: `auth_keys` with tag-locked OAuth client)
- [ ] Rate-limit resilience: honor `429`/`Retry-After` with exponential backoff + jitter; `TAILSCALE_MAX_CONCURRENT` cap
- [ ] Device management tools: list all tailnet devices (not just peers), authorize, rename, set tags, key-expiry status
- [ ] **ACL dry-run pre-flight tools** — `acl_validate` / `acl_preview`: review a proposed policy change and see which connections it would affect, *before* any human applies it. No server in the landscape offers this; it is the flagship v0.3 feature. Still no blind ACL writes — ever.
- [ ] Scoped auth-key creation (ephemeral, preauthorized, tag-inheriting via tag-locked OAuth client)
- [ ] Permission tiers via env: `TAILSCALE_MCP_READONLY=1`, `TAILSCALE_MCP_ALLOW_FUNNEL=0`, risk-level gate checked before every mutating tool

## v0.4.0 — Agentic ergonomics + identity-gated execution

- [ ] **Capability-grant authorization**: resolve the caller's identity via `whois` and check application capability grants in the tailnet ACL policy before executing privileged tools — the published mitigation for the confused-deputy problem (unprivileged user driving a privileged agent)
- [ ] MCP **resources**: `tailnet://status`, `tailnet://peers/<hostname>` (Claude Desktop and Claude Code both render these fully)
- [ ] MCP **prompts**: canned workflows ("diagnose connectivity to <node>", "share this dev server with the team")
- [ ] Progress notifications for long ops (`ping_all` over large tailnets) — Claude Code renders text tickers; other clients ignore them, so this is progressive enhancement only

## v1.0.0 — Stable + distribution

- [ ] Full test coverage incl. Windows + macOS CI runners (named pipe vs unix socket vs sameuserproof paths)
- [ ] Integration-test harness: fixture capture tooling against a real tailnet, sanitizer included
- [ ] Complete docs site: per-tool reference, security model page, provider architecture
- [ ] Semver commitment; documented tool-schema stability policy
- [ ] **Distribution beyond npm**: signed Docker image with SBOM (Docker MCP Catalog requirement), Smithery listing, mcp.so, standalone binaries for Windows/macOS/Linux, one-click configs for Claude Desktop / Claude Code / Cursor

## Deliberately skipped or deferred

- **Streamable HTTP transport** — deferred. Claude Desktop and Cursor don't support it (stdio remains the universal transport); `jaxxstorm/tailscale-mcp-proxy` already bridges stdio→HTTP for those who need remote deployment. Revisit when client support lands (also a Smithery hosting prerequisite).
- **OAuth authorization-server metadata / PRM discovery** — wait; mainstream clients don't render these flows yet.
- **Elicitation** — no meaningful client support.
- **Custom dashboards/visualization** — out of lane; effort belongs in the tool execution plane.

## Explicitly out of scope

- Handling `TS_AUTHKEY` or any node credential — the daemon owns auth
- ACL **writes** — validate/preview only; too much blast radius for an agent tool
- Anything that silently widens exposure (Funnel stays opt-in with warnings, forever)
- Competing on tool count (one competitor ships 89+ Admin API tools) — the differentiator is safety architecture, not surface area
