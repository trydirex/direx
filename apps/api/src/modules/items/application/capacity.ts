// SPDX-License-Identifier: AGPL-3.0-only
// Where an Action planned for a time takes its place (ADR 0038). Every path that sets a time calls
// this port; the composition root decides which account each capability counts against. Without one,
// only Mailboxes count, as ADR 0019 set out.
import { nextMailboxTime, reserveMailbox, reserveMailboxIn, type MailboxReserveResult } from "../../schedule";
import type { ItemsTx } from "../adapters/repo";
import type { Warning } from "../domain/warnings";

/** `auto` lets the account move a time within its day; `exact` keeps the time a person set. */
export type Placement = "auto" | "exact";

/** A time about to be set. `seed` is the Action's idempotency key, known before the Action exists. */
export type PlaceTarget = { capability: string; credentialId: string | null; spec: unknown; seed: string; wanted: Date; mode: Placement; exceptActionId?: string };

/** The time to set, and a warning when an exact time falls outside its account's pace. */
export type Placed = { at: Date; warning?: Warning };

/** `day` and `limit` name the day that was full. */
export type CapacityResult = MailboxReserveResult;

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
