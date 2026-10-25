import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./index.js";
import { fail, ok } from "./helpers.js";
import { TailscaleError } from "../providers/types.js";
import { READONLY_ENV_VAR } from "../config.js";
import {
  applyManagedBlock,
  DEDICATED_FILE_NAME,
  managedBlock,
  planHostBlocks,
  renderHostBlocks,
} from "../sshconfig.js";

export const BACKUP_SUFFIX = ".tailscale-mcp.bak";

/** Mode bits of an existing file, or null when it does not exist. */
async function existingMode(path: string): Promise<number | null> {
  try {
    return (await fs.stat(path)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write via a temp file in the same directory and rename it into place, so
 * a crash or concurrent write never leaves a truncated file. The mode is set
 * explicitly because OpenSSH refuses configs writable by group or others.
 * On Windows chmod only toggles read-only; ACLs are left unchanged.
 */
async function writeFileAtomic(path: string, content: string, mode: number): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, content, { encoding: "utf-8", mode });
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Read an existing config; only a missing file counts as "no config". */
async function readConfig(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new TailscaleError(
      "SSH_CONFIG_UNREADABLE",
      `Could not read ${path} (${code ?? (err as Error).message}). Nothing was written.`,
      "Check the file's ownership and permissions, or use the default dedicated_file target.",
    );
  }
}

export function register(server: McpServer, ctx: ToolContext): void {
  const sshDir = () => ctx.sshDir ?? join(homedir(), ".ssh");

  server.tool(
    "generate_ssh_config",
    "Generate ssh-config Host blocks for tailnet nodes (MagicDNS name preferred, " +
      "Tailscale IP fallback). Dry-run by default: returns the generated config text " +
      "only and writes nothing. With write=true it writes a dedicated file " +
      "(~/.ssh/tailscale_dev_config) and returns instructions for adding an Include " +
      "line to ~/.ssh/config (never applied automatically). Direct editing of " +
      "~/.ssh/config itself additionally requires target=\"user_ssh_config\" and is " +
      "idempotent between managed markers, never touching content outside them." +
      (ctx.readOnly ? " This server is read-only: write=true is refused." : ""),
    {
      write: z
        .boolean()
        .optional()
        .describe("Actually write the config (default: false = dry-run, text only)"),
      target: z
        .enum(["dedicated_file", "user_ssh_config"])
        .optional()
        .describe(
          'Write target: "dedicated_file" (default, ~/.ssh/tailscale_dev_config) or ' +
            '"user_ssh_config" (edit ~/.ssh/config between managed markers)',
        ),
      onlineOnly: z
        .boolean()
        .optional()
        .describe("Only include peers that are currently online (default: false)"),
      includeShared: z
        .boolean()
        .optional()
        .describe(
          "Include nodes of users this node is shared with (default: false). " +
            "Mullvad exit nodes are always skipped.",
        ),
      user: z.string().optional().describe("Remote user to set on every Host block"),
    },
    async ({ write, target, onlineOnly, includeShared, user }) => {
      try {
        const status = await ctx.provider.status();
        const nodes = onlineOnly ? status.peers.filter((p) => p.online) : status.peers;
        const opts = { user, includeShared };
        const plan = planHostBlocks(nodes, opts);
        const body = renderHostBlocks(plan, opts);
        const configText = managedBlock(body);
        const report = {
          hostCount: plan.entries.length,
          ...(plan.skipped.length > 0 && { skipped: plan.skipped }),
          ...(plan.renamed.length > 0 && { renamed: plan.renamed }),
        };

        if (!write) {
          return ok({
            dryRun: true,
            ...report,
            configText,
            note:
              "Nothing was written. Re-run with write=true to write " +
              `~/.ssh/${DEDICATED_FILE_NAME}, or additionally target="user_ssh_config" ` +
              "to edit ~/.ssh/config in place between managed markers.",
          });
        }

        if (ctx.readOnly) {
          throw new TailscaleError(
            "READ_ONLY",
            "This server runs in read-only mode, so nothing was written. The generated " +
              "config is available with write=false.",
            `Unset ${READONLY_ENV_VAR} in the MCP client config to allow writes.`,
          );
        }

        const dir = sshDir();
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });

        if (target === "user_ssh_config") {
          const configPath = join(dir, "config");
          const existing = await readConfig(configPath);
          // Throws on malformed markers before anything touches the disk.
          const updated = applyManagedBlock(existing ?? "", body);
          if (updated === existing) {
            return ok({ dryRun: false, ...report, wrote: null, note: "Already up to date; nothing changed." });
          }

          let backup: string | null = null;
          if (existing !== null) {
            backup = configPath + BACKUP_SUFFIX;
            await writeFileAtomic(backup, existing, 0o600);
          }
          // Write through a symlinked config (dotfile managers) instead of
          // replacing the link with a regular file.
          const realPath = existing !== null ? await fs.realpath(configPath) : configPath;
          const mode = (await existingMode(realPath)) ?? 0o600;
          await writeFileAtomic(realPath, updated, mode);
          return ok({
            dryRun: false,
            ...report,
            wrote: configPath,
            backup,
            note:
              "Updated the managed section between the tailscale-mcp markers; " +
              "content outside the markers was not touched." +
              (backup ? ` The previous version was saved to ${backup}.` : ""),
          });
        }

        const dedicatedPath = join(dir, DEDICATED_FILE_NAME);
        const mode = (await existingMode(dedicatedPath)) ?? 0o600;
        await writeFileAtomic(dedicatedPath, configText + "\n", mode);
        return ok({
          dryRun: false,
          ...report,
          wrote: dedicatedPath,
          instructions:
            `Add this line to the top of your ~/.ssh/config to activate it ` +
            `(not applied automatically):\n\nInclude ${DEDICATED_FILE_NAME}`,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}
