# Tailscale MCP

**MCP server for safe programmatic access to the local Tailscale daemon: tailnet discovery, SSH config generation, port sharing via Serve/Funnel, and latency matrices.**

![License: CC-BY-NC-ND-4.0](https://img.shields.io/badge/license-CC--BY--NC--ND--4.0-green)
[![npm version](https://img.shields.io/npm/v/%40tmhs%2Ftailscale-mcp)](https://www.npmjs.com/package/@tmhs/tailscale-mcp)
[![CI](https://github.com/TMHSDigital/tailscale-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/TMHSDigital/tailscale-mcp/actions/workflows/ci.yml)

---

Gives agents and developer tools a safe, structured window into the local Tailscale daemon over stdio. It shells out to the `tailscale` CLI (resolved from PATH, with a Windows fallback to the default install location) and never handles auth keys or tailnet credentials: the CLI talks to the already-authenticated local daemon.

When the binary is missing, the daemon is stopped, or the device needs login, every tool returns a structured error with a `code` and the exact `remedy` command instead of throwing.

## Installation

```bash
npx -y @tmhs/tailscale-mcp
```

Add to your MCP client configuration (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "tailscale": {
      "command": "npx",
      "args": ["-y", "@tmhs/tailscale-mcp"]
    }
  }
}
```

Requires Node 20+ and an installed, logged-in Tailscale client.

### Finding the tailscale CLI

The server looks for `tailscale` on `PATH`, then in the platform's default install locations: `C:\Program Files\Tailscale\tailscale.exe` on Windows, and `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `/opt/homebrew/bin/tailscale`, and `/usr/local/bin/tailscale` on macOS. Mac App Store installs therefore work without extra setup. To use a different binary, set `TAILSCALE_MCP_BIN`:

```json
{
  "mcpServers": {
    "tailscale": {
      "command": "npx",
      "args": ["-y", "@tmhs/tailscale-mcp"],
      "env": { "TAILSCALE_MCP_BIN": "/path/to/tailscale" }
    }
  }
}
```

### Timeouts

Every `tailscale` invocation is bounded, by default to 10 seconds. A hung daemon returns a structured `TIMEOUT` error instead of stalling the agent. Set `TAILSCALE_MCP_TIMEOUT_MS` to raise the limit for slow machines or very large tailnets. `share_port` waits up to 15 seconds and `ping` scales with `count` and `timeoutMs`; `ping_all` as a whole is capped at 45 seconds.

### Linux: Serve/Funnel permissions

On Linux only root or the configured operator can change Serve/Funnel settings. If `share_port` or `stop_share` returns `PERMISSION_DENIED`, allow your user once:

```bash
sudo tailscale set --operator=$USER
```

## Tools

### tailnet_status

Trimmed view of `tailscale status --json`: self node plus peers with hostname, MagicDNS name, Tailscale IPv4/IPv6, OS, online flag, last seen, exit-node flags, and tags. Input: optional `onlineOnly`.

```json
{
  "backendState": "Running",
  "tailnet": "user@example.com",
  "magicDNSSuffix": "tail1234.ts.net",
  "self": {"hostname": "DEVPC", "dnsName": "devpc.tail1234.ts.net", "ipv4": "100.101.1.10"},
  "peerCount": 3,
  "peers": [
    {"hostname": "raspi", "dnsName": "raspi.tail1234.ts.net", "ipv4": "100.101.1.20", "os": "linux", "online": true, "exitNodeOption": true, "tags": []}
  ]
}
```

### generate_ssh_config

Emits ssh-config Host blocks for tailnet nodes (MagicDNS name preferred, Tailscale IP fallback). **Dry-run by default**: returns the generated text only. Inputs: `write`, `target`, `onlineOnly`, `includeShared`, `user`.

- Each `Host` alias is the node's first MagicDNS label (`raspi.tail1234.ts.net` → `raspi`), falling back to a sanitized OS hostname (`[a-z0-9-]` only). Colliding aliases get a numeric suffix and are listed under `renamed`. Mullvad exit nodes, and nodes of users you share with (unless `includeShared: true`), are left out and listed under `skipped`.
- `write: true` writes the dedicated file `~/.ssh/tailscale_dev_config` and returns the `Include tailscale_dev_config` instruction for `~/.ssh/config` (never applied automatically).
- `target: "user_ssh_config"` (with `write: true`) edits `~/.ssh/config` directly, idempotently, between `# BEGIN tailscale-mcp` and `# END tailscale-mcp` markers. Content outside the markers is never touched. If the markers are malformed (orphaned, reversed, or duplicated) the tool returns `SSH_CONFIG_MARKERS_CORRUPT` and writes nothing.
- Writes are atomic (temp file + rename), the previous `~/.ssh/config` is kept as `config.tailscale-mcp.bak`, new files are created `0600` (existing modes are kept), and a symlinked config is written through rather than replaced.

```json
{
  "dryRun": true,
  "hostCount": 2,
  "configText": "# BEGIN tailscale-mcp\nHost raspi\n    HostName raspi.tail1234.ts.net\n\nHost devbox\n    HostName devbox.tail1234.ts.net\n# END tailscale-mcp"
}
```

### share_port

Shares a local port via Tailscale Serve. **Tailnet-only by default.** Inputs: `port` (required), `public`, `path`.

```json
{"port": 3000, "public": false, "scope": "tailnet-only (Serve)", "urls": ["https://devpc.tail1234.ts.net/"]}
```

`public: true` switches to Funnel and exposes the port to the open internet. See the security notes below.

### share_status

Reports active Serve/Funnel sessions: `{"active": false, "status": "No serve config"}`.

### stop_share

Without arguments clears the entire serve/funnel configuration. With `httpsPort` and/or `path` it turns off one mount: `httpsPort` is the serve port shown in `share_status` (default 443, not the proxied local port), and `path` is the mount path given to `share_port` (default `/`). For example, `{"path": "/api"}` undoes `share_port {"port": 3000, "path": "/api"}`.

Mount paths must start with `/` and use only letters, digits, and `. _ ~ - /`, with no `.` or `..` segments. A trailing slash is dropped.

### ping_all

Concurrent `tailscale ping` against peers (bounded to 5 in flight, with a per-ping timeout). Inputs: `count`, `timeoutMs`, `onlineOnly` (default true).

```json
{
  "pinged": 2,
  "reachable": 1,
  "timedOut": false,
  "matrix": [
    {"hostname": "raspi", "target": "100.101.1.20", "reachable": true, "latencyMs": 3, "path": "direct", "via": "192.168.1.20:41641", "attempts": 3, "replies": 3},
    {"hostname": "exitbox", "target": "100.101.1.40", "reachable": false, "latencyMs": null, "path": null, "via": null, "attempts": 1, "replies": 0}
  ]
}
```

`path` is `direct` (peer-to-peer), `derp` (relayed through a Tailscale DERP server), `peer-relay` (relayed through one of your nodes), or `unknown`, so an agent can tell "works but relayed" from "fast direct path". `tailscale ping` keeps pinging until a direct path comes up, so `path` and `latencyMs` describe the last reply, i.e. the settled path. The whole call is capped at 45 seconds: peers that haven't answered by then come back with an `error` and `timedOut: true`.

## Agentic workflow example

An agent asked to "deploy this to my dev VPS and show me the result" can do the whole discovery leg through this server:

1. `tailnet_status {"onlineOnly": true}` finds the VPS node and its MagicDNS name (`devbox.tail1234.ts.net`), with no hardcoded IPs.
2. `generate_ssh_config {"write": true, "user": "deploy"}` writes `~/.ssh/tailscale_dev_config`; the agent shows the returned one-line `Include` instruction, and after the user adds it, `ssh devbox` resolves through the tailnet.
3. `ping_all` confirms the node is reachable and whether the path is direct or relayed before starting a large transfer.
4. After deploying, `share_port {"port": 8080}` returns a tailnet-only URL teammates on the tailnet can open. Nothing touches the public internet unless the agent is explicitly told to pass `public: true`.

## Security notes on Funnel

- `share_port` defaults to tailnet-only Serve. Nothing is reachable from outside your tailnet.
- `public: true` uses Tailscale Funnel: the URL is reachable by **anyone on the internet**, not just your tailnet. The tool description carries this warning so agents surface it before acting.
- Serve and Funnel must be enabled per-tailnet in the admin console. When they are not, the tool returns a structured `SERVE_NOT_ENABLED` error containing the exact enablement URL and changes nothing.
- `stop_share` (no arguments) is the kill switch: it clears the entire serve/funnel configuration.
- This server never reads or stores `TS_AUTHKEY` or any other credential.

## Development

```bash
npm install
npm run build     # tsc
npm test          # vitest, fully offline (fixture-driven, no live tailnet)
npm run typecheck
```

Provider adapter pattern: `src/providers/types.ts` defines the `TailscaleProvider` interface; `CliProvider` (the only v0.1 implementation) spawns the CLI through an injectable process runner so tests never launch a real binary. The interface leaves room for a future LocalAPI provider speaking HTTP over the local socket or named pipe.

## Project Structure

```
tailscale-mcp/
  src/                Source code
  src/providers/      TailscaleProvider interface + CliProvider
  src/tools/          MCP tool registrations
  test/fixtures/      Sanitized CLI output captured from a real tailnet
  .github/            CI/CD workflows
```

## Roadmap

See [ROADMAP.md](ROADMAP.md) for the full project roadmap.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

CC-BY-NC-ND-4.0 -- see [LICENSE](LICENSE) for details.

---

**Built by TMHSDigital**
