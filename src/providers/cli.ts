import { spawn } from "child_process";
import {
  BackendState,
  PingOptions,
  PingResult,
  ServeOptions,
  ServeResult,
  TailnetStatus,
  TailscaleError,
  TailscaleNode,
  TailscaleProvider,
  TailscaleVersion,
} from "./types.js";

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Process runner abstraction. Tests inject a mock so no real binary is ever
 * spawned. Must reject with an Error carrying `code: "ENOENT"` when the
 * binary does not exist (the default runner passes through the Node error).
 */
export type CliRunner = (
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number },
) => Promise<CliResult>;

export const WINDOWS_FALLBACK_BIN = "C:\\Program Files\\Tailscale\\tailscale.exe";

export function defaultCliRunner(
  bin: string,
  args: string[],
  opts?: { timeoutMs?: number },
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = opts?.timeoutMs
      ? setTimeout(() => {
          settled = true;
          child.kill();
          resolve({ status: 124, stdout, stderr: `${stderr}\n(timed out)` });
        }, opts.timeoutMs)
      : null;

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (!settled) reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (!settled) resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}

interface RawNode {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  TailscaleIPs?: string[] | null;
  Online?: boolean;
  LastSeen?: string;
  ExitNode?: boolean;
  ExitNodeOption?: boolean;
  Tags?: string[];
}

interface RawStatus {
  BackendState?: string;
  Health?: string[] | null;
  MagicDNSSuffix?: string;
  CurrentTailnet?: { Name?: string } | null;
  Self?: RawNode | null;
  Peer?: Record<string, RawNode> | null;
}

const ZERO_TIME = "0001-01-01T00:00:00Z";

function toNode(raw: RawNode): TailscaleNode {
  const ips = raw.TailscaleIPs ?? [];
  return {
    hostname: raw.HostName ?? "",
    dnsName: (raw.DNSName ?? "").replace(/\.$/, ""),
    ipv4: ips.find((ip) => !ip.includes(":")) ?? null,
    ipv6: ips.find((ip) => ip.includes(":")) ?? null,
    os: raw.OS ?? "",
    online: raw.Online ?? false,
    lastSeen: raw.LastSeen && raw.LastSeen !== ZERO_TIME ? raw.LastSeen : null,
    exitNode: raw.ExitNode ?? false,
    exitNodeOption: raw.ExitNodeOption ?? false,
    tags: raw.Tags ?? [],
  };
}

export interface CliProviderOptions {
  /** Explicit binary path; skips PATH resolution and the Windows fallback. */
  bin?: string;
  runner?: CliRunner;
  /** Platform override for tests (defaults to process.platform). */
  platform?: NodeJS.Platform;
}

export class CliProvider implements TailscaleProvider {
  private bin: string;
  private readonly explicitBin: boolean;
  private readonly runner: CliRunner;
  private readonly platform: NodeJS.Platform;

  constructor(opts: CliProviderOptions = {}) {
    this.bin = opts.bin ?? "tailscale";
    this.explicitBin = opts.bin !== undefined;
    this.runner = opts.runner ?? defaultCliRunner;
    this.platform = opts.platform ?? process.platform;
  }

  /**
   * Run the tailscale binary, resolving it from PATH with a Windows-aware
   * fallback to the default install location. Throws BINARY_NOT_FOUND when
   * neither resolves.
   */
  private async run(args: string[], opts?: { timeoutMs?: number }): Promise<CliResult> {
    try {
      return await this.runner(this.bin, args, opts);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      if (!this.explicitBin && this.platform === "win32" && this.bin === "tailscale") {
        try {
          const result = await this.runner(WINDOWS_FALLBACK_BIN, args, opts);
          this.bin = WINDOWS_FALLBACK_BIN;
          return result;
        } catch (fallbackErr) {
          if ((fallbackErr as NodeJS.ErrnoException).code !== "ENOENT") throw fallbackErr;
        }
      }
      throw new TailscaleError(
        "BINARY_NOT_FOUND",
        "The tailscale CLI was not found on PATH" +
          (this.platform === "win32" ? ` or at ${WINDOWS_FALLBACK_BIN}` : "") +
          ".",
        "Install Tailscale from https://tailscale.com/download and ensure `tailscale` is on PATH.",
      );
    }
  }

  private failFromBackendState(state: BackendState, health: string[]): TailscaleError | null {
    if (state === "Running") return null;
    if (state === "NeedsLogin") {
      return new TailscaleError(
        "NEEDS_LOGIN",
        "The Tailscale daemon is running but this device is not logged in to a tailnet.",
        "Run: tailscale up",
      );
    }
    // Stopped, NoState, Starting, and anything else non-running.
    const detail = health.length > 0 ? ` (health: ${health.join("; ")})` : "";
    return new TailscaleError(
      "DAEMON_NOT_RUNNING",
      `The Tailscale backend is not running (state: ${state})${detail}.`,
      "Run: tailscale up",
    );
  }

  private failFromCli(result: CliResult, context: string): TailscaleError {
    const stderr = result.stderr.trim();
    if (/failed to connect|is Tailscale running|not running/i.test(stderr)) {
      return new TailscaleError(
        "DAEMON_NOT_RUNNING",
        `The Tailscale daemon is not reachable (${stderr || "no daemon"}).`,
        "Start the Tailscale service, then run: tailscale up",
      );
    }
    return new TailscaleError(
      "CLI_ERROR",
      `tailscale ${context} failed (exit ${result.status}): ${stderr || result.stdout.trim()}`,
      "Check the reported error; run the command manually to reproduce.",
    );
  }

