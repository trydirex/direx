// SPDX-License-Identifier: AGPL-3.0-only
import { PgBoss } from "pg-boss";

// The app connects as direx_app; the owner migrates the pgboss schema.
// reindex needs index ownership, so it is off; partitioned queues are created in migrations.
// A process that doesn't consume (the `api` role, ADR 0027 rule 002) still sends, but fires no cron
// schedule and runs no maintenance: pg-boss's `schedule` and `supervise` only arm those two timers.
export function createBoss({ consume = true }: { consume?: boolean } = {}): PgBoss {
  const connectionString = process.env.DIREX_DB_APP_URL;
  if (!connectionString) throw new Error("DIREX_DB_APP_URL is not set");
  return new PgBoss(bossConfig(connectionString, consume));
}

export const bossConfig = (connectionString: string, consume: boolean) => ({ connectionString, schema: "pgboss", migrate: false, createSchema: false, reindex: false, schedule: consume, supervise: consume });
