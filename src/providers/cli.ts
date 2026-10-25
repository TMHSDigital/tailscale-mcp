import { spawn } from "child_process";
import {
  BackendState,
  DEFAULT_HTTPS_PORT,
  PingOptions,
  PingPath,
  PingResult,
  ServeEndpoint,
  ServeOptions,
  ServeResult,
  ServeStatus,
  TcpForward,
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
  /** True when the process was killed because the call's signal aborted. */
  timedOut?: boolean;
}

/**
 * Process runner abstraction. Tests inject a mock so no real binary is ever
 * spawned. Must reject with an Error carrying `code: "ENOENT"` when the
 * binary does not exist (the default runner passes through the Node error).
 * When `signal` aborts, it should kill the process and resolve with the
 * output collected so far and `timedOut: true`; CliProvider enforces its
 * own hard deadline in case a runner ignores the signal.
 */
export type CliRunner = (
  bin: string,
  args: string[],
  opts?: { signal?: AbortSignal },
) => Promise<CliResult>;

export const WINDOWS_FALLBACK_BIN = "C:\\Program Files\\Tailscale\\tailscale.exe";

/**
 * The CLI inside the macOS app bundle (Mac App Store and standalone
 * installs), which is not on PATH by default.
 */
export const MACOS_APP_BIN = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/**
 * Install locations tried in order when `tailscale` is not on PATH. MCP
 * clients such as Claude Desktop launch servers with a minimal PATH, so the
 * Homebrew prefixes are often missing too.
 */
export const FALLBACK_BINS: Partial<Record<NodeJS.Platform, string[]>> = {
  win32: [WINDOWS_FALLBACK_BIN],
  darwin: [MACOS_APP_BIN, "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"],
};

/** Env var that overrides binary resolution with an explicit path. */
export const BIN_ENV_VAR = "TAILSCALE_MCP_BIN";

/** Env var that overrides the default per-call timeout (milliseconds). */
export const TIMEOUT_ENV_VAR = "TAILSCALE_MCP_TIMEOUT_MS";

/** Default per-call timeout for CLI invocations. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Extra time a runner gets to honor an abort before the call is abandoned. */
const ABORT_GRACE_MS = 2_000;

export function defaultCliRunner(
  bin: string,
  args: string[],
  opts?: { signal?: AbortSignal },
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const signal = opts?.signal;
    if (signal?.aborted) {
      resolve({ status: 124, stdout: "", stderr: "", timedOut: true });
      return;
    }
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ status: 124, stdout, stderr, timedOut: true });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => signal?.removeEventListener("abort", onAbort);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      done();
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.on("close", (code) => {
      done();
      if (!settled) {
        settled = true;
        resolve({ status: code ?? 1, stdout, stderr });
      }
    });
  });
}

interface RunOptions {
  /** Overrides the provider's default timeout for this call. */
  timeoutMs?: number;
  /** Caller cancellation (e.g. ping_all's overall deadline). */
  signal?: AbortSignal;
  /**
   * Return a timed-out result instead of throwing TIMEOUT, for callers that
   * inspect partial output (serve prints its enablement URL, then blocks).
   */
  allowTimeout?: boolean;
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
  ShareeNode?: boolean;
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
    sharee: raw.ShareeNode ?? false,
  };
}

const DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  "μs": 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/** Parse a Go time.Duration string ("3ms", "0s", "1.234s", "1m2.5s") into milliseconds. */
export function parseGoDurationMs(text: string): number | null {
  if (text === "0") return 0;
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join("") !== text) return null;
  const ms = parts.reduce((sum, p) => sum + Number(p[1]) * DURATION_UNIT_MS[p[2]], 0);
  return Math.round(ms * 1000) / 1000;
}

interface Pong {
  latencyMs: number | null;
  path: PingPath;
  via: string;
}

/**
 * Parse every pong line of `tailscale ping` output. The CLI prints
 * `pong from <name> (<ip>[, <peerapi port>]) via <via> in <duration>` where
 * <via> is an "ip:port" endpoint (direct), "DERP(<region>)", or
 * "peer-relay(<relay>)" (cmd/tailscale/cli/ping.go).
 */
