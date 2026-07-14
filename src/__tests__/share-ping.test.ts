import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CliProvider, CliResult } from "../providers/cli.js";
import { registerAll } from "../tools/index.js";
import { boundedMap, PING_CONCURRENCY } from "../tools/ping.js";
import { fixture, mockRunner, okResult, RunnerCall } from "./support.js";

async function connectedClient(provider: CliProvider): Promise<Client> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerAll(server, { provider });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

function payload(result: { content?: unknown }): Record<string, any> {
  const content = result.content as Array<{ text: string }>;
  return JSON.parse(content[0].text);
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
    const client = await connectedClient(
      new CliProvider({
        runner: mockRunner({ "serve status": okResult("No serve config\n") }),
      }),
    );
    const data = payload(await client.callTool({ name: "share_status", arguments: {} }));
    expect(data.active).toBe(false);
  });

  it("stop_share without port resets everything", async () => {
    const calls: RunnerCall[] = [];
    const client = await connectedClient(
      new CliProvider({ runner: mockRunner({ "serve reset": okResult("") }, calls) }),
    );
    const data = payload(await client.callTool({ name: "stop_share", arguments: {} }));
    expect(data.stopped).toBe("all");
    expect(calls[0].args).toEqual(["serve", "reset"]);
  });

  it("stop_share with httpsPort turns off that endpoint only", async () => {
    const calls: RunnerCall[] = [];
    const client = await connectedClient(
      new CliProvider({ runner: mockRunner({ serve: okResult("") }, calls) }),
    );
    await client.callTool({ name: "stop_share", arguments: { httpsPort: 443 } });
    expect(calls[0].args).toEqual(["serve", "--https=443", "off"]);
  });
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
