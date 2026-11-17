// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, inject } from "vitest";
import { closeDb } from "@direx/db";
import { closeAuthDb } from "@direx/db/auth";
import { rmSync } from "node:fs";
import { blockRealClis } from "../apps/api/src/modules/models/fake-cli";
import { asOwner, requireEnv, withDatabase } from "./db";

// No test may start a real Claude Code or Codex, even by accident: a login would open for real. The one
// exception is `bun run eval --provider claude_code|codex`, whose whole point is the real CLI.
const realCli = process.env.DIREX_EVAL_PURPOSE && ["claude_code", "codex"].includes(process.env.DIREX_EVAL_PROVIDER ?? "");
const blocked = realCli ? null : blockRealClis();

// One database per test file, cloned from the migrated template.
const database = `direx_t_${crypto.randomUUID().replaceAll("-", "")}`;
await asOwner((c) => c.query(`CREATE DATABASE ${database} TEMPLATE ${inject("template")}`));
process.env.DIREX_DB_APP_URL = withDatabase(requireEnv("DIREX_DB_APP_URL"), database);

afterAll(async () => {
  if (blocked) rmSync(blocked, { recursive: true, force: true });
  await closeDb();
  await closeAuthDb();
  await asOwner((c) => c.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`));
});
