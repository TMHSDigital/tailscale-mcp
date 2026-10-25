import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CliProvider } from "../providers/cli.js";
import { registerAll } from "../tools/index.js";
import {
  applyManagedBlock,
  BEGIN_MARKER,
  END_MARKER,
  planHostBlocks,
  renderHostBlocks,
} from "../sshconfig.js";
import { TailscaleError, type TailscaleNode } from "../providers/types.js";
import { BACKUP_SUFFIX } from "../tools/sshconfig.js";
import { fixture, mockRunner, okResult, payload } from "./support.js";

function node(overrides: Partial<TailscaleNode>): TailscaleNode {
  return {
    hostname: "box",
    dnsName: "box.tail1234.ts.net",
    ipv4: "100.101.1.99",
    ipv6: null,
    os: "linux",
    online: true,
    lastSeen: null,
    exitNode: false,
    exitNodeOption: false,
    tags: [],
    sharee: false,
    ...overrides,
  };
}

/** Every `Host` line in rendered config, as its list of patterns. */
function hostPatterns(text: string): string[][] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("Host "))
    .map((l) => l.slice(5).trim().split(/\s+/));
}

describe("renderHostBlocks", () => {
  it("prefers MagicDNS and falls back to the Tailscale IP", () => {
    const text = renderHostBlocks([
      node({ hostname: "raspi", dnsName: "raspi.tail1234.ts.net" }),
      node({ hostname: "bare", dnsName: "", ipv4: "100.101.1.7" }),
    ]);
    expect(text).toContain("Host raspi\n    HostName raspi.tail1234.ts.net");
    expect(text).toContain("Host bare\n    HostName 100.101.1.7");
  });

  it("aliases by MagicDNS label, not the raw OS hostname", () => {
    // The fixture's phone reports HostName "localhost"; aliasing on that would
    // shadow `ssh localhost`.
    const text = renderHostBlocks([node({ hostname: "localhost", dnsName: "phone.tail1234.ts.net" })]);
    expect(text).toContain("Host phone\n");
    expect(text).not.toContain("Host localhost");
  });

  it("sanitizes hostnames with spaces and Unicode into one SSH-safe token", () => {
    const plan = planHostBlocks([
      node({ hostname: "My MacBook Pro", dnsName: "", ipv4: "100.101.1.1" }),
      node({ hostname: "Café Büro's PC", dnsName: "", ipv4: "100.101.1.2" }),
      node({ hostname: "日本", dnsName: "", ipv4: "100.101.1.3" }),
    ]);
    expect(plan.entries.map((e) => e.alias)).toEqual([
      "my-macbook-pro",
      "cafe-buro-s-pc",
      "ts-100-101-1-3",
    ]);
    for (const patterns of hostPatterns(renderHostBlocks(plan))) {
      expect(patterns).toHaveLength(1);
      expect(patterns[0]).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("disambiguates colliding aliases and reports the renames", () => {
    const plan = planHostBlocks([
      node({ hostname: "box", dnsName: "", ipv4: "100.101.1.1" }),
      node({ hostname: "box", dnsName: "", ipv4: "100.101.1.2" }),
      node({ hostname: "Box", dnsName: "", ipv4: "100.101.1.3" }),
    ]);
    const aliases = plan.entries.map((e) => e.alias);
    expect(aliases).toEqual(["box", "box-2", "box-3"]);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(plan.renamed).toEqual([
      { from: "box", to: "box-2", hostname: "box" },
      { from: "box", to: "box-3", hostname: "Box" },
    ]);
  });

  it("skips Mullvad exit nodes and shared nodes by default, reporting why", () => {
    const nodes = [
      node({ hostname: "us-nyc-wg-301", dnsName: "us-nyc-wg-301.mullvad.ts.net" }),
      node({ hostname: "friend", dnsName: "friend.tail1234.ts.net", sharee: true }),
      node({ hostname: "mine", dnsName: "mine.tail1234.ts.net" }),
    ];
    const plan = planHostBlocks(nodes);
    expect(plan.entries.map((e) => e.alias)).toEqual(["mine"]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["mullvad_exit_node", "shared_node"]);

    const withShared = planHostBlocks(nodes, { includeShared: true });
    expect(withShared.entries.map((e) => e.alias)).toEqual(["friend", "mine"]);
  });

  it("skips nodes with neither DNS name nor IP and adds User when given", () => {
    const text = renderHostBlocks(
      [node({ hostname: "ghost", dnsName: "", ipv4: null }), node({ hostname: "dev" })],
      { user: "ubuntu" },
    );
    expect(text).not.toContain("ghost");
    expect(text).toContain("    User ubuntu");
  });
});

describe("applyManagedBlock", () => {
  const body = "Host raspi\n    HostName raspi.tail1234.ts.net";

  it("is idempotent: applying twice yields identical output", () => {
    const once = applyManagedBlock("", body);
    const twice = applyManagedBlock(once, body);
    expect(twice).toBe(once);
    expect(once).toContain(BEGIN_MARKER);
    expect(once).toContain(END_MARKER);
  });

  it("never touches content outside the markers", () => {
    const userContent = "Host mybox\n    HostName 10.0.0.5\n    Port 2222\n";
    const trailer = "\n# my trailing comment\n";
    const existing =
      userContent + `${BEGIN_MARKER}\nold stale body\n${END_MARKER}` + trailer;
    const updated = applyManagedBlock(existing, body);
    expect(updated.startsWith(userContent)).toBe(true);
    expect(updated.endsWith(trailer)).toBe(true);
    expect(updated).toContain(body);
    expect(updated).not.toContain("old stale body");
  });

  it("appends to an existing config without markers", () => {
    const existing = "Host other\n    HostName 10.1.1.1\n";
    const updated = applyManagedBlock(existing, body);
    expect(updated.startsWith(existing)).toBe(true);
    expect(updated).toContain(BEGIN_MARKER);
  });

  function corruptError(existing: string): TailscaleError {
    try {
      applyManagedBlock(existing, body);
    } catch (err) {
      return err as TailscaleError;
    }
    throw new Error("expected applyManagedBlock to throw");
  }

  it.each([
    ["orphan BEGIN", `Host a\n${BEGIN_MARKER}\nHost keepme\n    HostName important\n`],
    ["orphan END", `Host keepme\n    HostName important\n${END_MARKER}\n`],
    ["reversed", `${END_MARKER}\nHost keepme\n${BEGIN_MARKER}\n`],
    [
      "duplicate pairs",
      `${BEGIN_MARKER}\nx\n${END_MARKER}\nHost keepme\n${BEGIN_MARKER}\ny\n${END_MARKER}\n`,
    ],
  ])("refuses to edit with malformed markers (%s)", (_label, existing) => {
    const err = corruptError(existing);
    expect(err).toBeInstanceOf(TailscaleError);
    expect(err.code).toBe("SSH_CONFIG_MARKERS_CORRUPT");
    expect(err.message).toMatch(/at line \d/);
  });

  it("does not lose content across repeated runs after an orphaned BEGIN (#31 repro)", () => {
    const cfg = `Host a\n  HostName a\n${BEGIN_MARKER}\nHost keepme\n  HostName important\n`;
    expect(() => applyManagedBlock(cfg, body)).toThrow(TailscaleError);
  });

  it("only matches markers as whole lines, not inside comments", () => {
    const existing = `# note: ${BEGIN_MARKER} is managed below\nHost keepme\n`;
    const updated = applyManagedBlock(existing, body);
    expect(updated.startsWith(existing)).toBe(true);
    expect(applyManagedBlock(updated, body)).toBe(updated);
  });

  it("preserves CRLF line endings", () => {
    const existing = "Host other\r\n    HostName 10.1.1.1\r\n";
    const once = applyManagedBlock(existing, body);
    expect(once.startsWith(existing)).toBe(true);
    expect(once.replace(/\r\n/g, "")).not.toContain("\n");
    expect(applyManagedBlock(once, body)).toBe(once);
  });

  it("property: never drops a byte outside a well-formed marker pair", () => {
    // Deterministic LCG so failures reproduce.
    let seed = 0x5eed;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const atoms = ["Host x", "    HostName 10.0.0.1", "", "# comment", "  ", "Match all", "\r"];
    const chunk = () =>
      Array.from({ length: rand(6) }, () => atoms[rand(atoms.length)]).join("\n");

    for (let i = 0; i < 500; i++) {
      // Markers must sit on their own lines to form a well-formed pair.
      const before = rand(4) ? chunk() + "\n" : "";
      const after = rand(4) ? "\n" + chunk() : "";
      const oldBody = chunk();
      const existing = `${before}${BEGIN_MARKER}\n${oldBody}\n${END_MARKER}${after}`;
      const updated = applyManagedBlock(existing, body);
      expect(updated.startsWith(before)).toBe(true);
      expect(updated.endsWith(after)).toBe(true);
      expect(applyManagedBlock(updated, body)).toBe(updated);
    }
  });
});

describe("generate_ssh_config tool", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function connectedClient(): Promise<Client> {
    dir = mkdtempSync(join(tmpdir(), "ts-mcp-ssh-"));
    const provider = new CliProvider({
      runner: mockRunner({ "status --json": okResult(fixture("status-running.json")) }),
    });
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAll(server, { provider, sshDir: dir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  }

  it("dry-run by default: returns config text, writes nothing", async () => {
    const client = await connectedClient();
    const result = await client.callTool({ name: "generate_ssh_config", arguments: {} });
    const data = payload(result);
    expect(data.dryRun).toBe(true);
    expect(data.hostCount).toBe(3);
    expect(data.configText).toContain("Host raspi");
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("write=true writes the dedicated file and returns Include instructions", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "generate_ssh_config",
      arguments: { write: true, user: "pi" },
    });
    const data = payload(result);
    expect(data.dryRun).toBe(false);
    const written = readFileSync(join(dir, "tailscale_dev_config"), "utf-8");
    expect(written).toContain("Host raspi");
    expect(written).toContain("User pi");
    expect(data.instructions).toContain("Include tailscale_dev_config");
    // The user's ~/.ssh/config is not created or touched.
    expect(existsSync(join(dir, "config"))).toBe(false);
  });

  it("user_ssh_config target edits between markers idempotently", async () => {
    const client = await connectedClient();
    const preexisting = "Host mybox\n    HostName 10.0.0.5\n";
    writeFileSync(join(dir, "config"), preexisting, "utf-8");

    const args = { write: true, target: "user_ssh_config" };
    await client.callTool({ name: "generate_ssh_config", arguments: args });
    const first = readFileSync(join(dir, "config"), "utf-8");
    await client.callTool({ name: "generate_ssh_config", arguments: args });
    const second = readFileSync(join(dir, "config"), "utf-8");

    expect(second).toBe(first);
    expect(first.startsWith(preexisting)).toBe(true);
    expect(first).toContain("Host raspi");
  });

  it("backs up the previous config, and skips the write when nothing changed", async () => {
    const client = await connectedClient();
    const preexisting = "Host mybox\n    HostName 10.0.0.5\n";
    writeFileSync(join(dir, "config"), preexisting, "utf-8");

    const args = { write: true, target: "user_ssh_config" };
    const first = payload(await client.callTool({ name: "generate_ssh_config", arguments: args }));
    expect(first.backup).toBe(join(dir, "config" + BACKUP_SUFFIX));
    expect(readFileSync(first.backup, "utf-8")).toBe(preexisting);

    const second = payload(await client.callTool({ name: "generate_ssh_config", arguments: args }));
    expect(second.wrote).toBeNull();
    // The backup still holds the pre-edit original, not the managed version.
    expect(readFileSync(first.backup, "utf-8")).toBe(preexisting);
    // No temp files are left behind.
    expect(readdirSync(dir).sort()).toEqual(["config", "config" + BACKUP_SUFFIX]);
  });

  it("refuses to write when the existing config cannot be read", async () => {
    const client = await connectedClient();
    // A directory where the file should be: readFile fails with EISDIR, which
    // must not be mistaken for "no config" and overwritten.
    mkdirSync(join(dir, "config"));
    const result = await client.callTool({
      name: "generate_ssh_config",
      arguments: { write: true, target: "user_ssh_config" },
    });
    expect(result.isError).toBe(true);
    expect(payload(result).error.code).toBe("SSH_CONFIG_UNREADABLE");
    expect(statSync(join(dir, "config")).isDirectory()).toBe(true);
  });

  it("leaves the file untouched when markers are corrupt", async () => {
    const client = await connectedClient();
    const corrupt = `Host keepme\n${BEGIN_MARKER}\nHost x\n`;
    writeFileSync(join(dir, "config"), corrupt, "utf-8");
    const result = await client.callTool({
      name: "generate_ssh_config",
      arguments: { write: true, target: "user_ssh_config" },
    });
    expect(payload(result).error.code).toBe("SSH_CONFIG_MARKERS_CORRUPT");
    expect(readFileSync(join(dir, "config"), "utf-8")).toBe(corrupt);
    expect(readdirSync(dir)).toEqual(["config"]);
  });

  it.skipIf(process.platform === "win32")(
    "creates files 0600, keeps an existing mode, and writes through symlinks",
    async () => {
      const client = await connectedClient();
      await client.callTool({ name: "generate_ssh_config", arguments: { write: true } });
      expect(statSync(join(dir, "tailscale_dev_config")).mode & 0o777).toBe(0o600);

      const real = join(dir, "dotfiles-config");
      writeFileSync(real, "Host mybox\n", { mode: 0o640 });
      chmodSync(real, 0o640);
      symlinkSync(real, join(dir, "config"));
      await client.callTool({
        name: "generate_ssh_config",
        arguments: { write: true, target: "user_ssh_config" },
      });
      expect(lstatSync(join(dir, "config")).isSymbolicLink()).toBe(true);
      expect(readFileSync(real, "utf-8")).toContain(BEGIN_MARKER);
      expect(statSync(real).mode & 0o777).toBe(0o640);
    },
  );

  it("refuses to write in read-only mode but still serves the dry run", async () => {
    dir = mkdtempSync(join(tmpdir(), "ts-mcp-ssh-"));
    const provider = new CliProvider({
      runner: mockRunner({ "status --json": okResult(fixture("status-running.json")) }),
    });
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAll(server, { provider, sshDir: dir, readOnly: true });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const dry = payload(await client.callTool({ name: "generate_ssh_config", arguments: {} }));
    expect(dry.configText).toContain("Host raspi");

    const result = await client.callTool({
      name: "generate_ssh_config",
      arguments: { write: true, target: "user_ssh_config" },
    });
    expect(payload(result).error.code).toBe("READ_ONLY");
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("onlineOnly filters offline peers out of the config", async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: "generate_ssh_config",
      arguments: { onlineOnly: true },
    });
    const data = payload(result);
    expect(data.hostCount).toBe(2);
    expect(data.configText).not.toContain("phone");
  });

  it("returns a structured error when the daemon is down", async () => {
    dir = mkdtempSync(join(tmpdir(), "ts-mcp-ssh-"));
    const provider = new CliProvider({
      runner: mockRunner({ "status --json": okResult(fixture("status-stopped.json")) }),
    });
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerAll(server, { provider, sshDir: dir });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const result = await client.callTool({ name: "generate_ssh_config", arguments: {} });
    expect(result.isError).toBe(true);
    expect(payload(result).error.code).toBe("DAEMON_NOT_RUNNING");
  });
});
