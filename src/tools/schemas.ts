// Output schemas for every tool. Each successful result carries the payload as
// `structuredContent` (validated against these by the SDK) and, for older
// clients, as a JSON text block. Error results (isError) are not validated.

import { z } from "zod";

export const nodeSchema = z.object({
  hostname: z.string(),
  dnsName: z.string(),
  ipv4: z.string().nullable(),
  ipv6: z.string().nullable(),
  os: z.string(),
  online: z.boolean(),
  lastSeen: z.string().nullable(),
  exitNode: z.boolean(),
  exitNodeOption: z.boolean(),
  tags: z.array(z.string()),
  sharee: z.boolean(),
});

export const tailnetStatusOutput = {
  backendState: z.string(),
  tailnet: z.string(),
  magicDNSSuffix: z.string(),
  health: z.array(z.string()),
  self: nodeSchema,
  peerCount: z.number().describe("Total peers, before any onlineOnly filter"),
  peers: z.array(nodeSchema),
};

export const sshConfigOutput = {
  dryRun: z.boolean(),
  hostCount: z.number(),
  skipped: z
    .array(
      z.object({
        hostname: z.string(),
        dnsName: z.string(),
        reason: z.enum(["no_address", "mullvad_exit_node", "shared_node"]),
      }),
    )
    .optional(),
  renamed: z
    .array(z.object({ from: z.string(), to: z.string(), hostname: z.string() }))
    .optional(),
  configText: z.string().optional().describe("Generated config (dry run)"),
  wrote: z.string().nullable().optional().describe("File written; null when nothing changed"),
  backup: z.string().nullable().optional(),
  instructions: z.string().optional(),
  note: z.string().optional(),
};

export const endpointSchema = z.object({
  url: z.string(),
  host: z.string(),
  httpsPort: z.number(),
  scheme: z.enum(["https", "http"]),
  path: z.string(),
  target: z.string().nullable(),
  targetType: z.enum(["proxy", "path", "text", "redirect", "unknown"]),
  public: z.boolean(),
  foreground: z.boolean(),
});

const shareStatusShape = {
  active: z.boolean(),
  publicExposure: z
    .boolean()
    .nullable()
    .describe("True when any endpoint is exposed via Funnel; null if unknown (old CLI)"),
  endpoints: z.array(endpointSchema),
  tcpForwards: z
    .array(
      z.object({
        port: z.number(),
        target: z.string(),
        public: z.boolean(),
        foreground: z.boolean(),
      }),
    )
    .optional(),
  status: z.string().optional().describe("Raw text status, only on CLIs without --json"),
};

export const shareStatusOutput = shareStatusShape;

export const sharePortOutput = {
  port: z.number(),
  public: z.boolean(),
  scope: z.string(),
  urls: z.array(z.string()),
};

const mountSchema = z.object({ httpsPort: z.number(), path: z.string() });

export const stopShareOutput = {
  stopped: z.union([z.literal("all"), mountSchema, z.array(mountSchema)]),
  removed: z.array(endpointSchema),
  remaining: z.object(shareStatusShape),
  failures: z
    .array(z.object({ httpsPort: z.number(), path: z.string(), error: z.string() }))
    .optional(),
};

export const pingAllOutput = {
  pinged: z.number(),
  reachable: z.number(),
  timedOut: z.boolean(),
  matrix: z.array(
    z.object({
      hostname: z.string(),
      dnsName: z.string(),
      target: z.string(),
      reachable: z.boolean(),
      latencyMs: z.number().nullable(),
      path: z.enum(["direct", "derp", "peer-relay", "unknown"]).nullable(),
      via: z.string().nullable(),
      attempts: z.number(),
      replies: z.number(),
      error: z.string().optional(),
    }),
  ),
};
