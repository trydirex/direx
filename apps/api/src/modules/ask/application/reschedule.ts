// SPDX-License-Identifier: AGPL-3.0-only
// A move Ask proposed. Approving it moves the Item the same way the Calendar does, as the person who
// approved: an approved send goes back to Needs approval, and a full slot or a past time refuses it.
// Undo moves it back the same way, while it is still where the card put it.
import { z } from "zod";
import type { ItemKind, Items } from "../../items/index";

export const RESCHEDULE_KIND = "reschedule";
export const ReschedulePayload = z.strictObject({ targetId: z.uuid(), at: z.iso.datetime({ offset: true }), from: z.iso.datetime({ offset: true }).nullable() });

type Row = Parameters<ItemKind["apply"]>[1];

export function askKinds(d: { items: () => Pick<Items, "moveItem" | "view">; now?: () => Date }): Record<string, ItemKind> {
  const now = d.now ?? (() => new Date());
  /** Whether the target can still go back to where it was, and where that is. */
  async function backTo(item: Row) {
    const p = ReschedulePayload.safeParse(item.payload);
    if (!p.success) return { ok: false, reason: "bad_payload" } as const;
    if (!p.data.from) return { ok: false, reason: "no_old_time" } as const;
    const from = new Date(p.data.from);
    if (from <= now()) return { ok: false, reason: "old_time_passed" } as const;
    const target = await d.items().view(item.workspaceId, p.data.targetId);
    if (!target) return { ok: false, reason: "not_found" } as const;
    // Moved again since, by anyone: undoing would overwrite their move.
    if (target.at?.getTime() !== new Date(p.data.at).getTime()) return { ok: false, reason: "moved_since" } as const;
    if (!target.movable) return { ok: false, reason: "cant_move" } as const;
    return { ok: true, targetId: target.id, from } as const;
  }
  return {
    [RESCHEDULE_KIND]: {
      permission: "item.approve",
      bulk: false,
      // ponytail: the move commits in its own transactions; if this approval then fails, the Item has
      // still moved and approving again moves it to the same time. Join the transactions if that bites.
      async apply(_tx, item, actor) {
        const p = ReschedulePayload.safeParse(item.payload);
        if (!p.success) return { ok: false, reason: "bad_payload" };
        if (!("userId" in actor)) return { ok: false, reason: "person_required" };
        const moved = await d.items().moveItem(item.workspaceId, p.data.targetId, new Date(p.data.at), actor);
        return moved.ok ? { ok: true } : { ok: false, reason: moved.reason };
      },
      undo: {
        // The same permission a move on the Calendar takes.
        permission: "item.edit",
        check: async (item) => {
          const b = await backTo(item);
          return b.ok ? { ok: true } : b;
        },
        async apply(item, actor) {
          const b = await backTo(item);
          if (!b.ok) return b;
          const moved = await d.items().moveItem(item.workspaceId, b.targetId, b.from, actor);
          return moved.ok ? { ok: true } : { ok: false, reason: moved.reason };
        },
      },
    },
  };
}
