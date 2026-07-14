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
}

export interface PingResult {
  target: string;
  reachable: boolean;
  latencyMs: number | null;
  /** "direct" when a peer-to-peer path was used, "derp" when relayed. */
  path: "direct" | "derp" | null;
  /** The endpoint or DERP region the reply came through. */
  via: string | null;
  /** Raw CLI output, for diagnostics. */
  raw: string;
}

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

export interface TailscaleProvider {
  status(): Promise<TailnetStatus>;
  ping(target: string, opts?: PingOptions): Promise<PingResult>;
  serve(opts: ServeOptions): Promise<ServeResult>;
  serveStatus(): Promise<string>;
  serveReset(port?: number): Promise<string>;
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
