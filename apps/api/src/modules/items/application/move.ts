// SPDX-License-Identifier: AGPL-3.0-only
// Moving an Item to a new time. Three transactions, in an order that fails safe: once the
// new slot is reserved, the old time no longer matches the newest reservation, so a crash
// before the last step holds the Action instead of sending at the old time. Repeating the
// move finishes it.
import type { Actor, Ledger } from "../../ledger";
import { reserveTouch } from "../../schedule";
import { inWorkspace, readItem, setPlannedAt } from "../adapters/repo";
import { canMove, type OwnState } from "../domain/state";
import type { CapacityPort } from "./capacity";
import type { Decided } from "./decide";
import { toView } from "./view";

export type MoveStep = "reserved" | "planned";

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
        if (day.kind === "full") return { ok: false, reason: "mailbox_day_full", day: day.day, limit: day.limit };
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
     * A move that follows a Campaign's launch. Later keeps an approved Action's approval: the time isn't
     * what an approval binds, and a later send gives the person more time, not less. Earlier needs a new
     * approval, as any move does. A slot over its cap still moves, and says so: the claim then finds no
     * reservation for that time and holds the Action with reason "cap". A full Mailbox day is different:
     * the move takes the Mailbox's next time with room instead, since no person is there to choose.
     */
    async redateItem(workspaceId: string, id: string, wanted: Date, actor: Actor) {
      const at = now();
      if (wanted <= at) return { ok: false, reason: "slot_in_past" } as const;
      const lookup = await inWorkspace(workspaceId, (tx) => readItem(tx, id));
      let plannedAt = wanted;
      if (lookup?.item.actionId) {
        const room = await capacity.nextTime(workspaceId, lookup.item.actionId, wanted, { now: at });
        if (!room) return { ok: false, reason: "mailbox_day_full" } as const;
        plannedAt = room;
      }
      const row = lookup;
      if (!row) return { ok: false, reason: "not_found" } as const;
      const { item, action } = row;
      if (action?.holdReason === "outcome_unknown") return { ok: false, reason: "outcome_unknown" } as const;
      if (action?.state === "claimed" || !canMove(action ? action.state : (item.state as OwnState), action?.holdReason ?? null)) return { ok: false, reason: "wrong_state" } as const;
      const approved = action !== null && (action.state === "scheduled" || action.state === "held");
      const later = approved && action.dueAt !== null && plannedAt > action.dueAt;

      let overCap = false;
      if (item.actionId) {
        const reserved = await reserveTouch(workspaceId, item.actionId, plannedAt, { now: at });
        if (reserved.kind === "not_found") return { ok: false, reason: "not_found" } as const;
        overCap = reserved.kind === "full";
        // ponytail: a writer that took the last place since the search leaves the move over the limit; the dispatch check moves it on.
        await capacity.reserve(workspaceId, item.actionId, plannedAt, { now: at });
      }
      await inWorkspace(workspaceId, (tx) => setPlannedAt(tx, id, plannedAt, at));
      if (approved) {
        const r = later ? await ledger.redateAction(workspaceId, item.actionId!, plannedAt, actor) : await ledger.moveAction(workspaceId, item.actionId!, actor);
        if (!r.ok) return { ok: false, reason: r.reason } as const;
      }
      return { ok: true, kept: later, backToApproval: approved && !later, overCap } as const;
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
