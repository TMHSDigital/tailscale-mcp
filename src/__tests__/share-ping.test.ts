import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CliProvider, CliResult } from "../providers/cli.js";
import { registerAll } from "../tools/index.js";
import { boundedMap, PING_CONCURRENCY } from "../tools/ping.js";
import { fixture, mockRunner, okResult, payload, RunnerCall } from "./support.js";

async function connectedClient(provider: CliProvider): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerAll(server, { provider });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe("share_port", () => {
  it("defaults to tailnet-only Serve and never invokes funnel", async () => {
    const calls: RunnerCall[] = [];
    const client = await connectedClient(
      new CliProvider({
        runner: mockRunner(
          {
            serve: okResult(
              "Available within your tailnet:\n\nhttps://devpc.tail1234.ts.net/\n|-- proxy http://127.0.0.1:3000\n",
            ),
          },
          calls,
        ),
      }),
    );
    const result = await client.callTool({ name: "share_port", arguments: { port: 3000 } });
    const data = payload(result);
    expect(data.public).toBe(false);
    expect(data.scope).toContain("tailnet-only");
    expect(data.urls).toEqual(["https://devpc.tail1234.ts.net/"]);
    // Gating: the funnel subcommand must never appear in any invocation.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.args[0]).not.toBe("funnel");
    }
  });

  it("public=true uses funnel and flags the open-internet scope", async () => {
    const calls: RunnerCall[] = [];
    const client = await connectedClient(
      new CliProvider({
        runner: mockRunner(
          {
            funnel: okResult(
              "Available on the internet:\n\nhttps://devpc.tail1234.ts.net/\n|-- proxy http://127.0.0.1:3000\n",
            ),
          },
          calls,
        ),
      }),
    );
    const result = await client.callTool({
      name: "share_port",
      arguments: { port: 3000, public: true },
    });
    const data = payload(result);
    expect(data.public).toBe(true);
    expect(data.scope).toContain("OPEN INTERNET");
    expect(calls[0].args[0]).toBe("funnel");
  });

  it("maps serve-not-enabled to a structured SERVE_NOT_ENABLED error", async () => {
    const client = await connectedClient(
      new CliProvider({
        runner: mockRunner({
          serve: {
            status: 1,
            stdout: "Serve is not enabled on your tailnet.\nTo enable, visit:\n<url>",
            stderr: "",
          },
        }),
      }),
    );
    const result = await client.callTool({ name: "share_port", arguments: { port: 3000 } });
    expect(result.isError).toBe(true);
    expect(payload(result).error.code).toBe("SERVE_NOT_ENABLED");
  });

  it("warns about public exposure in the tool description", async () => {
    const client = await connectedClient(new CliProvider({ runner: mockRunner({}) }));
    const tools = await client.listTools();
    const share = tools.tools.find((t) => t.name === "share_port");
    expect(share?.description).toMatch(/OPEN INTERNET/i);
  });
});

