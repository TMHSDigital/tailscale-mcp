import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./index.js";
import { fail, ok } from "./helpers.js";

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "share_port",
    "Share a local port over the tailnet via Tailscale Serve (tailnet-only by " +
      "default). WARNING: setting public=true switches to Funnel and exposes the " +
      "port to the OPEN INTERNET — anyone with the URL can reach it. Only set " +
      "public=true when internet exposure is explicitly intended. Returns the " +
      "resulting URL(s).",
    {
      port: z.number().int().min(1).max(65535).describe("Local port to share"),
      public: z
        .boolean()
        .optional()
        .describe(
          "Expose to the open internet via Funnel (default: false = tailnet-only Serve). " +
            "DANGEROUS: public=true makes the port reachable by anyone on the internet.",
        ),
      path: z
        .string()
        .optional()
        .describe('HTTPS mount path on the serve endpoint (default: "/")'),
    },
    async ({ port, public: isPublic, path }) => {
      try {
        const result = await ctx.provider.serve({ port, public: isPublic === true, path });
        return ok({
          port,
          public: result.public,
          scope: result.public ? "OPEN INTERNET (Funnel)" : "tailnet-only (Serve)",
          urls: result.urls,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "share_status",
    "Report the active Tailscale Serve/Funnel sessions on this node.",
    {},
    async () => {
      try {
        const raw = await ctx.provider.serveStatus();
        return ok({
          active: raw !== "" && !/^No serve config/i.test(raw),
          status: raw || "No serve config",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "stop_share",
    "Stop sharing. Without arguments clears the entire serve/funnel configuration; " +
      "with httpsPort it turns off just that HTTPS serve endpoint (the port shown in " +
      "share_status, typically 443 — not the local port that was proxied).",
    {
      httpsPort: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .optional()
        .describe(
          "HTTPS serve port to turn off (as shown in share_status). Omit to clear everything.",
        ),
    },
    async ({ httpsPort }) => {
      try {
        const message = await ctx.provider.serveReset(httpsPort);
        return ok({ stopped: httpsPort ?? "all", message });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