export function parsePongs(stdout: string): Pong[] {
  const pongs: Pong[] = [];
  for (const m of stdout.matchAll(/^pong from \S+ \([^)]*\) via (.+) in (\S+)$/gm)) {
    const via = m[1];
    const latencyMs = parseGoDurationMs(m[2]);
    const wrapped = /^(DERP|peer-relay)\((.*)\)$/.exec(via);
    if (wrapped) {
      pongs.push({ latencyMs, path: wrapped[1] === "DERP" ? "derp" : "peer-relay", via: wrapped[2] });
    } else if (/^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:.%\w]+\]):\d+$/.test(via)) {
      pongs.push({ latencyMs, path: "direct", via });
    } else {
      // e.g. "TSMP"/"ICMP" for non-disco ping types.
      pongs.push({ latencyMs, path: "unknown", via });
    }
  }
  return pongs;
}

// Mirrors ipn.ServeConfig as printed by `tailscale serve status --json`
// (ipn/serve.go): Web is keyed "$SNI_NAME:$PORT" with handlers keyed by
// mount point, AllowFunnel by the same host:port, TCP by port number.
interface RawHttpHandler {
  Proxy?: string;
  Path?: string;
  Text?: string;
  Redirect?: string;
}

interface RawServeConfig {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string } | null>;
  Web?: Record<string, { Handlers?: Record<string, RawHttpHandler | null> } | null>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, RawServeConfig | null>;
}

function handlerTarget(h: RawHttpHandler): Pick<ServeEndpoint, "target" | "targetType"> {
  if (h.Proxy) return { target: h.Proxy, targetType: "proxy" };
  if (h.Path) return { target: h.Path, targetType: "path" };
  if (h.Text !== undefined) return { target: h.Text, targetType: "text" };
  if (h.Redirect) return { target: h.Redirect, targetType: "redirect" };
  return { target: null, targetType: "unknown" };
}

/** Flatten a serve config (including foreground sessions) into endpoint rows. */
export function flattenServeConfig(
  config: RawServeConfig,
  foreground = false,
): Pick<ServeStatus, "endpoints" | "tcpForwards"> {
  const endpoints: ServeEndpoint[] = [];
  const tcpForwards: TcpForward[] = [];
  const funnel = config.AllowFunnel ?? {};

  for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
    const sep = hostPort.lastIndexOf(":");
    const host = hostPort.slice(0, sep);
    const port = Number(hostPort.slice(sep + 1));
    const scheme = config.TCP?.[String(port)]?.HTTP ? "http" : "https";
    const defaultPort = scheme === "https" ? 443 : 80;
    for (const [path, handler] of Object.entries(web?.Handlers ?? {})) {
      endpoints.push({
        url: `${scheme}://${host}${port === defaultPort ? "" : `:${port}`}${path}`,
        host,
        httpsPort: port,
        scheme,
        path,
        ...handlerTarget(handler ?? {}),
        public: funnel[hostPort] === true,
        foreground,
      });
    }
  }

  for (const [port, handler] of Object.entries(config.TCP ?? {})) {
    if (!handler?.TCPForward) continue;
    tcpForwards.push({
      port: Number(port),
      target: handler.TCPForward,
      public: Object.entries(funnel).some(([hp, on]) => on && hp.endsWith(`:${port}`)),
      foreground,
    });
  }

  for (const session of Object.values(config.Foreground ?? {})) {
    if (!session) continue;
    const nested = flattenServeConfig(session, true);
    endpoints.push(...nested.endpoints);
    tcpForwards.push(...nested.tcpForwards);
  }
  return { endpoints, tcpForwards };
}

export interface CliProviderOptions {
  /** Explicit binary path; skips PATH resolution and the platform fallbacks. */
  bin?: string;
  runner?: CliRunner;
  /** Platform override for tests (defaults to process.platform). */
  platform?: NodeJS.Platform;
  /** Default per-call timeout in milliseconds (default: DEFAULT_TIMEOUT_MS). */
  timeoutMs?: number;
}

