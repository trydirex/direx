// SPDX-License-Identifier: AGPL-3.0-only
// Person records, their keys and their groups. Every change to a group takes the
// group's canonical row lock: one row for a reservation, several in ascending id order
// for a link. Refusals come back as values.
import type { CountryCode } from "libphonenumber-js";
import {
  decideLink,
  inWorkspace,
  insertKey,
  insertPerson,
  liveLinksAmong,
  lockKeyValue,
  lockRow,
  membersOf,
  mergeGroups,
  othersWithKey,
  proposeLink,
  readGroupIds,
  setGroup,
  setLockTimeout,
  type PeopleTx,
} from "../adapters/people-repo";
import { groupIds, ordered } from "../domain/groups";
import { normaliseKey, type KeyKind } from "./keys";

/** How long a transaction waits for a group lock before it gives up and retries. */
export const LOCK_TIMEOUT_MS = 5_000;
const TIMEOUT_RETRIES = 3;
/** A group only moves when another transaction commits, so hitting this means contention, not an outage. */
const MOVED_RETRIES = 100;

/** A group lock was waited on and its group moved meanwhile; the transaction starts again. */
export class Moved extends Error {}
const LOCK_NOT_AVAILABLE = "55P03";
const isLockTimeout = (e: unknown) =>
  typeof e === "object" && e !== null && ((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) === LOCK_NOT_AVAILABLE;

/**
 * Runs fn in its own workspace transaction, again with jitter when a lock wait timed out
 * or a group moved under it. A fourth timeout is an outage and throws. Moved groups get
 * far more retries, since each one means another transaction finished.
 */
export async function withGroupRetry<T>(workspaceId: string, fn: (tx: PeopleTx) => Promise<T>): Promise<T> {
  let timeouts = 0;
  let moved = 0;
  for (;;) {
    try {
      return await inWorkspace(workspaceId, async (tx) => {
        await setLockTimeout(tx, LOCK_TIMEOUT_MS);
        return fn(tx);
      });
    } catch (e) {
      if (e instanceof Moved) {
        if (++moved > MOVED_RETRIES) throw e;
      } else if (!isLockTimeout(e) || ++timeouts > TIMEOUT_RETRIES) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, Math.random() * 20 * Math.min(moved + timeouts, 10)));
    }
  }
}

/**
 * Locks the canonical rows of the groups these records are in, in ascending id order,
 * then re-reads their groups. Throws Moved when a group changed while it waited.
 */
async function lockGroupsOf(tx: PeopleTx, records: readonly string[]): Promise<Map<string, string>> {
  const before = await readGroupIds(tx, records);
  if (before.size !== new Set(records).size) throw new Error("person not found in this workspace");
  const groups = [...new Set(before.values())].sort();
  for (const g of groups) if (!(await lockRow(tx, g))) throw new Error("person group row not found in this workspace");
  const after = await readGroupIds(tx, records);
  for (const [id, g] of before) if (after.get(id) !== g) throw new Moved();
  return after;
}

export type Group = { groupId: string; members: string[] };

/**
 * Takes the Person group lock for this record inside the caller's transaction and
 * returns the group. The only way another module locks a Person. Throws when the record
 * is not in this workspace; a moved group is retried by withGroupRetry.
 */
export async function lockGroup(tx: PeopleTx, personId: string): Promise<Group> {
  const groups = await lockGroupsOf(tx, [personId]);
  const groupId = groups.get(personId)!;
  return { groupId, members: await membersOf(tx, groupId) };
}

export async function createPerson(workspaceId: string): Promise<string> {
  const id = crypto.randomUUID();
  await inWorkspace(workspaceId, (tx) => insertPerson(tx, workspaceId, id, new Date()));
  return id;
}

export type AddKeyResult = { ok: true; value: string; linkedTo: string[] } | { ok: false; reason: string };

/**
 * Adds a key to a record. Any other record holding the same key becomes a merge
 * candidate: a proposed link, and one group with the lowest id. Never a silent merge.
 */
export async function addKey(
  workspaceId: string,
  personId: string,
  kind: KeyKind,
  raw: string,
  opts: { defaultCountry?: CountryCode } = {},
): Promise<AddKeyResult> {
  const key = normaliseKey(kind, raw, opts);
  if (!key.ok) return key;
  return withGroupRetry(workspaceId, async (tx) => {
    const now = new Date();
    // Lock order: the key value, then the groups in ascending id order.
    await lockKeyValue(tx, workspaceId, kind, key.value);
    const others = await othersWithKey(tx, personId, kind, key.value);
    const groups = await lockGroupsOf(tx, [personId, ...others]);
    await insertKey(tx, workspaceId, personId, kind, key.value, now);
    for (const other of others) await proposeLink(tx, workspaceId, ...ordered(personId, other), now);
    const ids = [...new Set(groups.values())].sort();
    await mergeGroups(tx, ids.slice(1), ids[0]!);
    return { ok: true as const, value: key.value, linkedTo: others };
  });
}

export type LinkResult = { ok: true } | { ok: false; reason: "not_found" | "wrong_state" };

/** A person confirms two records are one Person. The group does not change. */
export function acceptLink(workspaceId: string, a: string, b: string, userId: string): Promise<LinkResult> {
  return withGroupRetry(workspaceId, async (tx) => {
    await lockGroupsOf(tx, [a]);
    const ok = await decideLink(tx, ...ordered(a, b), ["proposed"], "merged", userId, new Date());
    return ok ? { ok: true } : { ok: false, reason: "wrong_state" };
  });
}

/**
 * A person says two records are different people, or undoes a merge. Under the group
 * lock, the group is recomputed from its remaining live links and each part takes its
 * lowest id. Reservations keep their record, so nothing is reassigned.
 */
export function rejectLink(workspaceId: string, a: string, b: string, userId: string): Promise<LinkResult> {
  return withGroupRetry(workspaceId, async (tx) => {
    const groups = await lockGroupsOf(tx, [a, b]);
    if (groups.get(a) !== groups.get(b)) return { ok: false, reason: "wrong_state" };
    if (!(await decideLink(tx, ...ordered(a, b), ["proposed", "merged"], "rejected", userId, new Date()))) {
      return { ok: false, reason: "wrong_state" };
    }
    const members = await membersOf(tx, groups.get(a)!);
    const next = groupIds(members, await liveLinksAmong(tx, members));
    const byGroup = new Map<string, string[]>();
    for (const [id, g] of next) byGroup.set(g, [...(byGroup.get(g) ?? []), id]);
    for (const [g, ids] of byGroup) await setGroup(tx, ids, g);
    return { ok: true };
  });
}

/** The record's current group, without a lock: for display and tests. */
export function groupOf(workspaceId: string, personId: string): Promise<Group> {
  return inWorkspace(workspaceId, async (tx) => {
    const groupId = (await readGroupIds(tx, [personId])).get(personId);
    if (!groupId) throw new Error("person not found in this workspace");
    return { groupId, members: (await membersOf(tx, groupId)).sort() };
  });
}
