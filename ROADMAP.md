<!-- standards-version: 1.10.0 -->

# Roadmap

**Current:** v0.1.2 (published to npm)

Direction: stay the *safe, structured window into Tailscale* — dry-run defaults, explicit opt-in for anything dangerous, structured errors with remedies. Every new tool is judged against that bar before it ships.

Informed by [docs/research/Tailscale MCP Landscape Research.md](docs/research/Tailscale%20MCP%20Landscape%20Research.md) (July 2026). Two findings anchor the plan: the competitive field splits into local-only CLI wrappers and Admin-API-only enterprise engines — **nobody bridges both**; and **no server offers stateful dry-run pre-flights** (ACL validate/preview) even though that's exactly what agents need. Both gaps are this project's identity.

## Operating decisions

- **Primary audience:** solo developers and homelab operators driving agents from Claude Code / Claude Desktop / Cursor against a personal tailnet. Local-first ordering follows from this; tailnet-wide (Admin API) features come after the local surface is deep, and enterprise ergonomics are welcome but never jump the queue.
- **Release cadence:** incremental. Each feature ships as its own minor/patch release the moment it's green (publish is automated); milestones below are *release trains*, not big-bang drops. The first item in a train cuts `x.y.0`; the rest follow as `x.y.z`.
- **Timeframes:** sequence and dependencies only, no dates.
- **License:** stays CC-BY-NC-ND-4.0. Registry submissions (v1.0) get checked against each catalog's licensing requirements before effort is spent; contribution terms are covered in CONTRIBUTING.md.

## v0.1.x — Foundation (shipped)

- [x] `TailscaleProvider` interface + `CliProvider` (injectable process runner, offline fixture-driven tests)
- [x] Error taxonomy with remedies (`BINARY_NOT_FOUND`, `DAEMON_NOT_RUNNING`, `NEEDS_LOGIN`, `SERVE_NOT_ENABLED`, `CLI_ERROR`)
- [x] Tool surface: `tailnet_status`, `generate_ssh_config`, `share_port`, `share_status`, `stop_share`, `ping_all`
- [x] stdio transport
- [x] CI/CD: build+test matrix (Node 20/22), tag-and-release, npm publish with provenance
- [x] GitHub Pages documentation site, community files, issue/PR templates, security policy

## v0.2.x — Annotations + local surface depth

No new credentials, no new trust boundary. Ordered by value-per-effort.

