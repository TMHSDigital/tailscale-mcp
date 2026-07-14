import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TailscaleProvider } from "../providers/types.js";
import { register as registerStatus } from "./status.js";
import { register as registerSshConfig } from "./sshconfig.js";
import { register as registerShare } from "./share.js";
import { register as registerPing } from "./ping.js";

export interface ToolContext {
  provider: TailscaleProvider;
  /** Override for ~/.ssh (used by tests to target a temp directory). */
  sshDir?: string;
}

export function registerAll(server: McpServer, ctx: ToolContext): void {
  registerStatus(server, ctx);
  registerSshConfig(server, ctx);
  registerShare(server, ctx);
  registerPing(server, ctx);
}
