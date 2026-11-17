// SPDX-License-Identifier: AGPL-3.0-only
// Reading and removing touches Direx didn't send. Recording one goes through schedule, under the group lock.
import { people, personKeys } from "@direx/db/schema";
import { outsideTouches } from "@direx/db/schema-outreach";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import type { OutreachTx } from "./repo";

export type OutsideTouch = typeof outsideTouches.$inferSelect;

export async function personExists(tx: OutreachTx, personId: string): Promise<boolean> {
  const [row] = await tx.select({ id: people.id }).from(people).where(eq(people.id, personId));
  return Boolean(row);
}

export function outsideTouchesOf(tx: OutreachTx, personId: string, since: Date): Promise<OutsideTouch[]> {
  return tx
    .select()
    .from(outsideTouches)
    .where(and(eq(outsideTouches.personId, personId), gte(outsideTouches.occurredAt, since)))
    .orderBy(desc(outsideTouches.occurredAt));
}

/** The LinkedIn and X profiles saved on a Person, oldest first. */
export function profilesOf(tx: OutreachTx, personId: string): Promise<{ kind: "linkedin" | "x"; url: string }[]> {
  return tx
    .select({ kind: personKeys.kind, url: personKeys.value })
    .from(personKeys)
    .where(and(eq(personKeys.personId, personId), inArray(personKeys.kind, ["linkedin", "x"])))
    .orderBy(asc(personKeys.createdAt)) as Promise<{ kind: "linkedin" | "x"; url: string }[]>;
}

export async function outsideTouch(tx: OutreachTx, personId: string, id: string): Promise<OutsideTouch | undefined> {
  const [row] = await tx.select().from(outsideTouches).where(and(eq(outsideTouches.personId, personId), eq(outsideTouches.id, id)));
  return row;
}

/** The database allows it only for a manual entry under 10 minutes old; false otherwise. */
export async function deleteOutsideTouch(tx: OutreachTx, id: string): Promise<boolean> {
  const rows = await tx.delete(outsideTouches).where(eq(outsideTouches.id, id)).returning({ id: outsideTouches.id });
  return rows.length > 0;
}
