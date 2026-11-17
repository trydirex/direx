// SPDX-License-Identifier: AGPL-3.0-only
// After an Issue goes out: record its id at the tool and when it went, then read what the tool
// reports at 30 minutes, 1 hour, 1 day and 7 days. A tool that reports deliveries and still shows
// none at 30 minutes, while the list has subscribers, gets a warning on the Issue. A tool that refused
// to send on the account's plan makes the list read-only, and the refused Issue becomes a handoff.
import { storedSpec } from "@direx/plugin-sdk/host";
import type { Items } from "../../items";
import { warn, type Warning } from "../../items";
import type { Ledger } from "../../ledger";
import type { NewsletterList, Query } from "../../plugins";
import { enabledWorkspaces, inWorkspace, moveIssueItem, recentIssues, recordSent, saveStats, setReadOnly, type IssueRow } from "../adapters/repo";
import { HANDOFF_KIND, type HandoffPayload } from "./handoff";

const MIN = 60_000;
/** When the stats are read, counted from the send. The first is the delivered check. */
export const STATS_AT = [30 * MIN, 60 * MIN, 24 * 60 * MIN, 7 * 24 * 60 * MIN] as const;
const LOOK_BACK = STATS_AT.at(-1)! + 24 * 60 * MIN;

export type AfterSendDeps = {
  items: () => Pick<Items, "actionIdOf" | "view" | "setWarnings" | "cancel" | "createItem">;
  ledger: () => Pick<Ledger, "getAction" | "getEvents">;
  lists: () => readonly Pick<NewsletterList, "name" | "publish" | "profile" | "stats">[];
  /** A plugin query, its answer checked by the host. */
  query: Query;
  now?: () => Date;
};

export const notDeliveredText = (tool: string) => `${tool} accepted this issue but hasn't emailed anyone yet`;
export const readOnlyText = (tool: string, plan: string) => `${tool} won't send through Direx without ${tool} ${plan}. Copy this issue into ${tool} and send it there.`;
const ACTOR = { system: "newsletter" } as const;

export function newsletterAfterSend(d: AfterSendDeps) {
  const now = d.now ?? (() => new Date());

  /** The latest read point already reached that hasn't been read since it came. */
  const dueRead = (sentAt: Date, readAt: Date | null, at: Date) => {
    const reached = STATS_AT.filter((p) => sentAt.getTime() + p <= at.getTime());
    const last = reached.at(-1);
    return last !== undefined && (!readAt || readAt.getTime() < sentAt.getTime() + last) ? last : null;
  };

  async function oneIssue(workspaceId: string, issue: IssueRow) {
    const actionId = await d.items().actionIdOf(workspaceId, issue.itemId);
    const action = actionId ? await d.ledger().getAction(workspaceId, actionId) : undefined;
    const plan = action?.state === "held" && action.holdReason === "provider_rejected" ? action.reasonPlan : null;
    if (action && plan) return toHandoff(workspaceId, issue, action, plan);
    if (action?.state !== "sent") return;
    let sentAt = issue.sentAt;
    if (!sentAt) {
      const event = (await d.ledger().getEvents(workspaceId, action.id)).filter((e) => e.toState === "sent").at(-1);
      // A tool handed the issue early sends it at the slot, not when it was handed over.
      const at = new Date(Math.max(event?.at.getTime() ?? now().getTime(), issue.slot.getTime()));
      await inWorkspace(workspaceId, (tx) => recordSent(tx, issue.id, action.providerRef, at, now()));
      sentAt = at;
    }

    const list = d.lists().find((l) => l.publish === action.capability);
    const providerRef = issue.providerRef ?? action.providerRef;
    if (!list?.stats || !providerRef) return;
    const at = now();
    const point = dueRead(sentAt, issue.statsReadAt, at);
    if (point === null) return;
    const stats = await d.query(workspaceId, list.stats, { issueId: providerRef }, action.credentialId);
    await inWorkspace(workspaceId, (tx) => saveStats(tx, issue.id, stats, at));

    // Only a tool that reports deliveries can say none happened.
    if (stats.delivered === undefined) return;
    const item = await d.items().view(workspaceId, issue.itemId);
    if (!item) return;
    const text = notDeliveredText(list.name);
    const others = item.warnings.filter((w: Warning) => w.text !== text);
    let stuck = false;
    if (stats.delivered === 0) {
      const profile = await d.query(workspaceId, list.profile, null, action.credentialId);
      stuck = profile.subscriberCount > 0;
    }
    const next = stuck ? [...others, warn("unspecified", text)] : others;
    if (next.length !== item.warnings.length) await d.items().setWarnings(workspaceId, issue.itemId, next);
  }

  /**
   * The tool won't send on this plan: the list turns read-only and this week's issue, already written
   * and approved, comes back as a handoff to approve and send by hand. The new Item is made first, so
   * a failure part way leaves the Issue findable and the next pass finishes.
   */
  async function toHandoff(workspaceId: string, issue: IssueRow, action: { spec: unknown; capability: string }, plan: string) {
    const tool = d.lists().find((l) => l.publish === action.capability)?.name ?? "your newsletter tool";
    await inWorkspace(workspaceId, (tx) => setReadOnly(tx, `${tool} ${plan}`, now()));
    const spec = storedSpec("newsletter.publish", action.spec);
    const item = await d.items().view(workspaceId, issue.itemId);
    const payload: HandoffPayload = { title: spec.title ?? "", ...(spec.previewText && { previewText: spec.previewText }), markdown: spec.markdown ?? "", html: spec.html ?? "", at: spec.at ?? "", tool };
    const made = await d.items().createItem(workspaceId, {
      kind: HANDOFF_KIND,
      payload,
      actor: ACTOR,
      // No planned time: its slot has gone, and it waits for the person, not the clock.
      details: { title: item?.title ?? "Newsletter issue", workArea: "newsletter", channel: "newsletter", plannedAt: null, warnings: [warn("unspecified", readOnlyText(tool, plan))] },
    });
    if (!made.ok) throw new Error(`newsletter: handoff for issue ${issue.id} refused: ${made.reason}`);
    await inWorkspace(workspaceId, (tx) => moveIssueItem(tx, issue.id, made.item.id));
    await d.items().cancel(workspaceId, issue.itemId, ACTOR);
  }

  async function runOne(workspaceId: string) {
    const issues = await inWorkspace(workspaceId, (tx) => recentIssues(tx, new Date(now().getTime() - LOOK_BACK)));
    for (const issue of issues) await oneIssue(workspaceId, issue).catch((e) => console.error(`newsletter: after-send failed for issue ${issue.id}`, e));
  }

  return {
    runOne,
    // ponytail: only Workspaces with the issue still on; one turned off mid-week stops getting stats. Read every Workspace with recent issues if that matters.
    async run() {
      for (const ws of await enabledWorkspaces()) await runOne(ws).catch((e) => console.error(`newsletter: after-send failed for ${ws}`, e));
    },
  };
}
export type NewsletterAfterSend = ReturnType<typeof newsletterAfterSend>;
