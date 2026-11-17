// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync } from "node:fs";
import pg from "pg";
import { migrate } from "@direx/db/migrate";
import { asOwner, requireEnv, withDatabase } from "./db";

// Under `bun --bun vitest` the main process does not see the .env Bun loaded.
if (existsSync(".env")) process.loadEnvFile(".env");

// One template per run, so parallel runs cannot drop each other's.
const TEMPLATE = `direx_template_${crypto.randomUUID().replaceAll("-", "")}`;

// Migrate once into a template; each test file clones it.
export default async function setup({ provide }: { provide: (key: "template", value: string) => void }) {
  const appPassword = decodeURIComponent(new URL(requireEnv("DIREX_DB_APP_URL")).password);

  await asOwner(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${TEMPLATE}`);
  });

  const owner = new pg.Client(withDatabase(requireEnv("DIREX_DB_OWNER_URL"), TEMPLATE));
  await owner.connect();
  try {
    await migrate(owner, "packages/db/migrations");
    // Roles are cluster-wide; give direx_app the password the test URL expects.
    await owner.query(`ALTER ROLE direx_app PASSWORD ${pg.escapeLiteral(appPassword)}`);
  } finally {
    // No open connection may remain, or CREATE DATABASE ... TEMPLATE fails.
    await owner.end();
  }
  provide("template", TEMPLATE);

  return async () => {
    await asOwner((c) => c.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`));
  };
}