describe("share_status / stop_share", () => {
  it("reports no active sessions for an empty serve config", async () => {
    // `{}` is what tailscale 1.102.3 prints for an empty config.
    const client = await connectedClient(
      new CliProvider({ runner: mockRunner({ "serve status --json": okResult("{}\n") }) }),
    );
    const data = payload(await client.callTool({ name: "share_status", arguments: {} }));
    expect(data).toEqual({ active: false, publicExposure: false, endpoints: [] });
  });

  it("lists endpoints with per-endpoint public flags and foreground sessions", async () => {
    const client = await connectedClient(
      new CliProvider({
        runner: mockRunner({ "serve status --json": okResult(fixture("serve-status.json")) }),
      }),
    );
    const data = payload(await client.callTool({ name: "share_status", arguments: {} }));
    expect(data.active).toBe(true);
    expect(data.publicExposure).toBe(true);
    const byUrl = Object.fromEntries(data.endpoints.map((e: any) => [e.url, e]));
    expect(Object.keys(byUrl).sort()).toEqual([
      "https://devpc.tail1234.ts.net/",
      "https://devpc.tail1234.ts.net/api",
      "https://devpc.tail1234.ts.net:10000/",
      "https://devpc.tail1234.ts.net:8443/docs",
    ]);
    expect(byUrl["https://devpc.tail1234.ts.net/api"]).toMatchObject({
      httpsPort: 443,
      path: "/api",
      target: "http://127.0.0.1:4000",
      targetType: "proxy",
      public: true,
      foreground: false,
    });
    expect(byUrl["https://devpc.tail1234.ts.net:8443/docs"]).toMatchObject({
      targetType: "path",
      public: false,
    });
    expect(byUrl["https://devpc.tail1234.ts.net:10000/"]).toMatchObject({
      targetType: "text",
      foreground: true,
    });
    expect(data.tcpForwards).toEqual([
      { port: 5432, target: "127.0.0.1:5432", public: false, foreground: false },
    ]);
  });

  it("falls back to text status on CLIs without serve status --json", async () => {
    const client = await connectedClient(
      new CliProvider({
        runner: mockRunner({
          "serve status --json": {
            status: 2,
            stdout: "",
            stderr: "flag provided but not defined: -json\n",
          },
          "serve status": okResult("https://devpc.tail1234.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:3000\n"),
        }),
      }),
    );
    const data = payload(await client.callTool({ name: "share_status", arguments: {} }));
    expect(data.active).toBe(true);
    expect(data.publicExposure).toBeNull();
    expect(data.status).toContain("proxy http://127.0.0.1:3000");
  });

  /**
   * A stateful stand-in for the daemon's serve config: share_port adds a
   * handler on :443, `--https=N [--set-path=P] off` removes one, `reset`
   * clears all, and `serve status --json` reports the current state.
   */
  function fakeServe(initial: Record<string, string> = {}) {
    const host = "devpc.tail1234.ts.net";
    const handlers = new Map(Object.entries(initial)); // "443/path" -> proxy
    const calls: RunnerCall[] = [];
    const runner = async (bin: string, args: string[]): Promise<CliResult> => {
      calls.push({ bin, args });
      const key = args.join(" ");
      if (key === "serve status --json") {
        const web: Record<string, { Handlers: Record<string, { Proxy: string }> }> = {};
        for (const [k, proxy] of handlers) {
          const [port, ...rest] = k.split("/");
          const hp = `${host}:${port}`;
          (web[hp] ??= { Handlers: {} }).Handlers[`/${rest.join("/")}`] = { Proxy: proxy };
        }
        return okResult(JSON.stringify(handlers.size ? { Web: web } : {}));
      }
      if (key === "serve reset") {
        handlers.clear();
        return okResult("");
      }
      const setPath = args.find((a) => a.startsWith("--set-path="))?.slice(11) ?? "/";
      if (args[args.length - 1] === "off") {
        const port = args.find((a) => a.startsWith("--https="))!.slice(8);
        handlers.delete(`${port}${setPath}`);
        return okResult("");
      }
      if (args[0] === "serve" && args[1] === "--bg") {
        handlers.set(`443${setPath}`, `http://127.0.0.1:${args[args.length - 1]}`);
        return okResult(`Available within your tailnet:\n\nhttps://${host}${setPath}\n`);
      }
      throw new Error(`fakeServe: unrouted ${key}`);
    };
    return { runner, calls, handlers };
  }

  const handLeft = { "443/": "http://127.0.0.1:8123" }; // e.g. a Home Assistant share

  it("stop_share with no arguments stops nothing and lists the active endpoints", async () => {
    const fake = fakeServe(handLeft);
    const client = await connectedClient(new CliProvider({ runner: fake.runner }));
    const result = await client.callTool({ name: "stop_share", arguments: {} });
    expect(result.isError).toBe(true);
    const err = payload(result).error;
    expect(err.code).toBe("TARGET_REQUIRED");
    expect(err.message).toContain("https://devpc.tail1234.ts.net/");
    expect(fake.handlers.size).toBe(1);
    expect(fake.calls.map((c) => c.args.join(" "))).toEqual(["serve status --json"]);
  });

  it("stop_share all=true resets everything and reports what was removed", async () => {
    const fake = fakeServe(handLeft);
    const client = await connectedClient(new CliProvider({ runner: fake.runner }));
    const data = payload(await client.callTool({ name: "stop_share", arguments: { all: true } }));
    expect(data.stopped).toBe("all");
    expect(data.removed.map((e: any) => e.url)).toEqual(["https://devpc.tail1234.ts.net/"]);
    expect(data.remaining.active).toBe(false);
    expect(fake.calls.map((c) => c.args.join(" "))).toContain("serve reset");
  });

  it("stop_share with httpsPort turns off that endpoint only", async () => {
    const fake = fakeServe({ ...handLeft, "443/api": "http://127.0.0.1:4000" });
    const client = await connectedClient(new CliProvider({ runner: fake.runner }));
    const data = payload(
      await client.callTool({ name: "stop_share", arguments: { httpsPort: 443 } }),
    );
    expect(fake.calls[1].args).toEqual(["serve", "--https=443", "off"]);
    expect(data.removed.map((e: any) => e.path)).toEqual(["/"]);
    expect(data.remaining.endpoints.map((e: any) => e.path)).toEqual(["/api"]);
  });

  it("round-trips a path-mounted share: share_port at /api, stop_share removes just /api", async () => {
    const fake = fakeServe(handLeft);
    const client = await connectedClient(new CliProvider({ runner: fake.runner }));
    await client.callTool({ name: "share_port", arguments: { port: 3000, path: "/api/" } });
    expect(fake.calls[0].args).toEqual(["serve", "--bg", "--set-path=/api", "3000"]);

    const data = payload(
      await client.callTool({ name: "stop_share", arguments: { path: "/api" } }),
    );
    expect(fake.calls[2].args).toEqual(["serve", "--https=443", "--set-path=/api", "off"]);
    expect(data.stopped).toEqual({ httpsPort: 443, path: "/api" });
    expect(data.removed.map((e: any) => e.url)).toEqual(["https://devpc.tail1234.ts.net/api"]);
  });

  it("stop_share mine=true stops only shares created in this session", async () => {
    const fake = fakeServe(handLeft);
    const client = await connectedClient(new CliProvider({ runner: fake.runner }));
    await client.callTool({ name: "share_port", arguments: { port: 3000, path: "/app" } });
    await client.callTool({ name: "share_port", arguments: { port: 4000, path: "/api" } });

    const data = payload(await client.callTool({ name: "stop_share", arguments: { mine: true } }));
    expect(data.stopped).toEqual([
      { httpsPort: 443, path: "/app" },
      { httpsPort: 443, path: "/api" },
    ]);
    expect(data.removed.map((e: any) => e.path).sort()).toEqual(["/api", "/app"]);
    // The hand-made share on "/" survives.
    expect(data.remaining.endpoints.map((e: any) => e.path)).toEqual(["/"]);

    // A second call has nothing left to stop.
    const again = payload(await client.callTool({ name: "stop_share", arguments: { mine: true } }));
    expect(again.stopped).toEqual([]);
  });

  it("stop_share rejects combining targets", async () => {
    const fake = fakeServe(handLeft);
    const client = await connectedClient(new CliProvider({ runner: fake.runner }));
    const result = await client.callTool({
      name: "stop_share",
      arguments: { all: true, httpsPort: 443 },
    });
    expect(payload(result).error.code).toBe("INVALID_ARGUMENTS");
    expect(fake.calls).toHaveLength(0);
  });

  it.each(["api", "", "/has space", "/q?x=1", "/../etc"])(
    "rejects invalid mount path %j at the schema without running the CLI",
    async (path) => {
      const calls: RunnerCall[] = [];
      const client = await connectedClient(
        new CliProvider({ runner: mockRunner({}, calls) }),
      );
      for (const name of ["share_port", "stop_share"]) {
        const result = await client.callTool({
          name,
          arguments: name === "share_port" ? { port: 3000, path } : { path },
        });
        // Either the SDK rejects the call (isError) or validation throws.
        expect(result.isError).toBe(true);
      }
      expect(calls).toHaveLength(0);
    },
  );
});

