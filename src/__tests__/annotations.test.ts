import { readdirSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CliProvider } from "../providers/cli.js";
import { registerAll, type ToolContext } from "../tools/index.js";
import { fixture, mockRunner, okResult } from "./support.js";

async function listTools(overrides: Partial<ToolContext> = {}) {
  const provider = new CliProvider({
    runner: mockRunner({ "status --json": okResult(fixture("status-running.json")) }),
  });
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerAll(server, { provider, ...overrides });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, tools: (await client.listTools()).tools };
}

describe("tool annotations and output schemas", () => {
  it("every tool has a title, all four hints, and an output schema", async () => {
    const { tools } = await listTools();
    expect(tools).toHaveLength(6);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.outputSchema?.type, tool.name).toBe("object");
      for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
        expect(typeof (tool.annotations as Record<string, unknown>)?.[hint], `${tool.name}.${hint}`).toBe(
          "boolean",
        );
      }
    }
  });

  it("matches the intended safety classification", async () => {
    const { tools } = await listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    for (const name of ["tailnet_status", "share_status", "ping_all"]) {
      expect(hints[name], name).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    }
    expect(hints.generate_ssh_config).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hints.stop_share).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    // Funnel is denied by default, so share_port cannot reach the open world...
    expect(hints.share_port).toMatchObject({ readOnlyHint: false, openWorldHint: false });
  });

  it("marks share_port open-world only when Funnel is allowed", async () => {
    const { tools } = await listTools({ allowFunnel: true });
    expect(tools.find((t) => t.name === "share_port")?.annotations?.openWorldHint).toBe(true);
  });

  it("marks generate_ssh_config read-only in read-only mode", async () => {
    const { tools } = await listTools({ readOnly: true });
    expect(tools.find((t) => t.name === "generate_ssh_config")?.annotations?.readOnlyHint).toBe(
      true,
    );
  });

  it("returns structuredContent that mirrors the text block", async () => {
    const { client } = await listTools();
    const result = await client.callTool({ name: "tailnet_status", arguments: {} });
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.backendState).toBe("Running");
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text)).toEqual(structured);
  });

  it("returns errors as text only, so clients do not validate them against outputSchema", async () => {
    const { client } = await listTools();
    const result = await client.callTool({
      name: "share_port",
      arguments: { port: 3000, public: true },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text).error.code).toBe("FUNNEL_DISABLED");
  });

  it("uses no deprecated server.tool() registrations", () => {
    const dir = new URL("../tools/", import.meta.url);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      expect(readFileSync(new URL(file, dir), "utf-8"), file).not.toMatch(/server\.tool\(/);
    }
  });
});
