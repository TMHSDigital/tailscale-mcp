import { defineConfig } from "vitest/config";

// Contract tests run against the real tailscale binary (see
// src/__tests__/contract/cli.contract.ts); `npm test` never includes them.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/contract/**/*.contract.ts"],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
