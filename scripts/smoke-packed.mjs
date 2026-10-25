#!/usr/bin/env node
// End-to-end check of the artifact that actually gets published: pack the
// package, install the tarball into a clean temp project, and drive the
// installed server over stdio exactly like an MCP client would.
//
// Catches what the in-process tests cannot: a broken `files` list, missing
// shebang or bin entry, ESM resolution problems, readVersion() not finding
// package.json from dist/, and anything writing to stdout (the MCP channel).
//
// Usage: npm run build && npm run test:packed

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const manifest = JSON.parse(readFileSync(join(root, "mcp-tools.json"), "utf-8"));
// Run npm's own CLI through node when started via `npm run` (no shell, so
// arguments are never re-parsed); fall back to the npm on PATH otherwise.
const run = (args, cwd) =>
  process.env.npm_execpath
    ? execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, encoding: "utf-8" })
    : execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        cwd,
        encoding: "utf-8",
        shell: process.platform === "win32",
      });

let failures = 0;
function check(ok, message) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures++;
}

if (!existsSync(join(root, "dist", "index.js"))) {
  console.error("dist/ is missing; run `npm run build` first.");
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "tailscale-mcp-packed-"));
try {
  // 1. Pack and inspect the tarball contents.
  const [packed] = JSON.parse(run(["pack", "--json", "--pack-destination", work], root));
  const files = packed.files.map((f) => f.path);
  for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js"]) {
    check(files.includes(required), `tarball contains ${required}`);
  }
  check(
    !files.some((f) => f.startsWith("src/") || f.includes("__tests__") || f.endsWith(".test.js")),
    "tarball contains no sources or tests",
  );

  // 2. Install it into an empty project, as a user's npx would.
  const project = join(work, "project");
  execFileSync(process.execPath, ["-e", "require('fs').mkdirSync(process.argv[1])", project]);
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "smoke", private: true }));
  run(["install", "--no-audit", "--no-fund", "--loglevel=error", join(work, packed.filename)], project);

  const installed = join(project, "node_modules", ...pkg.name.split("/"));
  const binTarget = join(installed, pkg.bin["tailscale-mcp"]);
  check(existsSync(binTarget), `bin target ${pkg.bin["tailscale-mcp"]} exists`);
  check(
    readFileSync(binTarget, "utf-8").startsWith("#!/usr/bin/env node"),
    "bin target starts with a node shebang",
  );

  // 3. Talk MCP over stdio, using the SDK the package itself installed.
  const sdk = (p) =>
    import(pathToFileURL(join(project, "node_modules/@modelcontextprotocol/sdk/dist/esm", p)).href);
  const { Client } = await sdk("client/index.js");
  const { StdioClientTransport } = await sdk("client/stdio.js");

  // On POSIX launch through the installed bin link (exercises the shebang and
  // exec bit); Windows has no shebangs, so launch the entry point with node.
  const binLink = join(project, "node_modules", ".bin", "tailscale-mcp");
  const transport = new StdioClientTransport({
    command: process.platform === "win32" ? process.execPath : binLink,
    args: process.platform === "win32" ? [binTarget] : [],
    // A binary that cannot exist makes the result independent of whether
    // Tailscale is installed on this machine.
    env: { ...process.env, TAILSCALE_MCP_BIN: join(work, "no-such-tailscale") },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (d) => (stderr += d));
  const transportErrors = [];
  const client = new Client({ name: "smoke-packed", version: "0.0.0" });
  client.onerror = (err) => transportErrors.push(err);
  await client.connect(transport);

  const info = client.getServerVersion();
  check(info?.name === "tailscale-mcp", `server name is tailscale-mcp (got ${info?.name})`);
  check(info?.version === pkg.version, `server version is ${pkg.version} (got ${info?.version})`);

  const { tools } = await client.listTools();
  check(
    isDeepStrictEqual(JSON.parse(JSON.stringify(tools)), manifest),
    "tools/list matches mcp-tools.json exactly",
  );

  for (const attempt of [1, 2]) {
    const result = await client.callTool({ name: "tailnet_status", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    check(
      result.isError === true && payload.error?.code === "BINARY_NOT_FOUND",
      `call ${attempt}: missing binary returns a structured BINARY_NOT_FOUND error`,
    );
  }

  check(transportErrors.length === 0, "stdout carried only valid JSON-RPC");
  check(/listening on stdio/.test(stderr), "startup log went to stderr");
  await client.close();
} catch (err) {
  console.error(err);
  failures++;
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nThe packed package installs and serves MCP over stdio.");
