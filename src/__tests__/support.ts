import { readFileSync } from "fs";
import type { CliResult, CliRunner } from "../providers/cli.js";

export function fixture(name: string): string {
  return readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf-8");
}

export interface RunnerCall {
  bin: string;
  args: string[];
}

/**
 * Mock runner: routes on the CLI subcommand so tests never spawn a real
 * binary. Records every invocation for assertions.
 */
export function mockRunner(
  routes: Record<string, CliResult | Error>,
  calls: RunnerCall[] = [],
): CliRunner {
  return async (bin, args) => {
    calls.push({ bin, args });
    const key = args.join(" ");
    for (const [route, result] of Object.entries(routes)) {
      if (key.startsWith(route)) {
        if (result instanceof Error) throw result;
        return result;
      }
    }
    throw new Error(`mockRunner: unrouted invocation: ${bin} ${key}`);
  };
}

export function enoent(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("spawn tailscale ENOENT");
  err.code = "ENOENT";
  return err;
}

export function okResult(stdout: string): CliResult {
  return { status: 0, stdout, stderr: "" };
}

/**
 * Parse the JSON text block of a tool result. Takes `unknown` because the
 * SDK's callTool return type is a union that includes the legacy
 * `{ toolResult }` shape, which has no `content`.
 */
export function payload(result: unknown): Record<string, any> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0].text);
}
