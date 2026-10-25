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
  /** Override for ping_all's overall deadline (used by tests). */
  pingAllDeadlineMs?: number;
  /** Skip mutating tools and refuse ssh-config writes (TAILSCALE_MCP_READONLY). */
  readOnly?: boolean;
  /** Allow share_port to use Funnel (TAILSCALE_MCP_ALLOW_FUNNEL); denied by default. */
  allowFunnel?: boolean;
}

export function registerAll(server: McpServer, ctx: ToolContext): void {
  registerStatus(server, ctx);
  registerSshConfig(server, ctx);
  registerShare(server, ctx);
  registerPing(server, ctx);
}