- [ ] **0.2.0 — Tool annotations on every tool** (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`).
  The spec treats unannotated tools as destructive/non-idempotent, and Claude Code uses `readOnlyHint` as a concurrency signal — today our read-only tools are serialized and over-confirmed for no reason.
  *Done when:* all tools annotated (`tailnet_status`/`share_status`/`ping_all` read-only; `stop_share` destructive+idempotent; `share_port` non-read-only+open-world when `public`); `mcp-tools.json` reflects annotations; README documents them.
- [ ] **`exit_node` tools** — `list_exit_nodes` (advertised exit nodes with location/online), `set_exit_node` / `clear_exit_node` (mutating: response includes before/after state so the agent can show the diff).
  *Done when:* CLI-driven, fixtures for the no-exit-nodes and multi-node cases, structured error when the chosen node doesn't advertise.
- [ ] **`netcheck`** — DERP region latencies, preferred relay, NAT/port-mapping detail. Complements `ping_all`: "why is this path relayed."
  *Done when:* parses `tailscale netcheck` (or LocalAPI equivalent) into a stable JSON shape; fixture-tested.
- [ ] **`dns_status`** — MagicDNS on/off, resolvers, search domains, per-node overrides.
- [ ] **Serve improvements** — TCP forwarding mode (`share_port {"proto": "tcp"}`), multiple simultaneous shares, idempotent re-share (same port updates instead of erroring). `share_status` grows to enumerate all active endpoints.
- [ ] **Taildrop send** — `send_file(peer, path)` via `tailscale file cp`. Receive is deferred: the `file-put` LocalAPI path is medium-stability and sandbox-entangled per the research.
- [ ] **LocalAPI provider — narrow scope**: `/localapi/v0/status` and `/localapi/v0/whois` only — the two high-stability endpoints (the CLI and GUIs depend on them). The LocalAPI as a whole is officially unstable, so `CliProvider` stays the default everywhere else and the automatic fallback for these. Platform IPC handled natively: Unix socket (Linux), ACL'd named pipe (Windows), sameuserproof (macOS).
  *Done when:* `ProviderManager` selects per-capability with fallback on connection failure; integration paths covered by fixtures per platform.
- [ ] **`whois` tool** — resolve a tailnet IP to node + user identity ("who is hitting my shared port"). Depends on the LocalAPI provider; also the building block for identity-gated execution in v0.4.

## v0.3.x — Admin API bridge (opt-in)

A new trust boundary: the Admin API needs OAuth client credentials. Everything here is **off unless credentials are provided via env** (`TS_API_CLIENT_ID`/`TS_API_CLIENT_SECRET`), scoped least-privilege, never logged or echoed. This is the "unified local + Admin API" gap no competitor fills — and for the homelab audience it means *one* server handles both "what's my tailnet doing" and "authorize my new raspi."

- [ ] **0.3.0 — `AdminApiProvider`** with documented least-privilege scope recipes per use case: read-only monitoring (`devices:core:read` + `dns:read`), GitOps validation (`policy_file:read`), provisioning (`auth_keys` on a tag-locked OAuth client).
  *Done when:* provider registers only the tools its granted scopes can serve; missing-credential and insufficient-scope both return structured errors with the exact admin-console remedy.
- [ ] **Rate-limit resilience** — honor `429`/`Retry-After` (integer and HTTP-date forms) with exponential backoff + jitter; `TAILSCALE_MAX_CONCURRENT` cap on concurrent Admin API calls.
- [ ] **Device management tools** — list all tailnet devices (not just peers), authorize, rename, set tags, key-expiry status. Mutations return before/after state.
- [ ] **ACL dry-run pre-flight tools** — `acl_validate` (syntax + semantic check of a proposed policy) and `acl_preview` (which connections a change would allow/deny), so a human reviews the effect *before* applying anything by hand. No server in the landscape offers this; it is the flagship v0.3 feature. Still no blind ACL writes — ever.
- [ ] **Scoped auth-key creation** — ephemeral, preauthorized, tag-inheriting keys via a tag-locked OAuth client (the control plane guarantees generated keys inherit the client's tags). The homelab "provision a new node from chat" workflow.
- [ ] **Permission tiers via env** — `TAILSCALE_MCP_READONLY=1` (mutating tools unregistered), `TAILSCALE_MCP_ALLOW_FUNNEL=0` (Funnel refused even with `public: true`), risk-level gate evaluated before every mutating tool.

## v0.4.x — Agentic ergonomics + identity-gated execution

- [ ] **Capability-grant authorization** — resolve the caller's identity via `whois` and check application capability grants in the tailnet ACL policy before executing privileged tools. The published mitigation for the confused-deputy problem (unprivileged user driving a privileged agent). Depends on: v0.2 `whois`, v0.3 `AdminApiProvider`.
- [ ] **MCP resources** — `tailnet://status`, `tailnet://peers/<hostname>`: pollable state without tool calls. Claude Desktop and Claude Code both render resources fully.
- [ ] **MCP prompts** — canned workflows: "diagnose connectivity to <node>" (status → ping → netcheck → interpretation), "share this dev server with the team" (share_port → whois-verify → URL handoff).
- [ ] **Progress notifications** for long ops (`ping_all` over large tailnets, future transfers). Claude Code renders text tickers; other clients ignore them — progressive enhancement only, never load-bearing.

## v1.0.0 — Stable + distribution

- [ ] **Cross-platform CI** — Windows + macOS runners exercising the named-pipe / unix-socket / sameuserproof provider paths.
- [ ] **Integration-test harness** — fixture capture tooling against a real tailnet with a sanitizer, so contributors can regenerate fixtures without leaking their tailnet.
- [ ] **Docs site completeness** — per-tool reference (generated from `mcp-tools.json`), security model page (trust boundaries, env flags, what the server will never do), provider architecture page.
- [ ] **Stability policy** — semver commitment; tool schemas are API: breaking schema changes only in majors, documented deprecation window.
- [ ] **Distribution beyond npm** — signed Docker image with SBOM (Docker MCP Catalog requirement), Smithery listing (requires Streamable HTTP — see deferred), mcp.so, standalone binaries (Windows/macOS/Linux), one-click configs for Claude Desktop / Claude Code / Cursor. Each channel gated on a license-compatibility check first (CC-BY-NC-ND).

## Deliberately skipped or deferred

- **Streamable HTTP transport** — deferred. Claude Desktop and Cursor don't support it (stdio remains the universal transport); `jaxxstorm/tailscale-mcp-proxy` already bridges stdio→HTTP for remote deployment. Revisit when client support lands; prerequisite for Smithery hosting.
- **OAuth authorization-server metadata / PRM discovery** — wait; mainstream clients don't render these flows yet.
- **Elicitation** — no meaningful client support.
- **Taildrop receive** — deferred pending LocalAPI `file-put` stability; send-only ships in v0.2.
- **Custom dashboards/visualization** — out of lane; effort belongs in the tool execution plane.

## Explicitly out of scope

- Handling `TS_AUTHKEY` or any node credential — the daemon owns auth
- ACL **writes** — validate/preview only; too much blast radius for an agent tool
- Anything that silently widens exposure (Funnel stays opt-in with warnings, forever)
- Competing on tool count (one competitor ships 89+ Admin API tools) — the differentiator is safety architecture, not surface area
