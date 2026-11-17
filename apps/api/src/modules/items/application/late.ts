// SPDX-License-Identifier: AGPL-3.0-only
// Actions held because they would send more than a day past their approved time. Only a person sends
// one, at the next send slot free for its Person, so the Touch check matches and the caps still hold.
// One Workspace notice counts what is late and resumes the late emails together; posts go one by one.
import type { Actor, Ledger } from "../../ledger";
import { nextMailboxTime, reserveMailbox, reserveTouch } from "../../schedule";
import { inWorkspace, itemIdByAction, setPlannedAt, type ItemsTx } from "../adapters/repo";
import type { ItemKind } from "./items";

export const LATE_KIND = "late_sends";
const HOUR = 3_600_000;
// ponytail: tries each hour for two weeks, one transaction a try; search the caps directly if late emails pile up.
const SEARCH_HOURS = 14 * 24;

/**
 * The first slot from `from` that both the Action's Person and its Mailbox's day can take, reserved;
 * `from` itself when neither counts it; null when none is free.
 */
export async function nextFreeSlot(workspaceId: string, actionId: string, from: Date): Promise<Date | null> {
  const end = from.getTime() + SEARCH_HOURS * HOUR;
  for (let next = from; next.getTime() <= end; ) {
    const slot = await nextMailboxTime(workspaceId, actionId, next, { now: from });
    if (!slot || slot.getTime() > end) return null;
    const r = await reserveTouch(workspaceId, actionId, slot, { now: from });
    if (r.kind === "not_found") return null;
    if (r.kind !== "full" && (await reserveMailbox(workspaceId, actionId, slot, { now: from })).kind !== "full") return slot;
    next = new Date(slot.getTime() + HOUR);
  }
  return null;
}

/**
 * After the dispatcher moved an approved email later because its Mailbox's day had already sent its
 * limit: the new time's places, and the Item showing it. A Person slot that's taken leaves the claim
 * to hold it on its old reservation, for a person.
 */
export async function followLater(workspaceId: string, actionId: string, at: Date, now: Date): Promise<void> {
  await reserveTouch(workspaceId, actionId, at, { now });
  await reserveMailbox(workspaceId, actionId, at, { now });
  await inWorkspace(workspaceId, async (tx) => {
    const itemId = await itemIdByAction(tx, actionId);
    if (itemId) await setPlannedAt(tx, itemId, at, now);
  });
}

const day = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

type SettleGroupIn = (tx: ItemsTx, workspaceId: string, a: { kind: string; groupKey: string; actor: Actor; next: { payload: unknown; details: { title: string; workArea: string; warnings: [] } } | null }) => Promise<unknown>;

export function lateSends(d: { ledger: Ledger; now: () => Date; settleGroupIn: SettleGroupIn; actionPermission?: ((capability: string) => string | undefined) | undefined }) {
  // Transactions applying the notice refresh it after they commit, not mid-way, so the Item being
  // approved isn't replaced under its own approval.
  const applying = new WeakSet<object>();
  const tallies = new Map<string, { resumed: number; skipped: number; failed: number }>();

  /** The notice as things stand: a new title when the counts change, none once nothing is late. */
  async function refreshIn(tx: ItemsTx, workspaceId: string, note?: string) {
    if (applying.has(tx)) return;
    const c = await d.ledger.lateCountsIn(tx);
    const parts = [c.emails && count(c.emails, "email"), c.posts && count(c.posts, "post")].filter(Boolean).join(" and ");
    const title = [
      `${parts} would go out more than a day after the time they were approved for; the oldest was due ${day(c.oldestDueAt ?? d.now())} UTC.`,
      c.emails ? "Approve to send the emails at the next free times." : "",
      c.posts ? "Posts are resumed one by one." : "",
      note ?? "",
    ]
      .filter(Boolean)
      .join(" ");
    await d.settleGroupIn(tx, workspaceId, {
      kind: LATE_KIND,
      groupKey: `${LATE_KIND}:${workspaceId}`,
      actor: { system: "ledger" },
      next: c.emails + c.posts ? { payload: {}, details: { title, workArea: "outreach", warnings: [] } } : null,
    });
  }

  /** Sends one held Action that is past its time at its Person's next free slot, in the caller's transaction. */
  async function resumeLateIn(tx: ItemsTx, workspaceId: string, actionId: string, actor: Actor, heldFor?: string) {
    const slot = await nextFreeSlot(workspaceId, actionId, d.now());
    if (!slot) return { ok: false, reason: "no_free_slot" } as const;
    const itemId = await itemIdByAction(tx, actionId);
    if (itemId) await setPlannedAt(tx, itemId, slot, d.now());
    return d.ledger.resumeIn(tx, workspaceId, actionId, actor, { ...(heldFor && { heldFor }), dueAt: slot });
  }

  /**
   * Resumes every late email, oldest first, each to its own next free slot. It sends many at once, so
   * it needs a recent sign-in, which also keeps any grant from applying it. An email whose capability
   * needs its own permission is left for its own Item.
   */
  const kind: Record<string, ItemKind> = {
    [LATE_KIND]: {
      permission: "item.approve",
      bulk: false,
      stepUp: true,
      async apply(tx, item, actor) {
        applying.add(tx);
        const tally = { resumed: 0, skipped: 0, failed: 0 };
        for (const late of await d.ledger.lateEmailsIn(tx)) {
          if (d.actionPermission?.(late.capability) !== undefined) tally.skipped++;
          else if ((await resumeLateIn(tx, item.workspaceId, late.id, actor, "late")).ok) tally.resumed++;
          else tally.failed++;
        }
        tallies.set(item.id, tally);
        return { ok: true };
      },
    },
  };

  /** After the notice's approval commits: what is still late, and why the rest didn't go. */
  async function afterApplied(tx: ItemsTx, workspaceId: string, itemId: string) {
    const t = tallies.get(itemId);
    tallies.delete(itemId);
    const note = t && (t.skipped || t.failed) ? `Last time ${t.resumed} resumed, ${t.skipped} need their own approval and ${t.failed} found no free time.` : undefined;
    await refreshIn(tx, workspaceId, note);
  }

  return { kind, refreshIn, resumeLateIn, afterApplied };
}
