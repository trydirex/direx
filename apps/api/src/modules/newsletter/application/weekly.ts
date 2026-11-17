// SPDX-License-Identifier: AGPL-3.0-only
// The job behind the weekly issue. Two days before each slot it makes that week's Issue as a draft
// for a person to write; once a slot passes with the Issue still unapproved, it cancels it and says
// so. Nothing here approves or sends: an Issue goes out only through its own approval.
import type { DedupeClass } from "@direx/plugin-sdk";
import type { ItemKind, Items } from "../../items";
import { warn } from "../../items";
import { enabledWorkspaces, inWorkspace, insertIssue, issueAt, readSettings, unsentSince, type SettingsRow } from "../adapters/repo";
import { draftDue, gapWarning, GAP_DAYS, nextSlot } from "../domain/slots";
import { handoffKind, HANDOFF_KIND, SUBSTACK, type HandoffPayload } from "./handoff";
import { chosenList } from "./settings";

export const SKIPPED_KIND = "newsletter_skipped";
const ACTOR = { system: "newsletter" } as const;
const WEEK = 7 * 24 * 60 * 60 * 1000;

/** Dismissing the notice is its only answer, and it changes nothing. */
export const newsletterKinds = (): Record<string, ItemKind> => ({
  [SKIPPED_KIND]: { permission: "item.approve", apply: async () => ({ ok: true }) },
  ...handoffKind(),
});

export type WeeklyDeps = {
  items: () => Pick<Items, "createActionItem" | "createItem" | "cancel" | "view">;
  /** Each list connection and the effect that publishes an issue to it. */
  /** `lists` is set for a tool whose account holds several lists, so the key must name one. */
  lists: () => readonly { connection: string; name: string; lists?: string | null; publish: string; publishDedupe: DedupeClass; publishLeadMs: number }[];
  credentials: (workspaceId: string) => Promise<readonly { id: string; connection: string | null; status: string; meta?: unknown }[]>;
  now?: () => Date;
};

const slotWords = (slot: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(slot).replace(" at", "");

export function newsletterWeekly(d: WeeklyDeps) {
  const now = d.now ?? (() => new Date());

  async function skipUnapproved(workspaceId: string, s: SettingsRow) {
    const at = now();
    const passed = await inWorkspace(workspaceId, (tx) => unsentSince(tx, new Date(at.getTime() - WEEK), at));
    for (const issue of passed) {
      const item = await d.items().view(workspaceId, issue.itemId);
      if (item?.state !== "draft" && item?.state !== "needs_approval") continue;
      // A refused send turned into a handoff has no time to miss; it waits for the person.
      if (!item.at) continue;
      const r = await d.items().cancel(workspaceId, issue.itemId, ACTOR);
      if (!r.ok) continue;
      await d.items().createItem(workspaceId, {
        kind: SKIPPED_KIND,
        payload: { issueItemId: issue.itemId, slot: issue.slot.toISOString() },
        actor: ACTOR,
        details: { title: "This week's issue was skipped", workArea: "newsletter", warnings: [warn("unspecified", `This week's issue was skipped: nobody approved it before ${slotWords(issue.slot, s.timeZone)}.`)] },
      });
    }
  }

  async function makeDue(workspaceId: string, s: SettingsRow) {
    const at = now();
    const slot = nextSlot(s, at);
    if (at < draftDue(slot, s.timeZone)) return;
    if (await inWorkspace(workspaceId, (tx) => issueAt(tx, slot))) return;
    const warnings = gapWarning(s.lastSentAt, at) ? [warn("unspecified", `More than ${GAP_DAYS} days since the last issue. Readers forget a quiet list, so this one may see more unsubscribes.`)] : [];
    const title = `Newsletter issue for ${slotWords(slot, s.timeZone)}`;
    const cred = s.credentialId ? (await d.credentials(workspaceId)).find((c) => c.id === s.credentialId && c.status === "active") : undefined;
    const list = cred && d.lists().find((l) => l.connection === cred.connection);

    // Substack, or a tool that won't send on this plan: the same writing and approval, sent by hand.
    if (s.list === "substack" || s.readOnlySince) {
      const payload: HandoffPayload = { title: "", markdown: "", html: "", at: slot.toISOString(), tool: s.list === "substack" ? SUBSTACK : (list?.name ?? "your newsletter tool") };
      // ponytail: two passes racing on the same slot could each make an Item; the slot's unique row keeps one issue. A lock if that shows up.
      const made = await d.items().createItem(workspaceId, { kind: HANDOFF_KIND, state: "draft", payload, actor: ACTOR, details: { title, workArea: "newsletter", channel: "newsletter", plannedAt: slot, warnings } });
      if (made.ok) await inWorkspace(workspaceId, (tx) => insertIssue(tx, workspaceId, slot, made.item.id, now()));
      return;
    }
    if (!list) {
      console.error(`newsletter: ${workspaceId} has no working list for its issue of ${slot.toISOString()}`);
      return;
    }
    // The approved spec names the list, so choosing another later changes the next issue, never this one.
    const { listId, listName } = list.lists ? chosenList(cred) : { listId: null, listName: null };
    if (list.lists && !listId) {
      console.error(`newsletter: ${workspaceId} hasn't chosen which ${list.name} list gets its issue of ${slot.toISOString()}`);
      return;
    }
    const item = await d.items().createActionItem(workspaceId, {
      idempotencyKey: `newsletter:${workspaceId}:${slot.toISOString()}`,
      capability: list.publish,
      dedupe: list.publishDedupe,
      spec: {
        title: "",
        html: "",
        at: slot.toISOString(),
        ...(listId && { listId }),
        audience: { kind: "newsletter_list", credentialId: s.credentialId, ...(listId && { listId, listName }) },
      },
      credentialId: s.credentialId,
      actor: ACTOR,
      // Due when the tool must be handed it, so an issue on a tool that schedules ahead still arrives at the slot.
      details: { title: listName ? `${title}, to ${listName}` : title, workArea: "newsletter", channel: "newsletter", plannedAt: new Date(slot.getTime() - list.publishLeadMs), warnings },
    });
    await inWorkspace(workspaceId, (tx) => insertIssue(tx, workspaceId, slot, item.id, now()));
  }

  /** One Workspace's pass. The order matters: last week's skip is told before this week's draft appears. */
  async function runOne(workspaceId: string) {
    const s = await inWorkspace(workspaceId, readSettings);
    if (!s?.enabled) return;
    await skipUnapproved(workspaceId, s);
    await makeDue(workspaceId, s);
  }

  return {
    runOne,
    /** Every Workspace with its issue on. One failing Workspace never stops the rest. */
    async run() {
      for (const ws of await enabledWorkspaces()) await runOne(ws).catch((e) => console.error(`newsletter: weekly pass failed for ${ws}`, e));
    },
  };
}
export type NewsletterWeekly = ReturnType<typeof newsletterWeekly>;
