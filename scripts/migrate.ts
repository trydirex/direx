// SPDX-License-Identifier: AGPL-3.0-only
// `bun run db:migrate`: applies pending migrations as the owner role (ADR 0003, ADR 0029).
// Stop Direx first; it refuses to start until this has run.
import { migrateDatabase } from "@direx/db/migrate";
import { fileURLToPath } from "node:url";

const url = process.env.DIREX_DB_OWNER_URL;
if (!url) {
  console.error("db:migrate: DIREX_DB_OWNER_URL is not set (copy .env.example to .env)");
  process.exit(1);
}
let n = 0;
try {
  const drifted = await migrateDatabase(url, fileURLToPath(new URL("../packages/db/migrations", import.meta.url)), (tag) => {
    n++;
    console.log(`applied ${tag}`);
  });
  console.log(n ? `db:migrate: ${n} applied` : "db:migrate: nothing to apply");
  for (const tag of drifted) console.warn(`db:migrate: warning: ${tag} changed after this database applied it; the database keeps the old version`);
} catch (e) {
  console.error(`db:migrate: ${(e as Error).message}`);
  process.exitCode = 1;
}
