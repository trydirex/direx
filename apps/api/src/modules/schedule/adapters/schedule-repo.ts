// SPDX-License-Identifier: AGPL-3.0-only
// Every schedule SQL statement. Reservations are only inserted, never updated or deleted.
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { people, touchReservations } from "@direx/db/schema";
import { outsideTouches } from "@direx/db/schema-outreach";
import type { CapName, ReservationRow, TouchClass } from "../domain/caps";

export const inWorkspace = withWorkspace;
export type ScheduleTx = WorkspaceTx;
export type OutsideTouchRow = typeof outsideTouches.$inferSelect;
export type NewOutsideTouch = Omit<typeof outsideTouches.$inferInsert, "id">;

/** Inserts a touch; one already recorded under the same source ref is returned instead. */
export async function insertOutsideTouch(tx: ScheduleTx, row: NewOutsideTouch): Promise<OutsideTouchRow> {
  const [inserted] = await tx.insert(outsideTouches).values(row).onConflictDoNothing().returning();
  if (inserted) return inserted;
  const [existing] = await tx
    .select()
    .from(outsideTouches)
    .where(and(eq(outsideTouches.source, row.source), eq(outsideTouches.sourceRef, row.sourceRef!)));
  return existing!;
}

/** When outbound outside touches happened for these records, in [from, to]. */
export async function outboundTouchesNear(tx: ScheduleTx, personIds: readonly string[], from: Date, to: Date): Promise<Date[]> {
  const rows = await tx
    .select({ at: outsideTouches.occurredAt })
    .from(outsideTouches)
    .where(and(inArray(outsideTouches.personId, [...personIds]), eq(outsideTouches.direction, "outbound"), gte(outsideTouches.occurredAt, from), lte(outsideTouches.occurredAt, to)));
  return rows.map((r) => r.at);
}

/** Every record in this record's group, read without taking the group's lock. */
export async function groupMembers(tx: ScheduleTx, personId: string): Promise<string[]> {
  const group = tx.select({ g: people.coordinationId }).from(people).where(eq(people.id, personId));
  return (await tx.select({ id: people.id }).from(people).where(inArray(people.coordinationId, group))).map((m) => m.id);
}

/** The same for a record's whole group, read without taking the group's lock. */
export async function groupOutboundTouchesNear(tx: ScheduleTx, personId: string, from: Date, to: Date): Promise<Date[]> {
  return outboundTouchesNear(tx, await groupMembers(tx, personId), from, to);
}
export type StoredReservation = typeof touchReservations.$inferSelect & { cap: CapName; touchClass: TouchClass };

/**
 * Every reservation of the Actions that hold one for these records with a slot in [from, to]. An
 * Action moved far away keeps its old rows, so its newest must be read wherever it lies.
 */
export async function reservationsAround(tx: ScheduleTx, personIds: readonly string[], from: Date, to: Date): Promise<ReservationRow[]> {
  const near = tx
    .select({ actionId: touchReservations.actionId })
    .from(touchReservations)
    .where(and(inArray(touchReservations.personId, [...personIds]), gte(touchReservations.slot, from), lte(touchReservations.slot, to)));
  const rows = await tx
    .select({ actionId: touchReservations.actionId, cap: touchReservations.cap, slot: touchReservations.slot, createdAt: touchReservations.createdAt })
    .from(touchReservations)
    .where(inArray(touchReservations.actionId, near));
  return rows as ReservationRow[];
}

/** Appends one reservation. The newest per Action and cap is the one that counts, so moving back to an earlier slot appends again. */
export async function insertReservation(
  tx: ScheduleTx,
  r: { workspaceId: string; actionId: string; personId: string; touchClass: TouchClass; cap: CapName; slot: Date; createdAt: Date },
): Promise<StoredReservation> {
  const [row] = await tx.insert(touchReservations).values(r).returning();
  return row as StoredReservation;
}

/** The Action's newest reservation against one cap. */
export async function newestReservation(tx: ScheduleTx, actionId: string, cap: CapName): Promise<StoredReservation | undefined> {
  const [row] = await tx
    .select()
    .from(touchReservations)
    .where(and(eq(touchReservations.actionId, actionId), eq(touchReservations.cap, cap)))
    .orderBy(desc(touchReservations.createdAt))
    .limit(1);
  return row as StoredReservation | undefined;
}
