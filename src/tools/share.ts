import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./index.js";
import { fail, ok } from "./helpers.js";
import { DEFAULT_HTTPS_PORT, type ServeStatus } from "../providers/types.js";

/**
 * An HTTPS mount path: leading slash, URL-safe segment characters only.
 * Trailing slashes are dropped ("/api/" -> "/api") so share_port and
 * stop_share name the same mount.
 */
export const mountPath = z
  .string()
  .regex(
    /^\/[A-Za-z0-9._~\-/]*$/,
    'Path must start with "/" and contain only letters, digits, and . _ ~ - /',
  )
  .refine((p) => !p.split("/").some((seg) => seg === "." || seg === ".."), {
    message: 'Path must not contain "." or ".." segments',
  })
  .transform((p) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p));

/** The share_status payload, also used for stop_share's before/after state. */
export function summarizeServeStatus(status: ServeStatus) {
  if (!status.parsed) {
    // Old CLI without `serve status --json`: only the text form is available.
    return {
      active: status.raw !== "" && !/^No serve config/i.test(status.raw),
      publicExposure: null,
      endpoints: [],
      status: status.raw || "No serve config",
    };
  }
  return {
    active: status.endpoints.length + status.tcpForwards.length > 0,
    publicExposure:
      status.endpoints.some((e) => e.public) || status.tcpForwards.some((t) => t.public),
    endpoints: status.endpoints,
    ...(status.tcpForwards.length > 0 && { tcpForwards: status.tcpForwards }),
  };
}

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
      path: mountPath
        .optional()
        .describe('HTTPS mount path on the serve endpoint, e.g. "/api" (default: "/")'),
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
    "Report the active Tailscale Serve/Funnel sessions on this node: one entry per " +
      "endpoint with its URL, serve port, mount path, proxied target, and a public flag " +
      "that is true when Funnel exposes it to the open internet. publicExposure is " +
      "true when anything is public.",
    {},
    async () => {
      try {
        return ok(summarizeServeStatus(await ctx.provider.serveStatus()));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "stop_share",
    "Stop sharing. Without arguments clears the entire serve/funnel configuration; " +
      "with httpsPort and/or path it turns off just that mount (httpsPort is the port " +
      "shown in share_status, typically 443 — not the local port that was proxied; " +
      "path is the mount path given to share_port, default \"/\").",
    {
      httpsPort: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .optional()
        .describe(
          "HTTPS serve port to turn off (as shown in share_status; default 443 when path " +
            "is given). Omit both httpsPort and path to clear everything.",
        ),
      path: mountPath
        .optional()
        .describe('Mount path to turn off, as passed to share_port (default: "/")'),
    },
    async ({ httpsPort, path }) => {
      try {
        const message = await ctx.provider.serveReset(httpsPort, path);
        const stopped =
          httpsPort === undefined && path === undefined
            ? "all"
            : { httpsPort: httpsPort ?? DEFAULT_HTTPS_PORT, path: path ?? "/" };
        return ok({ stopped, message });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
