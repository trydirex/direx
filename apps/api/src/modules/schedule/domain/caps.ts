// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the frequency caps. No I/O; the clock comes in as an argument.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WINDOW_MS = 30 * DAY;

export type TouchClass = "cold" | "sales_follow_up" | "reply_in_thread" | "service" | "transactional" | "consented_marketing";
export type CapName = "general" | "consented_marketing";
export type Cap = { minGapMs: number; per30Days: number };

/** [DEFAULT] values; per-workspace settings come with the workspaces table. */
export const CAPS = {
  general: { minGapMs: 3 * DAY, per30Days: 5 },
  consented_marketing: { minGapMs: 2 * DAY, per30Days: 8 },
} as const satisfies Record<CapName, Cap>;

/**
 * Which caps each class reserves against. Sales follow-up always counts: whether the
 * Person is engaged needs deals and inbound mail, so the stricter result applies.
 */
export const CAPS_BY_CLASS: Record<TouchClass, readonly CapName[]> = {
  cold: ["general"],
  sales_follow_up: ["general"],
  consented_marketing: ["general", "consented_marketing"],
  reply_in_thread: [],
  service: [],
  transactional: [],
};

/** Classes a touch Direx didn't send holds to the cold gap. Consented marketing isn't cold. */
export const HELD_BY_OUTSIDE_TOUCHES: ReadonlySet<TouchClass> = new Set(["cold", "sales_follow_up"]);

/** A reservation past its slot by this much stops counting, unless its Touch went out or may have. */
export const RESERVATION_GRACE_MS = 24 * HOUR;

export type ActionState = { state: string; holdReason: string | null; outcomeUnknownAt?: Date | null };
export type ReservationRow = { actionId: string; cap: CapName; slot: Date; createdAt: Date };

/** Whether one reservation still counts, from its Action's live state. */
export function counts(slot: Date, action: ActionState | undefined, now: Date): boolean {
  // A missing Action can't happen under the foreign key; counting it is the safe side.
  if (!action) return true;
  const { state, holdReason } = action;
  if (state === "sent" || state === "claimed" || state === "dispatching") return true;
  if (state === "held" && holdReason === "outcome_unknown") return true;
  // A resend blocked after an unknown call may still have gone out the first time.
  if (action.outcomeUnknownAt) return true;
  if (state === "cancelled" || state === "blocked") return false;
  return slot.getTime() + RESERVATION_GRACE_MS > now.getTime();
}

/**
 * The slots that count against one cap: per Action only its newest reservation, and
 * only while it counts.
 */
export function countedSlots(
  rows: readonly ReservationRow[],
  cap: CapName,
  states: ReadonlyMap<string, ActionState>,
  now: Date,
  exceptActionId?: string,
): Date[] {
  const newest = new Map<string, ReservationRow>();
  for (const r of rows) {
    if (r.cap !== cap || r.actionId === exceptActionId) continue;
    const seen = newest.get(r.actionId);
    if (!seen || r.createdAt > seen.createdAt) newest.set(r.actionId, r);
  }
  return [...newest.values()].filter((r) => counts(r.slot, states.get(r.actionId), now)).map((r) => r.slot);
}

/**
 * Rolling on both sides of the slot: no counted Touch within the gap either way, and no
 * 30-day window [start, start + 30 days) that contains the slot holds more than the cap.
 * `gapOnly` are touches Direx didn't send: they hold the gap but never fill the window.
 */
export function fits(cap: Cap, slot: Date, counted: readonly Date[], gapOnly: readonly Date[] = []): boolean {
  const s = slot.getTime();
  const ts = counted.map((d) => d.getTime());
  if ([...counted, ...gapOnly].some((d) => Math.abs(d.getTime() - s) < cap.minGapMs)) return false;
  // The count only rises when a window's end passes a Touch, so the fullest windows
  // start just after slot - 30 days or just after some Touch's t - 30 days.
  const starts = [s - WINDOW_MS + 1, ...ts.map((t) => t - WINDOW_MS + 1)].filter((st) => st > s - WINDOW_MS && st <= s);
  return starts.every((st) => ts.filter((t) => t >= st && t < st + WINDOW_MS).length + 1 <= cap.per30Days);
}
