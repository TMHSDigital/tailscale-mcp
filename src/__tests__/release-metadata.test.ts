import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { ALLOW_FUNNEL_ENV_VAR, READONLY_ENV_VAR } from "../config.js";
import { BIN_ENV_VAR, TIMEOUT_ENV_VAR } from "../providers/cli.js";
// @ts-expect-error -- plain .mjs build script, no type declarations
import { buildManifest } from "../../scripts/mcpb-manifest.mjs";

const read = (rel: string) => JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), "utf-8"));
const pkg = read("package.json");
const server = read("server.json");
const tools: Array<{ name: string; description: string }> = read("mcp-tools.json");
const ENV_VARS = [ALLOW_FUNNEL_ENV_VAR, READONLY_ENV_VAR, BIN_ENV_VAR, TIMEOUT_ENV_VAR];

// The MCP Registry rejects a publish whose server.json disagrees with the npm
// package, and that only surfaces after npm has already published. Catch it here.
describe("MCP Registry metadata (server.json)", () => {
  it("matches package.json: name, npm identifier, and version", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toHaveLength(1);
    expect(server.packages[0]).toMatchObject({
      registryType: "npm",
      identifier: pkg.name,
      version: pkg.version,
      transport: { type: "stdio" },
    });
  });

  it("fits the registry schema limits", () => {
    expect(server.name).toMatch(/^io\.github\.TMHSDigital\/[a-zA-Z0-9._-]+$/);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.title.length).toBeLessThanOrEqual(100);
  });

  it("documents exactly the environment variables the server reads", () => {
    const names = server.packages[0].environmentVariables.map((e: { name: string }) => e.name);
    expect(names.sort()).toEqual([...ENV_VARS].sort());
  });
});

describe("Claude Desktop extension manifest (.mcpb)", () => {
  const manifest = buildManifest(pkg, tools);

  it("takes its version and tool list from the package", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.tools.map((t: { name: string }) => t.name)).toEqual(tools.map((t) => t.name));
  });

  it("only passes environment variables the server understands", () => {
    for (const name of Object.keys(manifest.server.mcp_config.env)) {
      expect(ENV_VARS).toContain(name);
    }
  });

  it("keeps Funnel off and writes allowed by default", () => {
    expect(manifest.user_config.allow_funnel.default).toBe(false);
    expect(manifest.user_config.read_only.default).toBe(false);
  });
});
