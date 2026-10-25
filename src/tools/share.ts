import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./index.js";
import { fail, ok, READ_ONLY } from "./helpers.js";
import { sharePortOutput, shareStatusOutput, stopShareOutput } from "./schemas.js";
import { ALLOW_FUNNEL_ENV_VAR } from "../config.js";
import { DEFAULT_HTTPS_PORT, TailscaleError, type ServeStatus } from "../providers/types.js";

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

const mountKey = (httpsPort: number, path: string) => `${httpsPort}${path}`;

export function register(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "share_status",
    {
      title: "Share status",
      description:
        "Report the active Tailscale Serve/Funnel sessions on this node: one entry per " +
        "endpoint with its URL, serve port, mount path, proxied target, and a public flag " +
        "that is true when Funnel exposes it to the open internet. publicExposure is " +
        "true when anything is public.",
      inputSchema: {},
      outputSchema: shareStatusOutput,
      annotations: READ_ONLY,
    },
    async () => {
      try {
        return ok(summarizeServeStatus(await ctx.provider.serveStatus()));
      } catch (err) {
        return fail(err);
      }
    },
  );

  // Read-only deployments get status only; nothing that changes the config.
  if (ctx.readOnly) return;

  /** Mounts created by share_port in this server session, for stop_share mine=true. */
  const created = new Map<string, { httpsPort: number; path: string }>();
  const allowFunnel = ctx.allowFunnel === true;

  server.registerTool(
    "share_port",
    {
      title: "Share a local port",
      description:
        "Share a local port over the tailnet via Tailscale Serve (tailnet-only by " +
        "default). WARNING: setting public=true switches to Funnel and exposes the " +
        "port to the OPEN INTERNET — anyone with the URL can reach it. Only set " +
        "public=true when internet exposure is explicitly intended. " +
        (allowFunnel
          ? ""
          : `Funnel is DISABLED on this server: public=true returns FUNNEL_DISABLED unless ` +
            `the user sets ${ALLOW_FUNNEL_ENV_VAR}=1. `) +
        "Returns the resulting URL(s).",
      inputSchema: {
        port: z.number().int().min(1).max(65535).describe("Local port to share"),
        public: z
          .boolean()
          .optional()
          .describe(
            "Expose to the open internet via Funnel (default: false = tailnet-only Serve). " +
              "DANGEROUS: public=true makes the port reachable by anyone on the internet." +
              (allowFunnel ? "" : ` Disabled unless ${ALLOW_FUNNEL_ENV_VAR}=1.`),
          ),
        path: mountPath
          .optional()
          .describe('HTTPS mount path on the serve endpoint, e.g. "/api" (default: "/")'),
      },
      outputSchema: sharePortOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Sharing the same port at the same path again leaves the same config.
        idempotentHint: true,
        // Funnel reaches the open internet; only possible when it is allowed.
        openWorldHint: allowFunnel,
      },
    },
    async ({ port, public: isPublic, path }) => {
      try {
        if (isPublic === true && !allowFunnel) {
          throw new TailscaleError(
            "FUNNEL_DISABLED",
            "Funnel (public internet exposure) is disabled on this server, so nothing was " +
              "shared. Tailnet-only sharing (public=false) is still available.",
            `If internet exposure is intended, the user must set ${ALLOW_FUNNEL_ENV_VAR}=1 ` +
              "in the MCP client config for this server and restart it.",
          );
        }
        const result = await ctx.provider.serve({ port, public: isPublic === true, path });
        // share_port never passes --https, so the mount is on the default port.
        created.set(mountKey(DEFAULT_HTTPS_PORT, path ?? "/"), {
          httpsPort: DEFAULT_HTTPS_PORT,
          path: path ?? "/",
        });
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

  server.registerTool(
    "stop_share",
    {
      title: "Stop sharing",
      description:
        "Stop sharing. Name exactly one target: httpsPort and/or path turns off that one " +
        "mount (httpsPort is the serve port shown in share_status, typically 443, not the " +
        "proxied local port; path is the mount path given to share_port, default \"/\"); " +
        "mine=true stops only the shares this server created in this session; all=true " +
        "clears the entire serve/funnel configuration, including shares set up outside " +
        "this server. With no arguments nothing is stopped and the active endpoints are " +
        "listed. Returns what was removed and what remains.",
      inputSchema: {
        httpsPort: z
          .number()
          .int()
          .min(1)
          .max(65535)
          .optional()
          .describe("HTTPS serve port of the mount to turn off (default 443 when path is given)"),
        path: mountPath
          .optional()
          .describe('Mount path to turn off, as passed to share_port (default: "/")'),
        mine: z
          .boolean()
          .optional()
          .describe("Stop only the shares created by share_port in this session"),
        all: z
          .boolean()
          .optional()
          .describe(
            "Clear the ENTIRE serve/funnel config, including shares not created by this server",
          ),
      },
      outputSchema: stopShareOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ httpsPort, path, mine, all }) => {
      try {
        const targeted = httpsPort !== undefined || path !== undefined;
        const modes = [targeted, mine === true, all === true].filter(Boolean).length;
        if (modes > 1) {
          throw new TailscaleError(
            "INVALID_ARGUMENTS",
            "stop_share takes exactly one target: httpsPort/path, mine, or all.",
            "Call stop_share again with a single target.",
          );
        }

        const before = await ctx.provider.serveStatus();
        if (modes === 0) {
          const endpoints = before.endpoints.map((e) => `${e.url} (httpsPort ${e.httpsPort}, path ${e.path})`);
          throw new TailscaleError(
            "TARGET_REQUIRED",
            "stop_share needs a target; nothing was stopped. " +
              (endpoints.length > 0
                ? `Active endpoints: ${endpoints.join("; ")}.`
                : before.parsed
                  ? "There are no active endpoints."
                  : `Current serve status: ${before.raw || "No serve config"}.`),
            "Pass httpsPort and/or path for one mount, mine=true for shares created in " +
              "this session, or all=true to clear everything.",
          );
        }

        let stopped: unknown;
        const failures: Array<{ httpsPort: number; path: string; error: string }> = [];
        if (all) {
          await ctx.provider.serveReset();
          created.clear();
          stopped = "all";
        } else if (mine) {
          const mounts = [...created.values()];
          for (const m of mounts) {
            try {
              await ctx.provider.serveReset(m.httpsPort, m.path);
              created.delete(mountKey(m.httpsPort, m.path));
            } catch (err) {
              failures.push({ ...m, error: err instanceof Error ? err.message : String(err) });
            }
          }
          stopped = mounts;
        } else {
          const mount = { httpsPort: httpsPort ?? DEFAULT_HTTPS_PORT, path: path ?? "/" };
          await ctx.provider.serveReset(mount.httpsPort, mount.path);
          created.delete(mountKey(mount.httpsPort, mount.path));
          stopped = mount;
        }

        const after = await ctx.provider.serveStatus();
        const remainingUrls = new Set(after.endpoints.map((e) => e.url));
        return ok({
          stopped,
          removed: before.endpoints.filter((e) => !remainingUrls.has(e.url)),
          remaining: summarizeServeStatus(after),
          ...(failures.length > 0 && { failures }),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
