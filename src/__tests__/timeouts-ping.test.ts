import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CliProvider,
  CliResult,
  CliRunner,
  defaultCliRunner,
  parseGoDurationMs,
  parsePongs,
} from "../providers/cli.js";
import { TailscaleError } from "../providers/types.js";
import { registerAll, ToolContext } from "../tools/index.js";
import { boundedMap } from "../tools/ping.js";
import { fixture, okResult, payload } from "./support.js";

/** A runner that never settles, even when aborted. */
const hangingRunner: CliRunner = () => new Promise<CliResult>(() => {});

/** A runner that settles only when its signal aborts, with `partial` as output. */
function abortableRunner(partial = ""): CliRunner {
  return (_bin, _args, opts) =>
    new Promise<CliResult>((resolve) => {
      opts?.signal?.addEventListener("abort", () =>
        resolve({ status: 124, stdout: partial, stderr: "", timedOut: true }),
      );
    });
}

async function connectedClient(ctx: ToolContext): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerAll(server, ctx);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("CLI call timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps a runner that honors the abort to a structured TIMEOUT", async () => {
    const provider = new CliProvider({ runner: abortableRunner(), timeoutMs: 50 });
    const err = (await provider.status().catch((e: unknown) => e)) as TailscaleError;
    expect(err).toBeInstanceOf(TailscaleError);
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toContain("50ms");
    expect(err.remedy).toContain("TAILSCALE_MCP_TIMEOUT_MS");
  });

  it("still returns TIMEOUT when the runner never settles", async () => {
    vi.useFakeTimers();
    const provider = new CliProvider({ runner: hangingRunner, timeoutMs: 1000 });
    const pending = provider.status().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(3100);
    const err = (await pending) as TailscaleError;
    expect(err.code).toBe("TIMEOUT");
  });

  it("detects serve-not-enabled in the partial output of a blocked serve", async () => {
    vi.useFakeTimers();
    const provider = new CliProvider({
      runner: abortableRunner(
        "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n  https://login.tailscale.com/f/serve?node=abc\n",
      ),
    });
    const pending = provider.serve({ port: 3000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    const err = (await pending) as TailscaleError;
    expect(err.code).toBe("SERVE_NOT_ENABLED");
    expect(err.remedy).toContain("https://login.tailscale.com/f/serve?node=abc");
  });

  it("defaultCliRunner kills a real process when the signal aborts", async () => {
    const controller = new AbortController();
    const started = Date.now();
    // Leave node enough time to start and write before aborting.
    setTimeout(() => controller.abort(), 1500);
    const result = await defaultCliRunner(
      process.execPath,
      ["-e", "process.stdout.write('partial'); setTimeout(() => {}, 30000)"],
      { signal: controller.signal },
    );
    expect(result.timedOut).toBe(true);
    expect(result.stdout).toBe("partial");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("ping parsing", () => {
  it("parses Go durations, including sub-millisecond and seconds forms", () => {
    expect(parseGoDurationMs("3ms")).toBe(3);
    expect(parseGoDurationMs("0s")).toBe(0);
    expect(parseGoDurationMs("1.234s")).toBe(1234);
    expect(parseGoDurationMs("1m2.5s")).toBe(62_500);
    expect(parseGoDurationMs("850µs")).toBe(0.85);
    expect(parseGoDurationMs("soon")).toBeNull();
  });

  it("reports the settled path after a DERP -> direct upgrade", async () => {
    const out = [
      "pong from raspi (100.101.1.20) via DERP(nyc) in 41ms",
      "pong from raspi (100.101.1.20) via DERP(nyc) in 38ms",
      "pong from raspi (100.101.1.20) via 192.168.1.20:41641 in 3ms",
      "",
    ].join("\n");
    const provider = new CliProvider({ runner: async () => okResult(out) });
    const result = await provider.ping("100.101.1.20", { count: 3 });
    expect(result).toMatchObject({
      reachable: true,
      path: "direct",
      via: "192.168.1.20:41641",
      latencyMs: 3,
      attempts: 3,
      replies: 3,
    });
  });

  it("never labels a peer relay as direct", () => {
    const [pong] = parsePongs(
      "pong from raspi (100.101.1.20) via peer-relay(198.51.100.7:7777:vni:12) in 9ms\n",
    );
    expect(pong).toEqual({ latencyMs: 9, path: "peer-relay", via: "198.51.100.7:7777:vni:12" });
  });

  it("handles IPv6 endpoints, the peerapi port suffix, and unknown ping types", () => {
    const pongs = parsePongs(
      [
        "pong from box (100.101.1.30, 41000) via [2001:db8::1]:41641 in 0s",
        "pong from box (100.101.1.30) via TSMP in 2ms",
      ].join("\n"),
    );
    expect(pongs).toEqual([
      { latencyMs: 0, path: "direct", via: "[2001:db8::1]:41641" },
      { latencyMs: 2, path: "unknown", via: "TSMP" },
    ]);
  });

  it("counts timed-out attempts and stays reachable when DERP-only exits non-zero", async () => {
    // With the default --until-direct, a DERP-only run exits 1 with
    // "direct connection not established" even though replies arrived.
    const provider = new CliProvider({
      runner: async () => ({
        status: 1,
        stdout:
          'ping "100.101.1.40" timed out\npong from exitbox (100.101.1.40) via DERP(fra) in 41ms\n',
        stderr: "direct connection not established\n",
      }),
    });
    const result = await provider.ping("100.101.1.40", { count: 2 });
    expect(result).toMatchObject({ reachable: true, path: "derp", attempts: 2, replies: 1 });
  });
});

describe("ping_all deadline", () => {
  it("returns partial results with timedOut when the deadline passes", async () => {
    const runner: CliRunner = async (bin, args, opts) => {
      if (args[0] === "status") return okResult(fixture("status-running.json"));
      if (args[args.length - 1] === "100.101.1.20") {
        return okResult("pong from raspi (100.101.1.20) via 192.168.1.20:41641 in 3ms\n");
      }
      return abortableRunner()(bin, args, opts);
    };
    const client = await connectedClient({
      provider: new CliProvider({ runner }),
      pingAllDeadlineMs: 100,
    });
    const data = payload(
      await client.callTool({ name: "ping_all", arguments: { onlineOnly: false } }),
    );
    expect(data.timedOut).toBe(true);
    expect(data.pinged).toBe(3);
    expect(data.reachable).toBe(1);
    const slow = data.matrix.filter((r: { reachable: boolean }) => !r.reachable);
    expect(slow).toHaveLength(2);
    for (const row of slow) expect(row.error).toMatch(/deadline/);
  });

  it("boundedMap skips tasks that have not started once the signal aborts", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const results = await boundedMap(
      [1, 2, 3, 4],
      1,
      async (n) => {
        started.push(n);
        if (n === 2) controller.abort();
        return `ran ${n}`;
      },
      { signal: controller.signal, onSkip: (n) => `skipped ${n}` },
    );
    expect(started).toEqual([1, 2]);
    expect(results).toEqual(["ran 1", "ran 2", "skipped 3", "skipped 4"]);
  });
});