export class CliProvider implements TailscaleProvider {
  private bin: string;
  private readonly explicitBin: boolean;
  private readonly runner: CliRunner;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;

  constructor(opts: CliProviderOptions = {}) {
    this.bin = opts.bin ?? "tailscale";
    this.explicitBin = opts.bin !== undefined;
    this.runner = opts.runner ?? defaultCliRunner;
    this.platform = opts.platform ?? process.platform;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Run the tailscale binary with a bounded wall-clock time. The runner is
   * asked to stop via an AbortSignal at the deadline; if it does not settle
   * within a short grace period the call is abandoned anyway. Throws TIMEOUT
   * unless `allowTimeout` is set.
   */
  private async run(args: string[], opts: RunOptions = {}): Promise<CliResult> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    opts.signal?.addEventListener("abort", cancel, { once: true });
    if (opts.signal?.aborted) controller.abort();
    const timer = setTimeout(cancel, timeoutMs);
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    const hardDeadline = new Promise<CliResult>((resolve) => {
      hardTimer = setTimeout(
        () => resolve({ status: 124, stdout: "", stderr: "", timedOut: true }),
        timeoutMs + ABORT_GRACE_MS,
      );
    });

    try {
      const result = await Promise.race([
        this.resolveAndRun(args, controller.signal),
        hardDeadline,
      ]);
      if (result.timedOut && !opts.allowTimeout) {
        throw this.timeoutError(args, timeoutMs, opts.signal?.aborted === true);
      }
      return result;
    } finally {
      clearTimeout(timer);
      clearTimeout(hardTimer);
      opts.signal?.removeEventListener("abort", cancel);
    }
  }

  private timeoutError(args: string[], timeoutMs: number, cancelled: boolean): TailscaleError {
    const cmd = `tailscale ${args.join(" ")}`;
    return new TailscaleError(
      "TIMEOUT",
      cancelled
        ? `${cmd} was cancelled before it finished.`
        : `${cmd} did not finish within ${timeoutMs}ms.`,
      `Run \`tailscale status\` manually to check the daemon; restart the Tailscale ` +
        `service if it hangs. Raise the limit with ${TIMEOUT_ENV_VAR} if the tailnet is slow.`,
    );
  }

