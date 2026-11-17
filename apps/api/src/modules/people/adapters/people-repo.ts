// SPDX-License-Identifier: AGPL-3.0-only
// Every people SQL statement. Only this file writes people.coordination_id or takes a
// lock on a people row.
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { identityKeys, people, personKeys, personLinks } from "@direx/db/schema";
import type { KeyKind } from "../application/keys";

export type PeopleTx = WorkspaceTx;
export type LinkState = "proposed" | "merged" | "rejected";

export function inWorkspace<T>(workspaceId: string, fn: (tx: PeopleTx) => Promise<T>): Promise<T> {
  return withWorkspace(workspaceId, fn);
}

/** Bounds the wait for a group lock in this transaction; a timeout is retried by the caller. */
export async function setLockTimeout(tx: PeopleTx, ms: number): Promise<void> {
  await tx.execute(sql`select set_config('lock_timeout', ${`${ms}ms`}, true)`);
}

export async function insertPerson(tx: PeopleTx, workspaceId: string, id: string, now: Date): Promise<void> {
  await tx.insert(people).values({ id, workspaceId, coordinationId: id, createdAt: now });
}

export async function readGroupIds(tx: PeopleTx, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await tx.select({ id: people.id, g: people.coordinationId }).from(people).where(inArray(people.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.g]));
}

/** FOR NO KEY UPDATE on one row. False when RLS hides it or it is gone: the caller treats that as an error. */
export async function lockRow(tx: PeopleTx, id: string): Promise<boolean> {
  const rows = await tx.select({ id: people.id }).from(people).where(eq(people.id, id)).for("no key update");
  return rows.length === 1;
}

export async function membersOf(tx: PeopleTx, groupId: string): Promise<string[]> {
  const rows = await tx.select({ id: people.id }).from(people).where(eq(people.coordinationId, groupId));
  return rows.map((r) => r.id);
}

export async function setGroup(tx: PeopleTx, ids: readonly string[], groupId: string): Promise<void> {
  if (ids.length) await tx.update(people).set({ coordinationId: groupId }).where(inArray(people.id, [...ids]));
}

/** Moves every record of the given groups into groupId. */
export async function mergeGroups(tx: PeopleTx, fromGroups: readonly string[], groupId: string): Promise<void> {
  if (fromGroups.length) {
    await tx.update(people).set({ coordinationId: groupId }).where(inArray(people.coordinationId, [...fromGroups]));
  }
}

export async function insertKey(tx: PeopleTx, workspaceId: string, personId: string, kind: KeyKind, value: string, now: Date) {
  await tx.insert(personKeys).values({ workspaceId, personId, kind, value, createdAt: now }).onConflictDoNothing();
}

/**
 * Locks one key value in this workspace. A concurrent insert of the same value waits on
 * the unique index until this transaction ends, so the other records holding it are
 * read only after every earlier holder committed.
 */
export async function lockKeyValue(tx: PeopleTx, workspaceId: string, kind: KeyKind, value: string): Promise<void> {
  await tx.insert(identityKeys).values({ workspaceId, kind, value }).onConflictDoNothing();
  await tx
    .select({ v: identityKeys.value })
    .from(identityKeys)
    .where(and(eq(identityKeys.kind, kind), eq(identityKeys.value, value)))
    .for("update");
}

export async function othersWithKey(tx: PeopleTx, personId: string, kind: KeyKind, value: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ id: personKeys.personId })
    .from(personKeys)
    .where(and(eq(personKeys.kind, kind), eq(personKeys.value, value), ne(personKeys.personId, personId)));
  return rows.map((r) => r.id);
}

/** Proposes a link; an existing one, whatever its state, is left as it is. */
export async function proposeLink(tx: PeopleTx, workspaceId: string, low: string, high: string, now: Date): Promise<void> {
  await tx.insert(personLinks).values({ workspaceId, lowId: low, highId: high, state: "proposed", createdAt: now }).onConflictDoNothing();
}

/** Moves a link from one of the given states to another. False when it was in none of them. */
export async function decideLink(
  tx: PeopleTx,
  low: string,
  high: string,
  from: readonly LinkState[],
  to: "merged" | "rejected",
  userId: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(personLinks)
    .set({ state: to, decidedByUserId: userId, decidedAt: now })
    .where(and(eq(personLinks.lowId, low), eq(personLinks.highId, high), inArray(personLinks.state, [...from])))
    .returning({ low: personLinks.lowId });
  return rows.length === 1;
}

export async function liveLinksAmong(tx: PeopleTx, ids: readonly string[]): Promise<[string, string][]> {
  if (!ids.length) return [];
  const rows = await tx
    .select({ low: personLinks.lowId, high: personLinks.highId })
    .from(personLinks)
    .where(and(ne(personLinks.state, "rejected"), or(inArray(personLinks.lowId, [...ids]), inArray(personLinks.highId, [...ids]))));
  return rows.map((r) => [r.low, r.high]);
}

export type PersonRow = { id: string; email: string };

/** People with an email key, oldest first; with personId, only that record. */
export async function listPeople(tx: PeopleTx, personId?: string): Promise<PersonRow[]> {
  const rows = await tx
    .select({ id: people.id, email: personKeys.value })
    .from(people)
    .innerJoin(personKeys, and(eq(personKeys.personId, people.id), eq(personKeys.kind, "email")))
    .where(personId ? eq(people.id, personId) : undefined)
    .orderBy(people.createdAt)
    .limit(1000);
  return rows;
}

export async function personIdWithEmail(tx: PeopleTx, email: string): Promise<string | null> {
  const [row] = await tx.select({ id: personKeys.personId }).from(personKeys).where(and(eq(personKeys.kind, "email"), eq(personKeys.value, email))).limit(1);
  return row?.id ?? null;
}

/** Every email of the records in this Person's group. */
export async function emailsOfGroup(tx: PeopleTx, personId: string): Promise<string[]> {
  const group = (await readGroupIds(tx, [personId])).get(personId);
  if (!group) return [];
  const members = await membersOf(tx, group);
  const rows = await tx.select({ value: personKeys.value }).from(personKeys).where(and(eq(personKeys.kind, "email"), inArray(personKeys.personId, members)));
  return rows.map((r) => r.value);
}
