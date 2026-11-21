// SPDX-License-Identifier: AGPL-3.0-only
// Reserves a Touch's slot under its Person group's lock: lock, re-read the group, load
// what counts around the slot, check every cap, insert. One transaction, no network or
// model call inside it. Lock order: the group row first; the reservation's foreign key
// then takes a key-share lock on the Action row, never the other way round.
import { actionStates } from "../../ledger";
import { lockGroup, withGroupRetry } from "../../people";
import { insertReservation, newestReservation, outboundTouchesNear, reservationsAround, type ScheduleTx } from "../adapters/schedule-repo";
import { CAPS, CAPS_BY_CLASS, HELD_BY_OUTSIDE_TOUCHES, countedSlots, fits, type CapName } from "../domain/caps";
import { touchOf } from "./touch";

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type ReserveResult =
  | { kind: "reserved"; reservationIds: string[] }
  /** The class doesn't count against any cap, so there is nothing to reserve. */
  | { kind: "not_counted" }
  | { kind: "full"; cap: CapName }
  /** The Action's spec doesn't say whom it reaches. */
  | { kind: "undeclared" }
  | { kind: "not_found" };

/**
 * Reserves the slot for an Action's Touch, read from its spec. Call it before approving
 * the Action with dueAt = slot, and again before resuming one held with reason "cap".
 * Calling it twice for the same Action and slot returns the same reservations.
 */
export function reserveTouch(workspaceId: string, actionId: string, slot: Date, opts: { now?: Date } = {}): Promise<ReserveResult> {
  return withGroupRetry(workspaceId, (tx) => reserveTouchIn(tx, workspaceId, actionId, slot, opts.now ?? new Date()));
}

/** Reserve on the caller's transaction; the caller must retry the whole operation on group contention. */
export async function reserveTouchIn(tx: ScheduleTx, workspaceId: string, actionId: string, slot: Date, now: Date): Promise<ReserveResult> {
  const action = (await actionStates(tx, [actionId])).get(actionId);
  if (!action) return { kind: "not_found" };
  const touch = touchOf(action.spec);
  if (!touch) return { kind: "undeclared" };
  const caps = CAPS_BY_CLASS[touch.touchClass];
  if (!caps.length) return { kind: "not_counted" };

  const group = await lockGroup(tx, touch.personId);
  const from = new Date(slot.getTime() - WINDOW_MS);
  const to = new Date(slot.getTime() + WINDOW_MS);
  const rows = await reservationsAround(tx, group.members, from, to);
  const states = await actionStates(tx, [...new Set(rows.map((r) => r.actionId))]);
  // Touches Direx didn't send hold a cold Touch to the gap, without counting toward the 30 days.
  const gap = CAPS.general.minGapMs;
  const outside = HELD_BY_OUTSIDE_TOUCHES.has(touch.touchClass)
    ? await outboundTouchesNear(tx, group.members, new Date(slot.getTime() - gap), new Date(slot.getTime() + gap))
    : [];
  for (const cap of caps) {
    // The Action's own older reservations never block its new one.
    if (!fits(CAPS[cap], slot, countedSlots(rows, cap, states, now, actionId), cap === "general" ? outside : [])) return { kind: "full", cap };
  }
  const reservationIds: string[] = [];
  for (const cap of caps) {
    // Already holding this slot for the same Person and class: the group lock makes this check
    // safe, and nothing is added. A changed Touch reserves again, or the Dispatcher can't match it.
    const newest = await newestReservation(tx, actionId, cap);
    if (newest && newest.slot.getTime() === slot.getTime() && newest.personId === touch.personId && newest.touchClass === touch.touchClass) {
      reservationIds.push(newest.id);
      continue;
    }
    const r = await insertReservation(tx, {
      workspaceId,
      actionId,
      personId: touch.personId,
      touchClass: touch.touchClass,
      cap,
      slot,
      // Wall time, not the caller's clock: it orders an Action's reservations.
      createdAt: new Date(),
    });
    reservationIds.push(r.id);
  }
  return { kind: "reserved", reservationIds };
}
