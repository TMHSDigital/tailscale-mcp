#!/usr/bin/env node
// Copy package.json's version into server.json (the MCP Registry entry). Runs
// automatically as npm's `version` lifecycle script, so
// `npm version <patch|minor|major>` keeps both in step; the
// release-metadata test fails if they ever disagree.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const path = join(root, "server.json");
const server = JSON.parse(readFileSync(path, "utf-8"));

server.version = version;
for (const pkg of server.packages ?? []) pkg.version = version;
writeFileSync(path, JSON.stringify(server, null, 2) + "\n");
console.log(`server.json -> ${version}`);
