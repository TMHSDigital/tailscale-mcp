# Deep-research prompt for Gemini

Copy everything below the line into Gemini Deep Research. Save the resulting report as
`docs/research/tailscale-mcp-landscape-2026.md` in this repo.

---

I maintain **@tmhs/tailscale-mcp**, an open-source MCP (Model Context Protocol) server that wraps the **local Tailscale daemon** — currently via the `tailscale` CLI over stdio. Shipped tools: tailnet status, SSH-config generation, port sharing via Serve/Funnel (tailnet-only by default, Funnel behind an explicit opt-in), and a concurrent latency/ping matrix. Design principles: dry-run defaults, structured errors with remedy commands, never touching auth keys or tailnet credentials.

I'm planning versions 0.2–1.0 and need a rigorous landscape report. Research the following, with citations to primary sources (official docs, source code, changelogs) wherever possible, and clearly flag anything that is speculative or based on unofficial sources:

## 1. Competitive landscape

Find every actively maintained MCP server for Tailscale (GitHub, npm, PyPI, MCP registries). For each: tool surface, whether it uses the CLI, the LocalAPI, or the Admin API; auth model; download/star traction; last release; license. End with a gap table: capabilities nobody offers well, and capabilities that are commoditized.

## 2. Tailscale LocalAPI

Document the daemon's LocalAPI (HTTP over the Unix socket / Windows named pipe, as used by the CLI itself): endpoint inventory, how stable/documented it is, official stance on third-party use, authentication on each platform (peerapi vs localapi, Windows named-pipe ACLs, macOS sandboxed variants), and known breakage history across versions. Which endpoints are safe to build a provider on vs likely to churn?

## 3. Tailscale Admin API (api.tailscale.com)

Current capability inventory: device management, ACL read/validate, auth-key creation (scopes, ephemeral, tags), DNS, webhooks, device posture, logging APIs. OAuth-client scopes model and best practice for least-privilege credentials held by an automated agent. Rate limits. Anything announced/changed in 2025–2026.

## 4. MCP specification — current state

As of mid-2026: status of Streamable HTTP transport, authorization spec (OAuth flows for remote MCP servers), tool annotations (readOnlyHint/destructiveHint), resources and resource subscriptions, prompts, progress notifications, elicitation. Which of these do the major clients (Claude Desktop/Code, Cursor, VS Code, OpenAI clients) actually support today? A feature the spec has but no client renders is not worth building yet — call those out.

## 5. Security posture for infrastructure MCP servers

Published guidance and incident history for MCP servers that control network infrastructure: prompt-injection → tool-misuse chains, confused-deputy risks, recommended confirmation/permission patterns, sandboxing, and what "read-only mode" conventions have emerged. Any published security reviews of Tailscale-related agents/tools.

## 6. Distribution channels

Which MCP registries/catalogs actually drive installs in 2026 (official MCP registry, Docker MCP Catalog, Smithery, mcp.so, client-specific directories)? Listing requirements for each, and whether npm-only distribution is leaving adoption on the table. Any signing/attestation requirements emerging.

## Output format

Markdown report with: an executive summary of the 5 most consequential findings for my roadmap; one section per topic above; every factual claim cited with a link; a final "recommendations" section that maps findings to concrete roadmap moves (build / skip / wait), each with a one-line justification.
