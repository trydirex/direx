// SPDX-License-Identifier: AGPL-3.0-only
// Where an Action planned for a time takes its place (ADR 0038). Every path that sets a time calls
// this port; the composition root decides which account each capability counts against. Without one,
// only Mailboxes count, as ADR 0019 set out.
import { nextMailboxTime, reserveMailbox, reserveMailboxIn, type MailboxReserveResult } from "../../schedule";
import { inWorkspace, itemIdByAction, readItem, type ItemsTx } from "../adapters/repo";
import type { Warning } from "../domain/warnings";

/** `auto` lets the account move a time within its day; `exact` keeps the time a person set. */
export type Placement = "auto" | "exact";

/** A time about to be set. `seed` is the Action's idempotency key, known before the Action exists. */
export type PlaceTarget = { capability: string; credentialId: string | null; spec: unknown; seed: string; wanted: Date; mode: Placement; exceptActionId?: string };

/** The time to set, and a warning when an exact time falls outside its account's pace. */
export type Placed = { at: Date; warning?: Warning };

/** `day` and `limit` name the day that was full; `reason` is the refusal a person sees, when it isn't a Mailbox's. */
export type CapacityResult = MailboxReserveResult | { kind: "full"; day: string; limit: number; reason: "account_day_full" };

export type CapacityPort = {
  placeIn(tx: ItemsTx, workspaceId: string, t: PlaceTarget, now: Date): Promise<Placed>;
  reserveIn(tx: ItemsTx, workspaceId: string, actionId: string, slot: Date, now: Date): Promise<CapacityResult>;
  reserve(workspaceId: string, actionId: string, slot: Date, opts?: { now?: Date }): Promise<CapacityResult>;
  nextTime(workspaceId: string, actionId: string, from: Date, opts?: { now?: Date }): Promise<Date | null>;
};

/** Mailboxes only: a time is never moved here, and the day's limit is ADR 0019's. */
export const mailboxCapacity: CapacityPort = {
  placeIn: async (_tx, _workspaceId, t) => ({ at: t.wanted }),
  reserveIn: reserveMailboxIn,
  reserve: reserveMailbox,
  nextTime: nextMailboxTime,
};

/** The capability behind an Action, read through its Item. */
async function capabilityOf(tx: ItemsTx, actionId: string): Promise<string> {
  const itemId = await itemIdByAction(tx, actionId);
  return (itemId && (await readItem(tx, itemId))?.action?.capability) || "";
}

/**
 * One port that sends each Action to the port `route` names for its capability, and every other one
 * to `fallback`. The composition root uses it to put Social accounts beside Mailboxes.
 */
export function routeCapacity(route: (capability: string) => CapacityPort | undefined, fallback: CapacityPort = mailboxCapacity): CapacityPort {
  const pick = async (tx: ItemsTx, actionId: string) => route(await capabilityOf(tx, actionId)) ?? fallback;
  return {
    placeIn: (tx, workspaceId, t, now) => (route(t.capability) ?? fallback).placeIn(tx, workspaceId, t, now),
    reserveIn: async (tx, workspaceId, actionId, slot, now) => (await pick(tx, actionId)).reserveIn(tx, workspaceId, actionId, slot, now),
    reserve: async (workspaceId, actionId, slot, opts) => (await inWorkspace(workspaceId, (tx) => pick(tx, actionId))).reserve(workspaceId, actionId, slot, opts),
    nextTime: async (workspaceId, actionId, from, opts) => (await inWorkspace(workspaceId, (tx) => pick(tx, actionId))).nextTime(workspaceId, actionId, from, opts),
  };
}
