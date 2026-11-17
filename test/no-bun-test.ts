// SPDX-License-Identifier: AGPL-3.0-only
// `bun test` is Bun's own runner: it loads .env and skips test/setup.ts, so every test would run
// against the developer's own database instead of a throwaway one. Tests run through vitest only.
throw new Error("Run the tests with `bun run test`. `bun test` skips the per-file test database and would write to your dev database.");