  /**
   * Resolve the tailscale binary from PATH with a fallback to the platform's
   * default install locations. The first location that resolves is
   * remembered. Throws BINARY_NOT_FOUND when none resolves.
   */
  private async resolveAndRun(args: string[], signal: AbortSignal): Promise<CliResult> {
    const opts = { signal };
    try {
      return await this.runner(this.bin, args, opts);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      if (this.explicitBin) {
        throw new TailscaleError(
          "BINARY_NOT_FOUND",
          `The tailscale CLI was not found at ${this.bin}.`,
          `Check the path configured via ${BIN_ENV_VAR}, or unset it to search PATH.`,
        );
      }
      const fallbacks = this.bin === "tailscale" ? (FALLBACK_BINS[this.platform] ?? []) : [];
      for (const candidate of fallbacks) {
        if (signal.aborted) break;
        try {
          const result = await this.runner(candidate, args, opts);
          this.bin = candidate;
          return result;
        } catch (fallbackErr) {
          if ((fallbackErr as NodeJS.ErrnoException).code !== "ENOENT") throw fallbackErr;
        }
      }
      if (signal.aborted) return { status: 124, stdout: "", stderr: "", timedOut: true };
      throw new TailscaleError(
        "BINARY_NOT_FOUND",
        "The tailscale CLI was not found on PATH" +
          (fallbacks.length > 0 ? ` or at ${fallbacks.join(", ")}` : "") +
          ".",
        this.platform === "darwin"
          ? "Install Tailscale from https://tailscale.com/download. If it is installed, set " +
            `${BIN_ENV_VAR} to the CLI path (for the app: ${MACOS_APP_BIN}).`
          : "Install Tailscale from https://tailscale.com/download and ensure `tailscale` is " +
            `on PATH, or set ${BIN_ENV_VAR} to the CLI path.`,
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
    const combined = `${stderr}\n${result.stdout}`;
    if (/access denied|permission denied/i.test(combined)) {
      return new TailscaleError(
        "PERMISSION_DENIED",
        `tailscale ${context} was denied: ${(stderr || result.stdout.trim()).split("\n")[0]}`,
        this.platform === "linux"
          ? "Allow your user to manage Tailscale without sudo: sudo tailscale set --operator=$USER"
          : "Run the MCP server as a user allowed to change Tailscale settings.",
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
    // parse the text output. The CLI sleeps 1s between attempts.
    const result = await this.run(
      ["ping", "-c", String(count), "--timeout", `${timeoutMs}ms`, target],
      { timeoutMs: (timeoutMs + 1000) * count + 5000, signal: opts.signal },
    );
    const raw = `${result.stdout}\n${result.stderr}`.trim();
    const pongs = parsePongs(result.stdout);
    const timeouts = (result.stdout.match(/^ping "[^"]*" timed out$/gm) ?? []).length;
    const attempts = pongs.length + timeouts;

    // The CLI keeps pinging (usually over DERP) until a direct path comes up,
    // so the last pong is the settled path.
    const last = pongs[pongs.length - 1];
    if (last) {
      return {
        target,
        reachable: true,
        latencyMs: last.latencyMs,
        path: last.path,
        via: last.via,
        attempts,
        replies: pongs.length,
        raw,
      };
    }
    if (/timed out|no reply/i.test(raw) || result.status !== 0) {
      return {
        target,
        reachable: false,
        latencyMs: null,
        path: null,
        via: null,
        attempts,
        replies: 0,
        raw,
      };
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
    // of exit status, including in the partial output of a timed-out call.
    const timeoutMs = 15000;
    const result = await this.run(args, { timeoutMs, allowTimeout: true });
    const combined = result.stdout + result.stderr;
    if (/not enabled on your tailnet|Funnel not available/i.test(combined)) {
      const enableUrl = /https:\/\/login\.tailscale\.com\/f\/\S+/.exec(combined)?.[0];
      throw new TailscaleError(
        "SERVE_NOT_ENABLED",
        `Tailscale ${subcmd} is not enabled on this tailnet.`,
        `Enable HTTPS/${subcmd} in the Tailscale admin console${enableUrl ? `: ${enableUrl}` : ""}, then retry.`,
      );
    }
    if (result.timedOut) throw this.timeoutError(args, timeoutMs, false);
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

  async serveStatus(): Promise<ServeStatus> {
    const result = await this.run(["serve", "status", "--json"]);
    if (result.status !== 0) {
      // CLIs predating `serve status --json` reject the flag; fall back to text.
      if (/flag provided but not defined/i.test(result.stderr)) {
        const text = await this.run(["serve", "status"]);
        if (text.status !== 0) throw this.failFromCli(text, "serve status");
        return { endpoints: [], tcpForwards: [], parsed: false, raw: text.stdout.trim() };
      }
      throw this.failFromCli(result, "serve status");
    }
    const raw = result.stdout.trim();
    let config: RawServeConfig;
    try {
      config = raw === "" ? {} : (JSON.parse(raw) as RawServeConfig);
    } catch {
      throw new TailscaleError(
        "CLI_ERROR",
        "tailscale serve status --json returned unparseable output.",
        "Run `tailscale serve status --json` manually and check the output.",
      );
    }
    return { ...flattenServeConfig(config), parsed: true, raw };
  }

  async serveReset(port?: number, path?: string): Promise<string> {
    const args =
      port === undefined && path === undefined
        ? ["serve", "reset"]
        : [
            "serve",
            `--https=${port ?? DEFAULT_HTTPS_PORT}`,
            ...(path && path !== "/" ? [`--set-path=${path}`] : []),
            "off",
          ];
    const result = await this.run(args);
    if (result.status !== 0) throw this.failFromCli(result, "serve reset");
    return result.stdout.trim() || "serve configuration cleared";
  }
}
