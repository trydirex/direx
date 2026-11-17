// SPDX-License-Identifier: AGPL-3.0-only
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema";

// The one pool, shared by withWorkspace, withUser, withSystem and authDb. Not in the package's
// exports, so nothing outside packages/db can reach it.

export type Db = NodePgDatabase<typeof schema> & { $client: Pool };

let db: Db | undefined;

export function getDb(): Db {
  if (!db) {
    const url = process.env.DIREX_DB_APP_URL;
    if (!url) throw new Error("DIREX_DB_APP_URL is not set");
    // Concurrency tests raise the pool size to open as many connections as workers.
    db = drizzle({ connection: { connectionString: url, max: Number(process.env.DIREX_DB_POOL_MAX ?? 10) }, schema });
  }
  return db;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function closeDb(): Promise<void> {
  await db?.$client.end();
  db = undefined;
}
