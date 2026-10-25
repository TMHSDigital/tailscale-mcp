import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

describe("loadConfig", () => {
  it("defaults to Funnel denied and writes allowed", () => {
    expect(loadConfig({})).toEqual({
      bin: undefined,
      timeoutMs: undefined,
      readOnly: false,
      allowFunnel: false,
    });
  });

  it("reads every flag", () => {
    expect(
      loadConfig({
        TAILSCALE_MCP_BIN: " /opt/ts/tailscale ",
        TAILSCALE_MCP_TIMEOUT_MS: "30000",
        TAILSCALE_MCP_READONLY: "1",
        TAILSCALE_MCP_ALLOW_FUNNEL: "true",
      }),
    ).toEqual({ bin: "/opt/ts/tailscale", timeoutMs: 30000, readOnly: true, allowFunnel: true });
  });

  it.each(["0", "false", "no", "off", ""])("treats %j as off", (value) => {
    expect(loadConfig({ TAILSCALE_MCP_ALLOW_FUNNEL: value }).allowFunnel).toBe(false);
  });

  it("rejects a malformed flag instead of guessing", () => {
    expect(() => loadConfig({ TAILSCALE_MCP_ALLOW_FUNNEL: "maybe" })).toThrow(
      /TAILSCALE_MCP_ALLOW_FUNNEL/,
    );
  });

  it.each(["abc", "50", "1.5"])("rejects timeout %j", (value) => {
    expect(() => loadConfig({ TAILSCALE_MCP_TIMEOUT_MS: value })).toThrow(
      /TAILSCALE_MCP_TIMEOUT_MS/,
    );
  });
});
