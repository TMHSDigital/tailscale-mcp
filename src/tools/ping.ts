import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./index.js";
import type { PingResult, TailscaleNode } from "../providers/types.js";
import { fail, ok } from "./helpers.js";

export const PING_CONCURRENCY = 5;

/** Run tasks with bounded concurrency, preserving input order in the output. */
export async function boundedMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface MatrixRow {
  hostname: string;
  dnsName: string;
  target: string;
  reachable: boolean;
  latencyMs: number | null;
  path: "direct" | "derp" | null;
  via: string | null;
}

function toRow(node: TailscaleNode, ping: PingResult): MatrixRow {
  return {
    hostname: node.hostname,
    dnsName: node.dnsName,
    target: ping.target,
    reachable: ping.reachable,
    latencyMs: ping.latencyMs,
    path: ping.path,
    via: ping.via,
  };
}

export function register(server: McpServer, ctx: ToolContext): void {
  server.tool(
    "ping_all",
    "Ping tailnet peers concurrently (bounded to 5 at a time, one ping each with a " +
      "timeout) and return a latency matrix: node, latency ms, path (direct vs DERP " +
      "relay), or unreachable. Defaults to online peers only.",
    {
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("Ping attempts per peer (default: 1)"),
      timeoutMs: z
        .number()
        .int()
        .min(100)
        .max(60000)
        .optional()
        .describe("Per-ping timeout in milliseconds (default: 5000)"),
      onlineOnly: z
        .boolean()
        .optional()
        .describe("Only ping peers reported online (default: true)"),
    },
    async ({ count, timeoutMs, onlineOnly }) => {
      try {
        const status = await ctx.provider.status();
        const targets = (onlineOnly ?? true)
          ? status.peers.filter((p) => p.online)
          : status.peers;

        const rows = await boundedMap(targets, PING_CONCURRENCY, async (node) => {
          const target = node.ipv4 ?? node.dnsName;
          if (!target) {
            return toRow(node, {
              target: "",
              reachable: false,
              latencyMs: null,
              path: null,
              via: null,
              raw: "no pingable address",
            });
          }
          try {
            return toRow(node, await ctx.provider.ping(target, { count, timeoutMs }));
          } catch {
            return toRow(node, {
              target,
              reachable: false,
              latencyMs: null,
              path: null,
              via: null,
              raw: "ping failed",
            });
          }
        });

        return ok({
          pinged: rows.length,
          reachable: rows.filter((r) => r.reachable).length,
          matrix: rows,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
