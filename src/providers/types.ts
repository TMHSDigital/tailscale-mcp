// Provider contract for talking to a local Tailscale daemon.
//
// v0.1 ships a single implementation (CliProvider, which shells out to the
// `tailscale` binary). The interface leaves room for a future LocalAPI
// provider speaking HTTP over the local socket / named pipe.

export type BackendState =
  | "Running"
  | "Stopped"
  | "NeedsLogin"
  | "NoState"
  | "Starting"
  | string;

export interface TailscaleNode {
  hostname: string;
  /** MagicDNS name without the trailing dot, e.g. "raspi.tail1234.ts.net". */
  dnsName: string;
  ipv4: string | null;
  ipv6: string | null;
  os: string;
  online: boolean;
  /** RFC3339 timestamp, or null when the daemon reports the zero time. */
  lastSeen: string | null;
  /** True when the node is currently acting as this device's exit node. */
  exitNode: boolean;
  /** True when the node offers itself as an exit node. */
  exitNodeOption: boolean;
  tags: string[];
  /**
   * True when the node is in the netmap only because it belongs to a user
   * this node is shared with (it may connect to us, but is not ours).
   */
  sharee: boolean;
}

export interface TailnetStatus {
  backendState: BackendState;
  /** Health messages reported by the daemon (empty when healthy). */
  health: string[];
  magicDNSSuffix: string;
  tailnet: string;
  self: TailscaleNode;
  peers: TailscaleNode[];
}

export interface TailscaleVersion {
  short: string;
  long: string;
  majorMinorPatch: string;
}

export interface PingOptions {
  /** Number of ping attempts (maps to `tailscale ping -c`). */
  count?: number;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
  /** Cancels the ping (the process is killed and TIMEOUT is thrown). */
  signal?: AbortSignal;
}

/**
 * How a reply travelled: "direct" peer-to-peer, relayed through a Tailscale
 * "derp" server, relayed through a "peer-relay" node, or "unknown" (e.g.
 * TSMP/ICMP ping types that do not report a path).
 */
export type PingPath = "direct" | "derp" | "peer-relay" | "unknown";

export interface PingResult {
  target: string;
  reachable: boolean;
  /** Latency of the last reply, i.e. on the settled path. */
  latencyMs: number | null;
  /** Path of the last reply; null when unreachable. */
  path: PingPath | null;
  /** The endpoint, DERP region, or peer relay the last reply came through. */
  via: string | null;
  /** Pings sent (replies plus timed-out attempts). */
  attempts: number;
  /** Replies received. */
  replies: number;
  /** Raw CLI output, for diagnostics. */
  raw: string;
}

/** The HTTPS port Serve/Funnel use when none is given. */
export const DEFAULT_HTTPS_PORT = 443;

export interface ServeOptions {
  /** Local port to share. */
  port: number;
  /** Expose publicly via Funnel instead of tailnet-only Serve. */
  public?: boolean;
  /** HTTPS mount path (defaults to "/"). */
  path?: string;
}

export interface ServeResult {
  /** URLs the share is reachable at. */
  urls: string[];
  public: boolean;
  raw: string;
}

/** One HTTP(S) mount in the serve config. */
export interface ServeEndpoint {
  url: string;
  /** The SNI name the endpoint is served under (this node's MagicDNS name). */
  host: string;
  /** The serve port (443 unless set with --https / --http). */
  httpsPort: number;
  scheme: "https" | "http";
  /** Mount path, e.g. "/" or "/api". */
  path: string;
  /** What the mount serves: proxy URL, file path, text, or redirect target. */
  target: string | null;
  targetType: "proxy" | "path" | "text" | "redirect" | "unknown";
  /** True when Funnel exposes this endpoint to the public internet. */
  public: boolean;
  /** True for a foreground `tailscale serve` session (not --bg). */
  foreground: boolean;
}

/** A raw TCP forward (`tailscale serve --tcp`). */
export interface TcpForward {
  port: number;
  target: string;
  public: boolean;
  foreground: boolean;
}

export interface ServeStatus {
  endpoints: ServeEndpoint[];
  tcpForwards: TcpForward[];
  /** False when only the text form of `serve status` was available. */
  parsed: boolean;
  /** Raw CLI output, for diagnostics. */
  raw: string;
}

export interface TailscaleProvider {
  status(): Promise<TailnetStatus>;
  ping(target: string, opts?: PingOptions): Promise<PingResult>;
  serve(opts: ServeOptions): Promise<ServeResult>;
  serveStatus(): Promise<ServeStatus>;
  /**
   * With no arguments, clear the entire serve config. Otherwise turn off the
   * mount at `path` (default "/") on HTTPS port `port` (default 443).
   */
  serveReset(port?: number, path?: string): Promise<string>;
  version(): Promise<TailscaleVersion>;
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

export type TailscaleErrorCode =
  | "BINARY_NOT_FOUND"
  | "DAEMON_NOT_RUNNING"
  | "NEEDS_LOGIN"
  | "SERVE_NOT_ENABLED"
  | "PERMISSION_DENIED"
  | "TIMEOUT"
  | "INVALID_ARGUMENTS"
  | "TARGET_REQUIRED"
  | "FUNNEL_DISABLED"
  | "READ_ONLY"
  | "SSH_CONFIG_MARKERS_CORRUPT"
  | "SSH_CONFIG_UNREADABLE"
  | "CLI_ERROR";

/**
 * Structured, actionable failure: what is wrong plus the exact command that
 * fixes it. Tools convert these into structured MCP error payloads instead of
 * letting them escape as bare exceptions.
 */
export class TailscaleError extends Error {
  readonly code: TailscaleErrorCode;
  readonly remedy: string;

  constructor(code: TailscaleErrorCode, message: string, remedy: string) {
    super(message);
    this.name = "TailscaleError";
    this.code = code;
    this.remedy = remedy;
  }
}
