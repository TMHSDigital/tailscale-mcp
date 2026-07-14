// ssh-config generation for tailnet nodes, with idempotent managed-marker
// editing. All functions here are pure (no filesystem access) so tests cover
// them without touching the disk; the tool layer owns the thin I/O.

import type { TailscaleNode } from "./providers/types.js";

export const BEGIN_MARKER = "# BEGIN tailscale-mcp";
export const END_MARKER = "# END tailscale-mcp";
export const DEDICATED_FILE_NAME = "tailscale_dev_config";

export interface SshConfigOptions {
  /** Default remote user for every Host block. */
  user?: string;
}

/**
 * Render Host blocks for the given nodes. MagicDNS name preferred, Tailscale
 * IPv4 as fallback; nodes with neither are skipped.
 */
export function renderHostBlocks(nodes: TailscaleNode[], opts: SshConfigOptions = {}): string {
  const blocks: string[] = [];
  for (const node of nodes) {
    const target = node.dnsName || node.ipv4;
    if (!target || !node.hostname) continue;
    const lines = [`Host ${node.hostname.toLowerCase()}`, `    HostName ${target}`];
    if (opts.user) lines.push(`    User ${opts.user}`);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

/** Wrap a rendered body in the managed markers. */
export function managedBlock(body: string): string {
  return `${BEGIN_MARKER}\n${body}\n${END_MARKER}`;
}

/**
 * Insert or replace the managed section of an ssh config, never touching
 * content outside the markers. Idempotent: applying the same block twice
 * yields byte-identical output.
 */
export function applyManagedBlock(existing: string, body: string): string {
  const block = managedBlock(body);
  const begin = existing.indexOf(BEGIN_MARKER);
  const end = existing.indexOf(END_MARKER);

  if (begin !== -1 && end !== -1 && end >= begin) {
    const before = existing.slice(0, begin);
    const after = existing.slice(end + END_MARKER.length);
    return before + block + after;
  }

  if (existing.trim() === "") return block + "\n";
  const sep = existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block + "\n";
}
