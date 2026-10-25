import { TailscaleError } from "../providers/types.js";

export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Annotations for tools that only observe. Every tool sets all four hints
 * explicitly, because the spec tells clients to assume an unannotated tool is
 * destructive, non-idempotent, and open-world.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/**
 * A successful result: the payload as `structuredContent` (matching the
 * tool's outputSchema) plus the same JSON as text for clients that predate
 * structured output.
 */
export function ok(data: Record<string, unknown>): ToolResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
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
    // No structuredContent: SDK clients validate it against the tool's
    // outputSchema even on errors, and the error shape is not that schema.
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}
