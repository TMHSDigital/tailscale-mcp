import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CliProvider } from "../providers/cli.js";
import { registerAll } from "../tools/index.js";
import { mockRunner } from "./support.js";

// mcp-tools.json is generated from what the server actually advertises, so it
// can never drift from the registered tools. After changing a tool, regenerate
// it with `npm run gen:tools`; CI fails if the committed file is stale.
describe("mcp-tools.json", () => {
  it("matches listTools() for a default install", async () => {
    const server = new McpServer({ name: "tailscale-mcp", version: "0.0.0" });
    registerAll(server, { provider: new CliProvider({ runner: mockRunner({}) }) });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "manifest", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const { tools } = await client.listTools();
    await expect(JSON.stringify(tools, null, 2) + "\n").toMatchFileSnapshot(
      "../../mcp-tools.json",
    );
  });
});
