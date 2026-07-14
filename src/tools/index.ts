import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TailscaleProvider } from "../providers/types.js";
import { register as registerStatus } from "./status.js";

export interface ToolContext {
  provider: TailscaleProvider;
}

export function registerAll(server: McpServer, ctx: ToolContext): void {
  registerStatus(server, ctx);
}
