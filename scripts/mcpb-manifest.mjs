// Claude Desktop extension manifest (MCPB spec 0.3), shared by
// scripts/build-mcpb.mjs and its test. A pure function of package.json and
// mcp-tools.json, so the bundle's version and tool list can never drift.

/** File name of the bundle attached to each GitHub Release (stable, so a
 * releases/latest/download link keeps working). */
export const BUNDLE_FILE = "tailscale-mcp.mcpb";

export function buildManifest(pkg, tools) {
  return {
    manifest_version: "0.3",
    name: "tailscale-mcp",
    display_name: "Tailscale MCP",
    version: pkg.version,
    description: pkg.description,
    long_description:
      "Lets Claude see your tailnet and use it safely: list devices, write SSH config for them " +
      "(dry run first), share a local port with your tailnet, and check which links are direct or " +
      "relayed. Sharing to the public internet with Funnel stays off unless you turn it on below. " +
      "Requires the Tailscale app, installed and logged in. Never reads or stores credentials.",
    author: { name: "TMHSDigital", url: "https://github.com/TMHSDigital" },
    homepage: pkg.homepage,
    documentation: "https://github.com/TMHSDigital/tailscale-mcp#readme",
    support: pkg.bugs?.url,
    repository: { type: "git", url: "https://github.com/TMHSDigital/tailscale-mcp" },
    license: pkg.license,
    keywords: pkg.keywords,
    icon: "icon.png",
    server: {
      type: "node",
      entry_point: "dist/index.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/dist/index.js"],
        // Unset optional values arrive as empty strings, which src/config.ts
        // treats as "not set".
        env: {
          TAILSCALE_MCP_ALLOW_FUNNEL: "${user_config.allow_funnel}",
          TAILSCALE_MCP_READONLY: "${user_config.read_only}",
          TAILSCALE_MCP_BIN: "${user_config.tailscale_bin}",
        },
      },
    },
    tools: tools.map((t) => ({ name: t.name, description: t.description })),
    user_config: {
      read_only: {
        type: "boolean",
        title: "Read-only mode",
        description: "Only observe: hide the share tools and refuse SSH config writes.",
        default: false,
      },
      allow_funnel: {
        type: "boolean",
        title: "Allow public sharing (Funnel)",
        description:
          "Let share_port expose a port to the open internet. Anyone with the URL can reach it. Leave off unless you need it.",
        default: false,
      },
      tailscale_bin: {
        type: "file",
        title: "tailscale CLI",
        description: "Only needed if the tailscale command is not found automatically.",
        required: false,
      },
    },
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: pkg.engines?.node ?? ">=22.0.0" },
    },
  };
}
