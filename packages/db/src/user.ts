// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm";
import { getDb, UUID } from "./client";
import type { WorkspaceTx } from "./index";

// For a signed-in user who has not picked a Workspace: list theirs, nothing else.
// Read-only, and sets no workspace. Only identity/adapters imports it.
export function withUser<T>(userId: string, fn: (tx: WorkspaceTx) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new Error("withUser: userId must be a uuid");
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
