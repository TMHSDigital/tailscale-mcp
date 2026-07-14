import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CliProvider } from "../providers/cli.js";
import { registerAll } from "../tools/index.js";
import {
  applyManagedBlock,
  BEGIN_MARKER,
  END_MARKER,
  renderHostBlocks,
} from "../sshconfig.js";
import type { TailscaleNode } from "../providers/types.js";
import { fixture, mockRunner, okResult } from "./support.js";

function node(overrides: Partial<TailscaleNode>): TailscaleNode {
  return {
    hostname: "box",
    dnsName: "box.tail1234.ts.net",
    ipv4: "100.101.1.99",
    ipv6: null,
    os: "linux",
    online: true,
    lastSeen: null,
    exitNode: false,
    exitNodeOption: false,
    tags: [],
    ...overrides,
  };
}

describe("renderHostBlocks", () => {
  it("prefers MagicDNS and falls back to the Tailscale IP", () => {
    const text = renderHostBlocks([
      node({ hostname: "raspi" }),
      node({ hostname: "bare", dnsName: "", ipv4: "100.101.1.7" }),
    ]);
    expect(text).toContain("Host raspi\n    HostName box.tail1234.ts.net");
    expect(text).toContain("Host bare\n    HostName 100.101.1.7");
  });

  it("skips nodes with neither DNS name nor IP and adds User when given", () => {
    const text = renderHostBlocks(
      [node({ hostname: "ghost", dnsName: "", ipv4: null }), node({ hostname: "dev" })],
      { user: "ubuntu" },
    );
    expect(text).not.toContain("ghost");
    expect(text).toContain("    User ubuntu");
  });
});

describe("applyManagedBlock", () => {
  const body = "Host raspi\n    HostName raspi.tail1234.ts.net";

  it("is idempotent: applying twice yields identical output", () => {
    const once = applyManagedBlock("", body);
    const twice = applyManagedBlock(once, body);
    expect(twice).toBe(once);
    expect(once).toContain(BEGIN_MARKER);
    expect(once).toContain(END_MARKER);
  });

  it("never touches content outside the markers", () => {
    const userContent = "Host mybox\n    HostName 10.0.0.5\n    Port 2222\n";
    const trailer = "\n# my trailing comment\n";
    const existing =
      userContent + `${BEGIN_MARKER}\nold stale body\n${END_MARKER}` + trailer;
    const updated = applyManagedBlock(existing, body);
    expect(updated.startsWith(userContent)).toBe(true);
    expect(updated.endsWith(trailer)).toBe(true);
    expect(updated).toContain(body);
    expect(updated).not.toContain("old stale body");
  });

  it("appends to an existing config without markers", () => {
    const existing = "Host other\n    HostName 10.1.1.1\n";
    const updated = applyManagedBlock(existing, body);
    expect(updated.startsWith(existing)).toBe(true);
    expect(updated).toContain(BEGIN_MARKER);
  });
});

describe("generate_ssh_config tool", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function connectedClient(): Promise<Client> {
    dir = mkdtempSync(join(tmpdir(), "ts-mcp-ssh-"));
    const provider = new CliProvider({
      runner: mockRunner({ "status --json": okResult(fixture("status-running.json")) }),
    });
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAll(server, { provider, sshDir: dir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }

  function payload(result: { content?: unknown }): Record<string, any> {
    const content = result.content as Array<{ text: string }>;
    return JSON.parse(content[0].text);
  }

  it("dry-run by default: returns config text, writes nothing", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "generate_ssh_config", arguments: {} });
    const data = payload(result);
    expect(data.dryRun).toBe(true);
    expect(data.hostCount).toBe(3);
    expect(data.configText).toContain("Host raspi");
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("write=true writes the dedicated file and returns Include instructions", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "generate_ssh_config",
      arguments: { write: true, user: "pi" },
    });
    const data = payload(result);
    expect(data.dryRun).toBe(false);
    const written = readFileSync(join(dir, "tailscale_dev_config"), "utf-8");
    expect(written).toContain("Host raspi");
    expect(written).toContain("User pi");
    expect(data.instructions).toContain("Include tailscale_dev_config");
    // The user's ~/.ssh/config is not created or touched.
    expect(existsSync(join(dir, "config"))).toBe(false);
  });

  it("user_ssh_config target edits between markers idempotently", async () => {
    const client = await connectedClient();
    const preexisting = "Host mybox\n    HostName 10.0.0.5\n";
    writeFileSync(join(dir, "config"), preexisting, "utf-8");

    const args = { write: true, target: "user_ssh_config" };
    await client.callTool({ name: "generate_ssh_config", arguments: args });
    const first = readFileSync(join(dir, "config"), "utf-8");
    await client.callTool({ name: "generate_ssh_config", arguments: args });
    const second = readFileSync(join(dir, "config"), "utf-8");

    expect(second).toBe(first);
    expect(first.startsWith(preexisting)).toBe(true);
    expect(first).toContain("Host raspi");
  });

  it("onlineOnly filters offline peers out of the config", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "generate_ssh_config",
      arguments: { onlineOnly: true },
    });
    const data = payload(result);
    expect(data.hostCount).toBe(2);
    expect(data.configText).not.toContain("phone");
  });

  it("returns a structured error when the daemon is down", async () => {
    dir = mkdtempSync(join(tmpdir(), "ts-mcp-ssh-"));
    const provider = new CliProvider({
      runner: mockRunner({ "status --json": okResult(fixture("status-stopped.json")) }),
    });
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAll(server, { provider, sshDir: dir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({ name: "generate_ssh_config", arguments: {} });
    expect(result.isError).toBe(true);
    expect(payload(result).error.code).toBe("DAEMON_NOT_RUNNING");
  });
});
