// SPDX-License-Identifier: AGPL-3.0-only
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as authSchema from "./auth-schema";
import { getDb } from "./client";

// authDb is the handle Better Auth uses for its own tables. Only the
// identity module's adapters import this file; dependency-cruiser enforces it. It shares the
// app's pool and sets no workspace, so a query on a tenant table through it sees no rows.

export type AuthDb = NodePgDatabase<typeof authSchema> & { $client: Pool };
export { authSchema };

let db: AuthDb | undefined;

export function authDb(): AuthDb {
  if (!db) {
    db = drizzle({ client: getDb().$client, schema: authSchema });
  }
  return db;
}

export async function closeAuthDb(): Promise<void> {
  // The pool is closeDb's to end.
  db = undefined;
}
