// SPDX-License-Identifier: AGPL-3.0-only
// Calls, hand-sent messages and other touches Direx didn't send, logged on a Person. An outbound one
// holds Direx's next cold Touch to the gap (schedule does that); an inbound one is a reply, which
// stops the Person group in every campaign, as an email reply does.
import { addKey, lockGroup } from "../../people";
import { recordOutsideTouch } from "../../schedule";
import { deleteOutsideTouch, outsideTouch, outsideTouchesOf, personExists, profilesOf, type OutsideTouch } from "../adapters/outside-touches-repo";
import { inWorkspace, type OutreachTx } from "../adapters/repo";

export const CHANNELS = ["call", "linkedin", "x", "email_other", "other"] as const;
export type Channel = (typeof CHANNELS)[number];
export type Direction = "outbound" | "inbound";

/** What a reply does to campaigns. campaigns provides it; outreach can't import campaigns. */
export type ReplyStop = {
  /** "removed" when the reason is a relationship hold, so Campaign results don't count it as a reply. */
  mark(tx: OutreachTx, personIds: readonly string[], status?: "replied" | "removed"): Promise<string[]>;
  cancel(workspaceId: string, itemIds: readonly string[]): Promise<void>;
};

export type LogInput = { channel: Channel; direction: Direction; occurredAt: Date; source?: "manual" | "direx_draft"; sourceRef?: string | null };

const MINUTE = 60_000;
/** Clocks differ a little; a time further ahead than this is a mistake. */
const FUTURE_SLACK_MS = MINUTE;
const UNDO_MS = 10 * MINUTE;
const LIST_DAYS = 90;

export type OutsideTouchView = { id: string; channel: string; direction: string; occurredAt: string; source: string; canDelete: boolean };

// The undo window is the database's: its delete policy compares created_at with its own now(),
// so both sides use wall time, not the caller's clock.
function view(t: OutsideTouch): OutsideTouchView {
  return {
    id: t.id,
    channel: t.channel,
    direction: t.direction,
    occurredAt: t.occurredAt.toISOString(),
    source: t.source,
    canDelete: t.source === "manual" && Date.now() - t.createdAt.getTime() < UNDO_MS,
  };
}

export function createOutsideTouches(deps: { replies: () => ReplyStop; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  return {
    async log(workspaceId: string, personId: string, input: LogInput, userId: string) {
      const at = now();
      if (input.occurredAt.getTime() > at.getTime() + FUTURE_SLACK_MS) return { ok: false, reason: "in_future" } as const;
      const done = await inWorkspace(workspaceId, async (tx) => {
        if (!(await personExists(tx, personId))) return null;
        const touch = await recordOutsideTouch(tx, {
          workspaceId,
          personId,
          channel: input.channel,
          direction: input.direction,
          occurredAt: input.occurredAt,
          source: input.source ?? "manual",
          sourceRef: input.sourceRef ?? null,
          createdBy: userId,
          createdAt: new Date(),
        });
        const toCancel = touch.direction === "inbound" ? await deps.replies().mark(tx, (await lockGroup(tx, personId)).members) : [];
        return { touch, toCancel };
      });
      if (!done) return { ok: false, reason: "not_found" } as const;
      if (done.toCancel.length) await deps.replies().cancel(workspaceId, done.toCancel);
      return { ok: true, touch: view(done.touch) } as const;
    },

    async list(workspaceId: string, personId: string): Promise<OutsideTouchView[]> {
      const rows = await inWorkspace(workspaceId, (tx) => outsideTouchesOf(tx, personId, new Date(now().getTime() - LIST_DAYS * 24 * 60 * MINUTE)));
      return rows.map(view);
    },

    /** The profiles saved with addProfile, so the form that saves one can show what is already there. */
    profiles(workspaceId: string, personId: string) {
      return inWorkspace(workspaceId, (tx) => profilesOf(tx, personId));
    },

    /** The LinkedIn or X profile a hand-sent DM opens. A profile another record has makes them a merge candidate, as any key does. */
    async addProfile(workspaceId: string, personId: string, kind: "linkedin" | "x", raw: string) {
      if (!(await inWorkspace(workspaceId, (tx) => personExists(tx, personId)))) return { ok: false, reason: "not_found" } as const;
      const r = await addKey(workspaceId, personId, kind, raw);
      return r.ok ? ({ ok: true, url: r.value } as const) : ({ ok: false, reason: "bad_profile" } as const);
    },

    /** Undoes a slip: only a manual entry, and only in its first 10 minutes. */
    remove(workspaceId: string, personId: string, id: string) {
      return inWorkspace(workspaceId, async (tx) => {
        const t = await outsideTouch(tx, personId, id);
        if (!t) return { ok: false, reason: "not_found" } as const;
        if (!view(t).canDelete || !(await deleteOutsideTouch(tx, id))) return { ok: false, reason: "too_late" } as const;
        return { ok: true } as const;
      });
    },
  };
}
export type OutsideTouches = ReturnType<typeof createOutsideTouches>;
