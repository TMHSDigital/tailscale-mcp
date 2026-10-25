import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./index.js";
import type { PingPath, PingResult, TailscaleNode } from "../providers/types.js";
import { fail, ok } from "./helpers.js";

export const PING_CONCURRENCY = 5;

/** Wall-clock budget for one ping_all call; slower peers are reported, not awaited. */
export const PING_ALL_DEADLINE_MS = 45_000;

/**
 * Run tasks with bounded concurrency, preserving input order in the output.
 * Once `signal` aborts, tasks that have not started get `onSkip(item)`.
 */
export async function boundedMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  opts: { signal?: AbortSignal; onSkip?: (item: T) => R } = {},
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] =
        opts.signal?.aborted && opts.onSkip ? opts.onSkip(items[i]) : await fn(items[i]);
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
  path: PingPath | null;
  via: string | null;
  attempts: number;
  replies: number;
  /** Why the peer is unreachable when no ping result explains it. */
  error?: string;
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
    attempts: ping.attempts,
    replies: ping.replies,
  };
}

function unreachableRow(node: TailscaleNode, target: string, error: string): MatrixRow {
  return {
    hostname: node.hostname,
    dnsName: node.dnsName,
    target,
    reachable: false,
    latencyMs: null,
    path: null,
    via: null,
    attempts: 0,
    replies: 0,
    error,
  };
}

export function register(server: McpServer, ctx: ToolContext): void {
  const deadlineMs = ctx.pingAllDeadlineMs ?? PING_ALL_DEADLINE_MS;

  server.tool(
    "ping_all",
    "Ping tailnet peers concurrently (bounded to 5 at a time, with a per-ping timeout) " +
      "and return a latency matrix: node, latency ms of the settled path, path (direct, " +
      "DERP relay, or peer relay), or unreachable. Defaults to online peers only. The " +
      `whole call is capped at ${PING_ALL_DEADLINE_MS / 1000}s; peers not answered by ` +
      "then are reported with an error and timedOut is true.",
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
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), deadlineMs);
      try {
        const status = await ctx.provider.status();
        const targets = (onlineOnly ?? true)
          ? status.peers.filter((p) => p.online)
          : status.peers;

        const rows = await boundedMap(
          targets,
          PING_CONCURRENCY,
          async (node) => {
            const target = node.ipv4 ?? node.dnsName;
            if (!target) return unreachableRow(node, "", "no pingable address");
            try {
              return toRow(
                node,
                await ctx.provider.ping(target, { count, timeoutMs, signal: deadline.signal }),
              );
            } catch (err) {
              return unreachableRow(
                node,
                target,
                deadline.signal.aborted
                  ? "ping_all deadline reached before a reply"
                  : err instanceof Error
                    ? err.message
                    : String(err),
              );
            }
          },
          {
            signal: deadline.signal,
            onSkip: (node) =>
              unreachableRow(
                node,
                node.ipv4 ?? node.dnsName,
                "not pinged: ping_all deadline reached",
              ),
          },
        );

        return ok({
          pinged: rows.length,
          reachable: rows.filter((r) => r.reachable).length,
          timedOut: deadline.signal.aborted,
          matrix: rows,
        });
      } catch (err) {
        return fail(err);
      } finally {
        clearTimeout(timer);
      }
    },
  );
}
