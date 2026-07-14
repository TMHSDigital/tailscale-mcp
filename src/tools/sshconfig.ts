import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./index.js";
import { fail, ok } from "./helpers.js";
import {
  applyManagedBlock,
  DEDICATED_FILE_NAME,
  managedBlock,
  renderHostBlocks,
} from "../sshconfig.js";

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
      "idempotent between managed markers, never touching content outside them.",
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
      user: z.string().optional().describe("Remote user to set on every Host block"),
    },
    async ({ write, target, onlineOnly, user }) => {
      try {
        const status = await ctx.provider.status();
        const nodes = onlineOnly ? status.peers.filter((p) => p.online) : status.peers;
        const body = renderHostBlocks(nodes, { user });
        const configText = managedBlock(body);
        const hostCount = body === "" ? 0 : body.split("\n\n").length;

        if (!write) {
          return ok({
            dryRun: true,
            hostCount,
            configText,
            note:
              "Nothing was written. Re-run with write=true to write " +
              `~/.ssh/${DEDICATED_FILE_NAME}, or additionally target="user_ssh_config" ` +
              "to edit ~/.ssh/config in place between managed markers.",
          });
        }

        const dir = sshDir();
        await fs.mkdir(dir, { recursive: true });

        if (target === "user_ssh_config") {
          const configPath = join(dir, "config");
          let existing = "";
          try {
            existing = await fs.readFile(configPath, "utf-8");
          } catch {
            // No existing config; start fresh.
          }
          const updated = applyManagedBlock(existing, body);
          await fs.writeFile(configPath, updated, "utf-8");
          return ok({
            dryRun: false,
            hostCount,
            wrote: configPath,
            note:
              "Updated the managed section between the tailscale-mcp markers; " +
              "content outside the markers was not touched.",
          });
        }

        const dedicatedPath = join(dir, DEDICATED_FILE_NAME);
        await fs.writeFile(dedicatedPath, configText + "\n", "utf-8");
        return ok({
          dryRun: false,
          hostCount,
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
