import { describe, expect, it } from "vitest";
import { CliProvider, WINDOWS_FALLBACK_BIN } from "../providers/cli.js";
import { TailscaleError } from "../providers/types.js";
import { enoent, fixture, mockRunner, okResult, RunnerCall } from "./support.js";

describe("CliProvider.status", () => {
  it("parses a healthy tailnet into a trimmed view", async () => {
    const provider = new CliProvider({
      runner: mockRunner({ "status --json": okResult(fixture("status-running.json")) }),
    });
    const status = await provider.status();

    expect(status.backendState).toBe("Running");
    expect(status.tailnet).toBe("user@example.com");
    expect(status.magicDNSSuffix).toBe("tail1234.ts.net");
    expect(status.self.hostname).toBe("DEVPC");
    expect(status.self.dnsName).toBe("devpc.tail1234.ts.net");
    expect(status.self.ipv4).toBe("100.101.1.10");
    expect(status.self.ipv6).toBe("fd7a:115c:a1e0::aaaa:1");

    expect(status.peers).toHaveLength(3);
    const raspi = status.peers.find((p) => p.hostname === "raspi");
    expect(raspi).toMatchObject({
      dnsName: "raspi.tail1234.ts.net",
      ipv4: "100.101.1.20",
      os: "linux",
      online: true,
      exitNodeOption: true,
    });
    const exitbox = status.peers.find((p) => p.hostname === "exitbox");
    expect(exitbox?.tags).toEqual(["tag:server", "tag:exit"]);
    const phone = status.peers.find((p) => p.dnsName === "phone.tail1234.ts.net");
    expect(phone?.online).toBe(false);
    expect(phone?.lastSeen).toBe("2026-07-13T23:57:06.1Z");
  });

  it("maps a stopped daemon to DAEMON_NOT_RUNNING with the fix command", async () => {
    const provider = new CliProvider({
      runner: mockRunner({ "status --json": okResult(fixture("status-stopped.json")) }),
    });
    const err = await provider.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TailscaleError);
    expect((err as TailscaleError).code).toBe("DAEMON_NOT_RUNNING");
    expect((err as TailscaleError).remedy).toContain("tailscale up");
  });

  it("maps NeedsLogin to NEEDS_LOGIN", async () => {
    const provider = new CliProvider({
      runner: mockRunner({ "status --json": okResult(fixture("status-needs-login.json")) }),
    });
    const err = await provider.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TailscaleError);
    expect((err as TailscaleError).code).toBe("NEEDS_LOGIN");
    expect((err as TailscaleError).remedy).toContain("tailscale up");
  });

  it("maps an unreachable daemon (CLI error) to DAEMON_NOT_RUNNING", async () => {
    const provider = new CliProvider({
      runner: mockRunner({
        "status --json": {
          status: 1,
          stdout: "",
          stderr: "failed to connect to local Tailscale service; is Tailscale running?",
        },
      }),
    });
    const err = await provider.status().catch((e: unknown) => e);
    expect((err as TailscaleError).code).toBe("DAEMON_NOT_RUNNING");
  });

  it("throws BINARY_NOT_FOUND when the binary is missing everywhere", async () => {
    const provider = new CliProvider({
      runner: async () => {
        throw enoent();
      },
      platform: "linux",
    });
    const err = await provider.status().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TailscaleError);
    expect((err as TailscaleError).code).toBe("BINARY_NOT_FOUND");
  });

  it("falls back to the Program Files binary on Windows", async () => {
    const calls: RunnerCall[] = [];
    const runner = async (bin: string, args: string[]) => {
      calls.push({ bin, args });
      if (bin === "tailscale") throw enoent();
      return okResult(fixture("status-running.json"));
    };
    const provider = new CliProvider({ runner, platform: "win32" });
    const status = await provider.status();
    expect(status.backendState).toBe("Running");
    expect(calls.map((c) => c.bin)).toEqual(["tailscale", WINDOWS_FALLBACK_BIN]);

    // Subsequent calls go straight to the fallback path.
    await provider.status();
    expect(calls[calls.length - 1].bin).toBe(WINDOWS_FALLBACK_BIN);
  });

  it("surfaces unparseable status output as CLI_ERROR", async () => {
    const provider = new CliProvider({
      runner: mockRunner({ "status --json": okResult("not json at all") }),
    });
    const err = await provider.status().catch((e: unknown) => e);
    expect((err as TailscaleError).code).toBe("CLI_ERROR");
  });
});

describe("CliProvider.version", () => {
  it("parses version --json", async () => {
    const provider = new CliProvider({
      runner: mockRunner({ "version --json": okResult(fixture("version.json")) }),
    });
    const version = await provider.version();
    expect(version.short).toBe("1.98.4");
    expect(version.majorMinorPatch).toBe("1.98.4");
  });
});
