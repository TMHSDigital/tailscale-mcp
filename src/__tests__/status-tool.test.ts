import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CliProvider } from "../providers/cli.js";
import { registerAll } from "../tools/index.js";
import { fixture, mockRunner, okResult } from "./support.js";

async function connectedClient(provider: CliProvider): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerAll(server, { provider });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

describe("tailnet_status tool", () => {
  it("lists the server's tools", async () => {
    const client = await connectedClient(new CliProvider({ runner: mockRunner({}) }));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("tailnet_status");
  });

  it("returns the trimmed status payload", async () => {
    const client = await connectedClient(
      new CliProvider({
        runner: mockRunner({ "status --json": okResult(fixture("status-running.json")) }),
      }),
    );
    const result = await client.callTool({ name: "tailnet_status", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(textOf(result));
    expect(data.backendState).toBe("Running");
    expect(data.peerCount).toBe(3);
    expect(data.peers).toHaveLength(3);
  });

  it("filters to online peers with onlineOnly", async () => {
    const client = await connectedClient(
      new CliProvider({
        runner: mockRunner({ "status --json": okResult(fixture("status-running.json")) }),
      }),
    );
    const result = await client.callTool({
      name: "tailnet_status",
      arguments: { onlineOnly: true },
    });
    const data = JSON.parse(textOf(result));
    expect(data.peerCount).toBe(3);
    expect(data.peers).toHaveLength(2);
    expect(data.peers.every((p: { online: boolean }) => p.online)).toBe(true);
  });

  it("returns a structured actionable error when the daemon is stopped", async () => {
    const client = await connectedClient(
      new CliProvider({
        runner: mockRunner({ "status --json": okResult(fixture("status-stopped.json")) }),
      }),
    );
    const result = await client.callTool({ name: "tailnet_status", arguments: {} });
    expect(result.isError).toBe(true);
    const data = JSON.parse(textOf(result));
    expect(data.error.code).toBe("DAEMON_NOT_RUNNING");
    expect(data.error.remedy).toContain("tailscale up");
  });
});
