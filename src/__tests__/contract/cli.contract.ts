// Contract tests: run CliProvider against the REAL tailscale binary on this
// machine and assert the parsing invariants that must hold whatever state the
// daemon is in. A failure here means the CLI's output drifted from what the
// parsers expect (wording, flags, JSON shape), not a bug in the mocks.
//
// Not part of `npm test`; run with `npm run test:contract`. The weekly
// contract.yml workflow runs it on Linux (daemon up, not logged in), macOS
// (CLI installed, daemon not started), Windows (service up, not logged in),
// and optionally on an ephemeral node joined to a CI tailnet.
//
// Read-only unless TAILSCALE_CONTRACT_MUTATE=1: the serve round trip changes
// the local Serve config, so it only runs on a throwaway CI node.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CliProvider } from "../../providers/cli.js";
import { TailscaleError, type TailnetStatus } from "../../providers/types.js";

type State = "running" | "needs-login" | "no-daemon";

const provider = new CliProvider({ timeoutMs: 30_000 });
const mutate = process.env.TAILSCALE_CONTRACT_MUTATE === "1";
let state: State;
let status: TailnetStatus | undefined;

/** Error codes a healthy parser may produce when the daemon is not usable. */
const NOT_RUNNING_CODES = ["NEEDS_LOGIN", "DAEMON_NOT_RUNNING"];

beforeAll(async () => {
  const version = await provider.version();
  try {
    status = await provider.status();
    state = "running";
  } catch (err) {
    // CLI_ERROR or an unexpected exception here means the CLI's error or
    // status output no longer matches what failFromCli/failFromBackendState
    // recognize: that is exactly the drift this suite exists to catch.
    if (!(err instanceof TailscaleError) || !NOT_RUNNING_CODES.includes(err.code)) throw err;
    state = err.code === "NEEDS_LOGIN" ? "needs-login" : "no-daemon";
  }
  console.log(`tailscale ${version.long || version.short}; daemon state: ${state}`);
});

describe("tailscale CLI contract", () => {
  it("version --json has the expected shape", async () => {
    const version = await provider.version();
    expect(version.short).toMatch(/^\d+\.\d+\.\d+/);
    expect(version.majorMinorPatch).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("status output maps to a known state (no CLI_ERROR)", () => {
    expect(["running", "needs-login", "no-daemon"]).toContain(state);
  });

  it("a missing binary maps to BINARY_NOT_FOUND", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "ts-contract-")), "tailscale");
    const err = await new CliProvider({ bin: missing }).status().catch((e: unknown) => e);
    expect((err as TailscaleError).code).toBe("BINARY_NOT_FOUND");
  });

  it("serve status --json parses, or fails with a known code", async () => {
    try {
      const serve = await provider.serveStatus();
      expect(serve.parsed).toBe(true);
      for (const e of serve.endpoints) {
        expect(e.url).toMatch(/^https?:\/\//);
        expect(e.path.startsWith("/")).toBe(true);
        expect(typeof e.public).toBe("boolean");
      }
    } catch (err) {
      // Only acceptable when the daemon is not usable, and only as a
      // recognized error.
      expect(state).not.toBe("running");
      expect(NOT_RUNNING_CODES).toContain((err as TailscaleError).code);
    }
  });

  describe("with a running, logged-in daemon", () => {
    // Conditional tests call ctx.skip() so the report shows what did not run
    // instead of a silent pass.
    it("status --json yields a well-formed self node and peers", (ctx) => {
      if (state !== "running") ctx.skip();
      const s = status!;
      expect(s.backendState).toBe("Running");
      expect(s.self.dnsName).toMatch(/\./);
      if (s.magicDNSSuffix) expect(s.self.dnsName.endsWith(s.magicDNSSuffix)).toBe(true);
      expect(s.self.ipv4 ?? s.self.ipv6).toBeTruthy();
      for (const p of s.peers) {
        expect(typeof p.hostname).toBe("string");
        expect(typeof p.online).toBe("boolean");
        expect(Array.isArray(p.tags)).toBe(true);
      }
    });

    it("ping output parses into a path and latency", async (ctx) => {
      const peer = status?.peers.find(
        (p) => p.online && p.ipv4 && !p.dnsName.endsWith(".mullvad.ts.net"),
      );
      if (state !== "running" || !peer) ctx.skip();
      const result = await provider.ping(peer!.ipv4!, { count: 3, timeoutMs: 3000 });
      expect(result.attempts).toBeGreaterThan(0);
      if (result.reachable) {
        // A reply that parsed into "unknown" means the pong format drifted.
        expect(["direct", "derp", "peer-relay"]).toContain(result.path);
        expect(typeof result.latencyMs).toBe("number");
        expect(result.replies).toBeGreaterThan(0);
      }
    });

    it.runIf(mutate)("serve round trip: share, see it in status, stop it", async (ctx) => {
      if (state !== "running") ctx.skip();
      const port = 39_017;
      const path = "/contract";
      try {
        const shared = await provider.serve({ port, path });
        expect(shared.urls.some((u) => u.endsWith(path))).toBe(true);
      } catch (err) {
        // HTTPS/Serve may simply not be enabled on the CI tailnet.
        expect((err as TailscaleError).code).toBe("SERVE_NOT_ENABLED");
        return;
      }
      const during = await provider.serveStatus();
      expect(during.endpoints.some((e) => e.path === path && e.target?.includes(String(port)))).toBe(true);
      await provider.serveReset(443, path);
      const after = await provider.serveStatus();
      expect(after.endpoints.some((e) => e.path === path)).toBe(false);
    });
  });
});
