import { TailscaleError } from "../providers/types.js";

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function ok(data: unknown): ToolResponse {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Convert any failure into a structured, actionable error payload. Tailscale
 * errors carry a code and the exact remedy command; everything else degrades
 * to a plain message.
 */
export function fail(err: unknown): ToolResponse {
  const payload =
    err instanceof TailscaleError
      ? { error: { code: err.code, message: err.message, remedy: err.remedy } }
      : { error: { code: "UNEXPECTED", message: err instanceof Error ? err.message : String(err) } };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}
