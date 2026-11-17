// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const sdk = fileURLToPath(new URL("./packages/plugin-sdk/src/index.ts", import.meta.url));
const sdkHost = fileURLToPath(new URL("./packages/plugin-sdk/src/host.ts", import.meta.url));
// On a CI runner, with coverage on and three files at the database at once, a test that walks a
// whole screen or writes twenty approvals has run past the 5 s default while every step passed.
const testTimeout = process.env.CI ? 15_000 : 5_000;

export default defineConfig({
  test: {
    // Each file may open a pool of 10 plus clients and pg-boss, and Postgres allows 100 connections.
    // CI runners have 4 vCPUs and some tests spawn eslint, depcruise or ffmpeg, so six workers there
    // starve each other into timeouts.
    maxWorkers: process.env.CI ? 3 : 6,
    // Root-only option; the node project's database drops need it (see hookTimeout there).
    teardownTimeout: 60_000,
    coverage: {
      provider: "v8",
      reporter: ["lcovonly"],
      include: ["apps/**/*.{ts,tsx}", "packages/**/*.ts"],
      exclude: ["**/*.test.{ts,tsx}", "**/test/**"],
    },
    projects: [
      {
        test: {
          name: "node",
          // The web app's `@/` is its src/; its HTML-render tests run here. The SDK resolves to its
          // source, as the "bun" export condition does for Bun and tsc, under its alias and, for the
          // example plugin, its npm name.
          // Exact matches, so the host entry ("/host") isn't read as a path under index.ts.
          alias: [
            { find: "@", replacement: fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
            { find: /^@(direx|trydirex)\/plugin-sdk$/, replacement: sdk },
            { find: /^@(direx|trydirex)\/plugin-sdk\/host$/, replacement: sdkHost },
          ],
          testTimeout,
          globalSetup: ["./test/global-setup.ts"],
          setupFiles: ["./test/setup.ts"],
          include: ["**/*.test.ts"],
          // A *.real.test.ts calls a real model with a key, so only `bun run eval` (which sets DIREX_EVAL_PURPOSE) runs it.
          exclude: ["**/node_modules/**", "**/dist/**", "**/fixtures/**", ...(process.env.DIREX_EVAL_PURPOSE ? [] : ["**/*.real.test.ts"])],
          // Each file drops its database after its tests, and DROP DATABASE waits for a forced checkpoint,
          // which took up to 17 s with six files writing at once. Past the 10 s default, the drop is cut off
          // while pg-boss still runs, and its connection errors fail the run after every test passed.
          hookTimeout: 60_000,
        },
      },
      {
        // Web tests that need a browser: a DOM, no database.
        test: {
          name: "web",
          environment: "happy-dom",
          testTimeout,
          setupFiles: ["apps/web/src/test-setup.ts"],
          alias: { "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
          include: ["apps/web/**/*.test.tsx"],
          exclude: ["**/node_modules/**", "**/dist/**"],
        },
      },
    ],
  },
});
