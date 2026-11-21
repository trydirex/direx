// SPDX-License-Identifier: AGPL-3.0-only
// Manual moves use separate transactions, in an order that fails safe: once the
// new slot is reserved, the old time no longer matches the newest reservation, so a crash
// before the last step holds the Action instead of sending at the old time. Repeating the
// move finishes it.
import type { Actor, Ledger, Refusal } from "../../ledger";
import { withGroupRetry } from "../../people";
import { lockTouchGroup, reserveTouch, reserveTouchIn } from "../../schedule";
import { inWorkspace, lockOwnItem, readItem, setPlannedAt } from "../adapters/repo";
import { canMove, type OwnState } from "../domain/state";
import type { CapacityPort } from "./capacity";
import type { Decided } from "./decide";
import { toView } from "./view";

export type MoveStep = "reserved" | "planned";

// A refusal after taking a reservation must roll the reservation back too.
class RedateRefused extends Error {
  constructor(readonly reason: Refusal) {
    super(reason);
  }
}

export function moves({ ledger, now, onStep, capacity }: { ledger: Ledger; now: () => Date; onStep?: ((step: MoveStep) => void | Promise<void>) | undefined; capacity: CapacityPort }) {
  const api = {
    async moveItem(workspaceId: string, id: string, plannedAt: Date, actor: Actor): Promise<Decided> {
      const at = now();
      if (plannedAt <= at) return { ok: false, reason: "slot_in_past" };
      const row = await inWorkspace(workspaceId, (tx) => readItem(tx, id));
      if (!row) return { ok: false, reason: "not_found" };
      const { item, action } = row;
      const code = action?.holdReason ?? null;
      if (code === "outcome_unknown") return { ok: false, reason: "outcome_unknown" };
      if (!canMove(action ? action.state : (item.state as OwnState), code)) return { ok: false, reason: "wrong_state" };

      if (item.actionId) {
        const reserved = await reserveTouch(workspaceId, item.actionId, plannedAt, { now: at });
        if (reserved.kind === "full") return { ok: false, reason: "slot_full", cap: reserved.cap };
        if (reserved.kind === "not_found") return { ok: false, reason: "not_found" };
        const day = await capacity.reserve(workspaceId, item.actionId, plannedAt, { now: at });
        if (day.kind === "full") return { ok: false, reason: "reason" in day ? day.reason : "mailbox_day_full", day: day.day, limit: day.limit };
      }
      await onStep?.("reserved");
      await inWorkspace(workspaceId, (tx) => setPlannedAt(tx, id, plannedAt, at));
      await onStep?.("planned");
      if (item.actionId && action!.state !== "draft" && action!.state !== "needs_approval") {
        const r = await ledger.moveAction(workspaceId, item.actionId, actor);
        if (!r.ok) return { ok: false, reason: r.reason };
      }
      return { ok: true, item: toView((await inWorkspace(workspaceId, (tx) => readItem(tx, id)))!) };
    },

    /**
     * A move that follows a Campaign's launch. An unchanged or later slot keeps the approval: the time isn't
     * what an approval binds, and a later send gives the person more time, not less. Earlier needs a new
     * approval, as any move does. A slot over its cap still moves, and says so: the claim then finds no
     * reservation for that time and holds the Action with reason "cap". A full Mailbox day is different:
     * the move takes the Mailbox's next time with room instead, since no person is there to choose.
     * A Social post stays on its original schedule if the target day has no capacity.
     */
    async redateItem(workspaceId: string, id: string, wanted: Date, actor: Actor) {
      const at = now();
      if (wanted <= at) return { ok: false, reason: "slot_in_past" } as const;
      const row = await inWorkspace(workspaceId, (tx) => readItem(tx, id));
      if (!row) return { ok: false, reason: "not_found" } as const;
      const { item, action } = row;
      if (!item.actionId) {
        return inWorkspace(workspaceId, async (tx) => {
          const own = await lockOwnItem(tx, id);
          if (!own) return { ok: false, reason: "not_found" } as const;
          if (!canMove(own.state as OwnState, null)) return { ok: false, reason: "wrong_state" } as const;
          await setPlannedAt(tx, id, wanted, at);
          return { ok: true, kept: false, backToApproval: false, overCap: false } as const;
        });
      }
      if (!action) return { ok: false, reason: "not_found" } as const;
      if (action.holdReason === "outcome_unknown") return { ok: false, reason: "outcome_unknown" } as const;
      if (action.state === "claimed" || !canMove(action.state, action.holdReason)) return { ok: false, reason: "wrong_state" } as const;
      const actionId = item.actionId;
      const port = await capacity.forAction?.(workspaceId, actionId) ?? capacity;
      // The Mailbox search is a hint; the reservation still checks capacity in its transaction.
      const room = port.reserveAutomaticIn ? null : await port.nextTime(workspaceId, actionId, wanted, { now: at });
      try {
        return await withGroupRetry(workspaceId, async (tx) => {
          // Take the group before the account and Action. Keep the reservations until the
          // Action and Item commit together so another redate can't supersede them mid-move.
          await lockTouchGroup(tx, actionId);
          const placed = await port.reserveAutomaticIn?.(tx, workspaceId, actionId, wanted, at);
          const result = placed?.result;
          if (result?.kind === "not_found" || result?.kind === "unavailable") return { ok: false, reason: result.kind } as const;
          if (result?.kind === "full") return { ok: false, reason: "reason" in result ? result.reason : "mailbox_day_full", day: result.day, limit: result.limit } as const;
          const plannedAt = placed?.slot ?? room;
          if (!plannedAt) return { ok: false, reason: "mailbox_day_full" } as const;
          const reserved = await reserveTouchIn(tx, workspaceId, actionId, plannedAt, at);
          if (reserved.kind === "not_found") throw new RedateRefused("not_found");
          if (!placed) await port.reserveIn(tx, workspaceId, actionId, plannedAt, at);

          // The ledger lock protects the due-time snapshot even when neither capacity counts
          // this Action. Re-read after placement: other writers may have moved it while we waited.
          const current = await ledger.lockActionIn(tx, actionId);
          if (!current) throw new RedateRefused("not_found");
          if (current.holdReason === "outcome_unknown") throw new RedateRefused("outcome_unknown");
          if (current.state === "claimed" || !canMove(current.state, current.holdReason)) throw new RedateRefused("wrong_state");
          if (current.draftVersion !== action.draftVersion) throw new RedateRefused("draft_version_moved");
          const approved = current.state === "scheduled" || current.state === "held";
          const later = approved && current.dueAt !== null && plannedAt > current.dueAt;
          const sameSlot = approved && current.dueAt?.getTime() === plannedAt.getTime();
          if (approved && !sameSlot) {
            const r = later ? await ledger.redateActionIn(tx, workspaceId, actionId, plannedAt, actor) : await ledger.moveActionIn(tx, workspaceId, actionId, actor);
            if (!r.ok) throw new RedateRefused(r.reason);
          }
          await setPlannedAt(tx, id, plannedAt, at);
          const kept = later || sameSlot;
          return { ok: true, kept, backToApproval: approved && !kept, overCap: reserved.kind === "full" } as const;
        });
      } catch (err) {
        if (err instanceof RedateRefused) return { ok: false, reason: err.reason } as const;
        throw err;
      }
    },

    /** Each Item on its own, so a chip can split and the caller can say why. */
    async moveItems(workspaceId: string, entries: readonly { id: string; plannedAt: Date }[], actor: Actor) {
      const results: { id: string; result: Decided }[] = [];
      for (const e of entries) results.push({ id: e.id, result: await api.moveItem(workspaceId, e.id, e.plannedAt, actor) });
      return results;
    },
  };
  return api;
}
