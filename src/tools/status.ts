import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./index.js";
import { fail, ok, READ_ONLY } from "./helpers.js";
import { tailnetStatusOutput } from "./schemas.js";

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "tailnet_status",
    {
      title: "Tailnet status",
      description:
        "Report the state of the local tailnet: this node plus all peers with hostname, " +
        "MagicDNS name, Tailscale IPv4/IPv6, OS, online flag, last seen, exit-node flags, " +
        "and tags. Returns a structured error with the exact fix command when the " +
        "tailscale binary is missing, the daemon is stopped, or the device needs login.",
      inputSchema: {
        onlineOnly: z
          .boolean()
          .optional()
          .describe("Only include peers that are currently online (default: false)"),
      },
      outputSchema: tailnetStatusOutput,
      annotations: READ_ONLY,
    },
    async ({ onlineOnly }) => {
      try {
        const status = await ctx.provider.status();
        const peers = onlineOnly ? status.peers.filter((p) => p.online) : status.peers;
        return ok({
          backendState: status.backendState,
          tailnet: status.tailnet,
          magicDNSSuffix: status.magicDNSSuffix,
          health: status.health,
          self: status.self,
          peerCount: status.peers.length,
          peers,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
