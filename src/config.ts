// Server configuration from environment variables. Parsing lives here (not in
// index.ts) so it can be tested without starting the stdio server.

import { BIN_ENV_VAR, TIMEOUT_ENV_VAR } from "./providers/cli.js";

export const READONLY_ENV_VAR = "TAILSCALE_MCP_READONLY";
export const ALLOW_FUNNEL_ENV_VAR = "TAILSCALE_MCP_ALLOW_FUNNEL";

export interface ServerConfig {
  /** Explicit tailscale binary path. */
  bin?: string;
  /** Default per-call CLI timeout in milliseconds. */
  timeoutMs?: number;
  /** Mutating tools are not registered and generate_ssh_config refuses to write. */
  readOnly: boolean;
  /** share_port may use Funnel (public internet exposure). */
  allowFunnel: boolean;
}

function flag(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "" || ["0", "false", "no", "off"].includes(value)) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(value)) return true;
  throw new Error(`${name} must be 1/true/yes/on or 0/false/no/off (got "${env[name]}").`);
}

/** Read the server config; throws on malformed values so a typo never silently loosens safety. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const bin = env[BIN_ENV_VAR]?.trim() || undefined;

  let timeoutMs: number | undefined;
  const rawTimeout = env[TIMEOUT_ENV_VAR]?.trim();
  if (rawTimeout) {
    timeoutMs = Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
      throw new Error(`${TIMEOUT_ENV_VAR} must be an integer of at least 100 (got "${rawTimeout}").`);
    }
  }

  return {
    bin,
    timeoutMs,
    readOnly: flag(env, READONLY_ENV_VAR),
    allowFunnel: flag(env, ALLOW_FUNNEL_ENV_VAR),
  };
}
