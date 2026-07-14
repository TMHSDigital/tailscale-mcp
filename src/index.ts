#!/usr/bin/env node
import { readFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CliProvider } from "./providers/cli.js";
import { registerAll } from "./tools/index.js";

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const server = new McpServer({ name: "tailscale-mcp", version: readVersion() });
  registerAll(server, { provider: new CliProvider() });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; all logging goes to stderr.
  console.error(`tailscale-mcp ${readVersion()} listening on stdio`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