describe("ping_all", () => {
  function pingRouting(): (bin: string, args: string[]) => Promise<CliResult> {
    return async (_bin, args) => {
      const key = args.join(" ");
      if (key.startsWith("status --json")) return okResult(fixture("status-running.json"));
      if (key.startsWith("ping")) {
        const target = args[args.length - 1];
        if (target === "100.101.1.20") {
          return okResult("pong from raspi (100.101.1.20) via 192.168.1.20:41641 in 3ms\n");
        }
        if (target === "100.101.1.40") {
          return okResult("pong from exitbox (100.101.1.40) via DERP(fra) in 41ms\n");
        }
        return { status: 1, stdout: `ping "${target}" timed out\n`, stderr: "no reply\n" };
      }
      throw new Error(`unrouted: ${key}`);
    };
  }

  it("aggregates a matrix with direct, DERP, and unreachable rows", async () => {
    const client = await connectedClient(new CliProvider({ runner: pingRouting() }));
    const data = payload(
      await client.callTool({ name: "ping_all", arguments: { onlineOnly: false } }),
    );
    expect(data.pinged).toBe(3);
    expect(data.reachable).toBe(2);

    const byHost = Object.fromEntries(data.matrix.map((r: any) => [r.hostname, r]));
    expect(byHost.raspi).toMatchObject({ reachable: true, latencyMs: 3, path: "direct" });
    expect(byHost.exitbox).toMatchObject({
      reachable: true,
      latencyMs: 41,
      path: "derp",
      via: "fra",
    });
    expect(byHost.localhost).toMatchObject({ reachable: false, latencyMs: null });
  });

  it("defaults to online peers only", async () => {
    const client = await connectedClient(new CliProvider({ runner: pingRouting() }));
    const data = payload(await client.callTool({ name: "ping_all", arguments: {} }));
    expect(data.pinged).toBe(2);
    expect(data.matrix.every((r: any) => r.hostname !== "localhost")).toBe(true);
  });
});

describe("boundedMap", () => {
  it("never exceeds the concurrency limit and preserves order", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const results = await boundedMap(items, PING_CONCURRENCY, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return i * 2;
    });
    expect(peak).toBeLessThanOrEqual(PING_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
    expect(results).toEqual(items.map((i) => i * 2));
  });
});
