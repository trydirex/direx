// SPDX-License-Identifier: AGPL-3.0-only
// The ledger check for Touches, run at claim and again at dispatch. It reads without a
// lock: the cap was enforced when the reservation was inserted.
import type { EffectCapability } from "@direx/plugin-sdk";
import { storedSpec } from "@direx/plugin-sdk/host";
import { z } from "zod";
import type { ActionRow, Check, CheckResult, LedgerTx } from "../../ledger";
import { groupOutboundTouchesNear, newestReservation } from "../adapters/schedule-repo";
import { CAPS, CAPS_BY_CLASS, HELD_BY_OUTSIDE_TOUCHES, RESERVATION_GRACE_MS } from "../domain/caps";
import { touchOf } from "./touch";

const OK: CheckResult = { kind: "ok" };

export const NEWSLETTER_LIST_CAPABILITY = "newsletter.publish";
const listAudience = z.strictObject({ kind: z.literal("newsletter_list"), credentialId: z.uuid() });

/** A newsletter issue naming as its audience the very list its Action sends through. */
export function isListIssue(row: Pick<ActionRow, "capability" | "credentialId" | "spec">): boolean {
  if (row.capability.split("/").at(-1) !== NEWSLETTER_LIST_CAPABILITY) return false;
  const a = listAudience.safeParse(storedSpec("newsletter.publish", row.spec).audience);
  return a.success && row.credentialId !== null && a.data.credentialId === row.credentialId;
}

/**
 * Blocks a Touch that doesn't say whom it reaches, and holds one with reason "cap" unless
 * it has a live reservation for this Person, class and due time.
 */
export function touchCheck(deps: { effects: Record<string, EffectCapability>; now: () => Date }): Check {
  return async (tx: LedgerTx, row: ActionRow): Promise<CheckResult> => {
    const touch = touchOf(row.spec);
    if (!touch) {
      if (!deps.effects[row.capability]?.reachesPerson) return OK;
      // A newsletter issue reaches the list it is sent through, not a Person, and counts against no
      // Person's cap. Only that one capability may say so, and only for its own credential.
      if (isListIssue(row)) return OK;
      return { kind: "block", reason: "touch_undeclared", detail: "the effect reaches a Person but the spec names none" };
    }
    const now = deps.now().getTime();
    for (const cap of CAPS_BY_CLASS[touch.touchClass]) {
      const r = await newestReservation(tx, row.id, cap);
      const live =
        r &&
        r.personId === touch.personId &&
        r.touchClass === touch.touchClass &&
        row.dueAt !== null &&
        r.slot.getTime() === row.dueAt.getTime() &&
        r.slot.getTime() + RESERVATION_GRACE_MS > now;
      if (!live) return { kind: "hold", reason: "cap", detail: `no live ${cap} reservation for this slot` };
    }
    // A call or hand-sent message logged after the reservation was made.
    if (HELD_BY_OUTSIDE_TOUCHES.has(touch.touchClass) && row.dueAt) {
      const gap = CAPS.general.minGapMs;
      const due = row.dueAt.getTime();
      const outside = await groupOutboundTouchesNear(tx, touch.personId, new Date(due - gap + 1), new Date(due + gap - 1));
      if (outside.length) return { kind: "hold", reason: "cap", detail: "a touch Direx didn't send is within the gap" };
    }
    return OK;
  };
}