  async status(): Promise<TailnetStatus> {
    const result = await this.run(["status", "--json"]);
    if (result.status !== 0) throw this.failFromCli(result, "status");

    let raw: RawStatus;
    try {
      raw = JSON.parse(result.stdout) as RawStatus;
    } catch {
      throw new TailscaleError(
        "CLI_ERROR",
        "tailscale status --json returned unparseable output.",
        "Run `tailscale status --json` manually and check the output.",
      );
    }

    const state = raw.BackendState ?? "NoState";
    const health = raw.Health ?? [];
    const stateError = this.failFromBackendState(state, health);
    if (stateError) throw stateError;

    return {
      backendState: state,
      health,
      magicDNSSuffix: raw.MagicDNSSuffix ?? "",
      tailnet: raw.CurrentTailnet?.Name ?? "",
      self: toNode(raw.Self ?? {}),
      peers: Object.values(raw.Peer ?? {}).map(toNode),
    };
  }

  async version(): Promise<TailscaleVersion> {
    const result = await this.run(["version", "--json"]);
    if (result.status !== 0) throw this.failFromCli(result, "version");
    try {
      const raw = JSON.parse(result.stdout) as Partial<TailscaleVersion>;
      return {
        short: raw.short ?? "",
        long: raw.long ?? "",
        majorMinorPatch: raw.majorMinorPatch ?? "",
      };
    } catch {
      throw new TailscaleError(
        "CLI_ERROR",
        "tailscale version --json returned unparseable output.",
        "Run `tailscale version --json` manually and check the output.",
      );
    }
  }

  async ping(target: string, opts: PingOptions = {}): Promise<PingResult> {
    const count = opts.count ?? 1;
    const timeoutMs = opts.timeoutMs ?? 5000;
    // `tailscale ping` has no --json in current releases (verified on 1.98.4);
    // parse the text output.
    const result = await this.run(
      ["ping", "-c", String(count), "--timeout", `${timeoutMs}ms`, target],
      { timeoutMs: timeoutMs * count + 5000 },
    );
    const raw = `${result.stdout}\n${result.stderr}`.trim();

    // "pong from raspi (100.101.1.20) via 192.168.1.20:41641 in 3ms"
    // "pong from raspi (100.101.1.20) via DERP(nyc) in 41ms"
    const pong = /pong from \S+ \(([^)]+)\) via (DERP\(([^)]+)\)|\S+) in (\d+)ms/.exec(
      result.stdout,
    );
    if (pong) {
      const derp = pong[2].startsWith("DERP(");
      return {
        target,
        reachable: true,
        latencyMs: Number(pong[4]),
        path: derp ? "derp" : "direct",
        via: derp ? pong[3] : pong[2],
        raw,
      };
    }
    if (/timed out|no reply/i.test(raw) || result.status !== 0) {
      return { target, reachable: false, latencyMs: null, path: null, via: null, raw };
    }
    throw this.failFromCli(result, `ping ${target}`);
  }

  async serve(opts: ServeOptions): Promise<ServeResult> {
    const isPublic = opts.public === true;
    const subcmd = isPublic ? "funnel" : "serve";
    const args = [subcmd, "--bg"];
    if (opts.path && opts.path !== "/") args.push(`--set-path=${opts.path}`);
    args.push(String(opts.port));

    // On a tailnet without Serve/Funnel enabled the CLI prints an enablement
    // URL and then BLOCKS polling for enablement (observed on 1.98.4), so the
    // spawn needs a hard timeout and the message must be detected regardless
    // of exit status.
    const result = await this.run(args, { timeoutMs: 15000 });
    const combined = result.stdout + result.stderr;
    if (/not enabled on your tailnet|Funnel not available/i.test(combined)) {
      const enableUrl = /https:\/\/login\.tailscale\.com\/f\/\S+/.exec(combined)?.[0];
      throw new TailscaleError(
        "SERVE_NOT_ENABLED",
        `Tailscale ${subcmd} is not enabled on this tailnet.`,
        `Enable HTTPS/${subcmd} in the Tailscale admin console${enableUrl ? `: ${enableUrl}` : ""}, then retry.`,
      );
    }
    if (result.status !== 0) {
      throw this.failFromCli(result, subcmd);
    }

    const raw = `${result.stdout}\n${result.stderr}`.trim();
    const urls = [...raw.matchAll(/https?:\/\/\S+/g)]
      .map((m) => m[0].replace(/[.,]$/, ""))
      // The CLI also prints the local proxy target (http://127.0.0.1:<port>);
      // only the share endpoints belong in the result.
      .filter((u) => !/https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u));
    return { urls: [...new Set(urls)], public: isPublic, raw };
  }

  async serveStatus(): Promise<string> {
    const result = await this.run(["serve", "status"]);
    if (result.status !== 0) throw this.failFromCli(result, "serve status");
    return result.stdout.trim();
  }

  async serveReset(port?: number): Promise<string> {
    const args =
      port === undefined ? ["serve", "reset"] : ["serve", `--https=${port}`, "off"];
    const result = await this.run(args);
    if (result.status !== 0) throw this.failFromCli(result, "serve reset");
    return result.stdout.trim() || "serve configuration cleared";
  }
}
