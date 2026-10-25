// ssh-config generation for tailnet nodes, with idempotent managed-marker
// editing. All functions here are pure (no filesystem access) so tests cover
// them without touching the disk; the tool layer owns the thin I/O.

import { TailscaleError, type TailscaleNode } from "./providers/types.js";

export const BEGIN_MARKER = "# BEGIN tailscale-mcp";
export const END_MARKER = "# END tailscale-mcp";
export const DEDICATED_FILE_NAME = "tailscale_dev_config";

const MULLVAD_SUFFIX = ".mullvad.ts.net";

export interface SshConfigOptions {
  /** Default remote user for every Host block. */
  user?: string;
  /** Include peers owned by users this node is shared with (default: false). */
  includeShared?: boolean;
}

export interface HostEntry {
  /** The `Host` alias: a single SSH-safe token, unique within the block. */
  alias: string;
  /** The `HostName` value: MagicDNS name, or Tailscale IPv4 as fallback. */
  hostName: string;
  node: TailscaleNode;
}

export interface SkippedNode {
  hostname: string;
  dnsName: string;
  reason: "no_address" | "mullvad_exit_node" | "shared_node";
}

export interface HostPlan {
  entries: HostEntry[];
  skipped: SkippedNode[];
  /** Aliases that collided and were disambiguated with a numeric suffix. */
  renamed: Array<{ from: string; to: string; hostname: string }>;
}

/** Reduce a raw OS hostname to `[a-z0-9-]`, e.g. "My MacBook Pro" -> "my-macbook-pro". */
export function sanitizeAlias(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * The alias for a node. The first MagicDNS label is preferred: Tailscale
 * already keeps it unique within the tailnet and DNS-safe (it de-duplicates
 * clones as "raspberrypi-1"), whereas the raw OS hostname may contain spaces
 * or collide.
 */
function baseAlias(node: TailscaleNode): string {
  const label = node.dnsName ? sanitizeAlias(node.dnsName.split(".")[0]) : "";
  if (label) return label;
  const fromHost = sanitizeAlias(node.hostname);
  if (fromHost) return fromHost;
  return node.ipv4 ? `ts-${node.ipv4.replace(/\./g, "-")}` : "";
}

/** Decide which nodes get Host blocks and under which aliases. */
export function planHostBlocks(nodes: TailscaleNode[], opts: SshConfigOptions = {}): HostPlan {
  const plan: HostPlan = { entries: [], skipped: [], renamed: [] };
  const used = new Set<string>();

  for (const node of nodes) {
    const skip = (reason: SkippedNode["reason"]) =>
      plan.skipped.push({ hostname: node.hostname, dnsName: node.dnsName, reason });

    if (node.dnsName.endsWith(MULLVAD_SUFFIX)) {
      skip("mullvad_exit_node");
      continue;
    }
    if (node.sharee && !opts.includeShared) {
      skip("shared_node");
      continue;
    }
    const hostName = node.dnsName || node.ipv4;
    const base = baseAlias(node);
    if (!hostName || !base) {
      skip("no_address");
      continue;
    }

    let alias = base;
    for (let n = 2; used.has(alias); n++) alias = `${base}-${n}`;
    if (alias !== base) plan.renamed.push({ from: base, to: alias, hostname: node.hostname });
    used.add(alias);
    plan.entries.push({ alias, hostName, node });
  }
  return plan;
}

/** Render Host blocks for a plan (or directly for nodes). */
export function renderHostBlocks(
  input: TailscaleNode[] | HostPlan,
  opts: SshConfigOptions = {},
): string {
  const plan = Array.isArray(input) ? planHostBlocks(input, opts) : input;
  return plan.entries
    .map(({ alias, hostName }) => {
      const lines = [`Host ${alias}`, `    HostName ${hostName}`];
      if (opts.user) lines.push(`    User ${opts.user}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/** Wrap a rendered body in the managed markers. */
export function managedBlock(body: string): string {
  return `${BEGIN_MARKER}\n${body}\n${END_MARKER}`;
}

interface MarkerLine {
  /** Offset of the first character of the line. */
  start: number;
  /** Offset just past the line's content (before any "\r\n" / "\n"). */
  end: number;
  lineNumber: number;
}

/** Find every line that consists of exactly `marker` (ignoring surrounding whitespace). */
function findMarkerLines(text: string, marker: string): MarkerLine[] {
  const found: MarkerLine[] = [];
  let start = 0;
  let lineNumber = 1;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const lineEnd = nl === -1 ? text.length : nl;
    const contentEnd = lineEnd > start && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    if (text.slice(start, contentEnd).trim() === marker) {
      found.push({ start, end: contentEnd, lineNumber });
    }
    if (nl === -1) break;
    start = nl + 1;
    lineNumber++;
  }
  return found;
}

/**
 * Insert or replace the managed section of an ssh config, never touching
 * content outside the markers. Idempotent: applying the same block twice
 * yields byte-identical output.
 *
 * Markers are matched as whole lines. Anything other than zero markers or
 * exactly one BEGIN followed by one END (an orphan, a reversed pair, or
 * duplicates) throws SSH_CONFIG_MARKERS_CORRUPT rather than guessing which
 * user content may be replaced.
 */
export function applyManagedBlock(existing: string, body: string): string {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const block = managedBlock(body).replace(/\n/g, eol);
  const begins = findMarkerLines(existing, BEGIN_MARKER);
  const ends = findMarkerLines(existing, END_MARKER);

  if (begins.length === 0 && ends.length === 0) {
    if (existing.trim() === "") return block + eol;
    const sep = existing.endsWith("\n") ? eol : eol + eol;
    return existing + sep + block + eol;
  }

  if (begins.length === 1 && ends.length === 1 && begins[0].start < ends[0].start) {
    return existing.slice(0, begins[0].start) + block + existing.slice(ends[0].end);
  }

  const describe = (label: string, lines: MarkerLine[]) =>
    `${lines.length} "${label}" line(s)${lines.length ? ` at line ${lines.map((l) => l.lineNumber).join(", ")}` : ""}`;
  throw new TailscaleError(
    "SSH_CONFIG_MARKERS_CORRUPT",
    `The tailscale-mcp markers in the ssh config are malformed: found ` +
      `${describe(BEGIN_MARKER, begins)} and ${describe(END_MARKER, ends)}. ` +
      "Nothing was written.",
    `Edit the file so it contains exactly one "${BEGIN_MARKER}" line followed by one ` +
      `"${END_MARKER}" line (or remove both), then retry.`,
  );
}
