#!/usr/bin/env node
// Build the one-click Claude Desktop extension (.mcpb) for the current
// version. Run after `npm run build`:
//
//   node scripts/build-mcpb.mjs [outDir]     (default: ./mcpb-out)
//
// Stages what the npm package ships (package.json, dist/, README, LICENSE)
// plus production node_modules and the icon, writes manifest.json from
// package.json and mcp-tools.json, then validates and packs it with the
// pinned @anthropic-ai/mcpb CLI.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUNDLE_FILE, buildManifest } from "./mcpb-manifest.mjs";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";
const root = resolve(import.meta.dirname, "..");
const outDir = resolve(process.argv[2] ?? join(root, "mcpb-out"));
const stage = join(outDir, "stage");

// Run npm/npx through node with npm's own CLI when available (no shell, so
// paths are never re-parsed); fall back to the commands on PATH.
function npmTool(tool, args, cwd) {
  const cli = process.env.npm_execpath;
  if (cli) {
    const script = tool === "npx" ? cli.replace(/npm-cli\.js$/, "npx-cli.js") : cli;
    return execFileSync(process.execPath, [script, ...args], { cwd, stdio: "inherit" });
  }
  const win = process.platform === "win32";
  return execFileSync(win ? `${tool}.cmd` : tool, args, { cwd, stdio: "inherit", shell: win });
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const tools = JSON.parse(readFileSync(join(root, "mcp-tools.json"), "utf-8"));
if (!existsSync(join(root, "dist", "index.js"))) {
  throw new Error("dist/index.js is missing: run `npm run build` first.");
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const entry of ["package.json", "package-lock.json", "dist", "README.md", "LICENSE"]) {
  cpSync(join(root, entry), join(stage, entry), { recursive: true });
}
cpSync(join(root, "mcpb", "icon.png"), join(stage, "icon.png"));
writeFileSync(join(stage, "manifest.json"), JSON.stringify(buildManifest(pkg, tools), null, 2));

// Production dependencies only; no install scripts run.
npmTool("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], stage);
rmSync(join(stage, "package-lock.json"));

const bundle = join(outDir, BUNDLE_FILE);
npmTool("npx", ["--yes", MCPB_CLI, "validate", join(stage, "manifest.json")], root);
npmTool("npx", ["--yes", MCPB_CLI, "pack", stage, bundle], root);
console.log(`\nBuilt ${bundle} (version ${pkg.version})`);
