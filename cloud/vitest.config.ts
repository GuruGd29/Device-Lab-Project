import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Run tests against contracts SOURCE so no prebuild of the workspace is required.
      "@device-lab/contracts": fileURLToPath(
        new URL("../packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    globalSetup: ["./test/globalSetup.ts"],
    // Reservation tests hit a real Postgres (atomicity can't be faked with an in-memory shim).
    // They share one DB, so run serially to keep state deterministic.
    fileParallelism: false,
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
