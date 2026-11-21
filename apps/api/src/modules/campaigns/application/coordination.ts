// SPDX-License-Identifier: AGPL-3.0-only
// What keeps a running campaign honest: a pause holds its email, a reply stops the rest to that Person,
// someone in two campaigns waits for a person's choice, and a step that has finished reads as done.
import { storedSpec } from "@direx/plugin-sdk/host";
import type { Items, ItemKind } from "../../items";
import type { Check } from "../../ledger";
import type { InboundEvent } from "../../outreach";
import type { Plans } from "../../plans";
import { currentEmailTrackingHash, recipientTrackingLinks } from "../../tracking";
import { PLAN_CHANGED, planChangeKinds } from "./plan-change";
import { strategyAssumptionKinds } from "./write-up";
import { setStallWaitFrom, activePosts, activeActions, campaignOfAction, inWorkspace, markReplied, markRepliedEverywhere, readCampaign, recipientLinkUses, setPaused, settleConflict, postCounts, stepCounts, type CampaignsTx } from "../adapters/repo";

export const CONFLICT_KIND = "campaign_conflict";
/** What a Campaign's drafting waits on that a person can fix. Approving it only says "seen"; it goes away once nothing waits. */
export const WAITING_KIND = "campaign_waiting";
/** The notice that a Campaign's launch moved and what it did to Items already approved. Approving it only says "seen". */
import { LAUNCH_MOVED_KIND } from "../domain/activity";
import { ENDED_STATES } from "../domain/write-up";
export { LAUNCH_MOVED_KIND };
/** A step others wait on has no output days after its date. Approving it keeps waiting; the Campaign offers going ahead or cancelling. */
export const STALL_KIND = "campaign_stall";
export type StallPayload = { campaignId: string; stepKey: string; choices: string[] };
export const PAUSED = "campaign_paused";
const ENDED = ENDED_STATES;
const SYSTEM = { system: "campaigns" } as const;

/** Runs with the ledger's checks, so a paused campaign, a step the plan changed or a Person who has left can't send, however it got here. */
export const campaignCheck = (): Check => async (tx, action) => {
  const link = await campaignOfAction(tx, action.id);
  if (!link) return { kind: "ok" };
  if (link.status === "replied" || link.status === "removed") return { kind: "block", reason: "person_left_campaign", detail: link.status };
  if (link.pausedAt) return { kind: "hold", reason: PAUSED };
  if (link.planChanged) return { kind: "hold", reason: PLAN_CHANGED };
  if ("personId" in link) {
    const tokens = recipientTrackingLinks(storedSpec("email.send", action.spec).text ?? "");
    if (tokens.length) {
      // The ledger has verified the approved bytes. A previous revision's token must not hold a new message.
      const uses = (await recipientLinkUses(tx, action.id)).filter((use) => tokens.some((token) =>
        use.linkId === token.linkId && use.tokenHash === token.tokenHash && use.hostname === token.hostname));
      if (uses.length) {
        const live = await currentEmailTrackingHash(tx, link.campaignId, link.personId);
        if (uses.some((use) => use.inputsHash !== live)) {
          return { kind: "hold", reason: "tracking_changed", detail: "Link tracking changed. Refresh the draft and approve it again." };
        }
      }
    }
  }
  return { kind: "ok" };
};

export type ConflictPayload = { campaignId: string; personId: string; otherCampaignId: string };

/** The answers a person can give when someone is in two campaigns. It never settles by itself. */
export function campaignKinds(deps: { now?: () => Date } = {}): Record<string, ItemKind> {
  const now = deps.now ?? (() => new Date());
  return {
    [CONFLICT_KIND]: {
      permission: "item.edit",
      // It needs a choice, so approve-all would only be refused.
      bulk: false,
      async apply(tx: CampaignsTx, item, _actor, choice) {
        if (choice !== "skip" && choice !== "add_after") return { ok: false, reason: "choice_required" };
        await settleConflict(tx, item.payload as ConflictPayload, choice, now());
        return { ok: true };
      },
    },
    [WAITING_KIND]: {
      permission: "item.edit",
      apply: async () => ({ ok: true }),
    },
    [LAUNCH_MOVED_KIND]: {
      permission: "item.edit",
      apply: async () => ({ ok: true }),
    },
    ...planChangeKinds({ now }),
    ...strategyAssumptionKinds({ now }),
    [STALL_KIND]: {
      permission: "item.edit",
      // Keep waiting, go ahead or cancel is a person's choice, not part of approve-all.
      bulk: false,
      async apply(tx: CampaignsTx, item, _actor, choice) {
        if (choice !== undefined && choice !== "wait") return { ok: false, reason: "choose_on_campaign" };
        const p = item.payload as StallPayload;
        await setStallWaitFrom(tx, p.campaignId, p.stepKey, now());
        return { ok: true };
      },
    },
  };
}

/** Stops the rest of a campaign to whoever replied. `humanReply` has already ruled out bounces and auto-replies. */
export function campaignReplies(deps: { items: () => Items; humanReply: (tx: CampaignsTx, e: InboundEvent) => Promise<string | null> }) {
  return async function onEmailReceived(tx: CampaignsTx, e: InboundEvent): Promise<void> {
    const personId = await deps.humanReply(tx, e);
    if (!personId) return;
    for (const { campaignId } of await markReplied(tx, personId)) {
      for (const link of await activeActions(tx, campaignId, null, personId)) {
        // One already sent, or with an unknown outcome, refuses to cancel, and that's the right answer for it.
        await deps.items().cancel(e.workspaceId, link.itemId, SYSTEM);
      }
    }
  };
}

/**
 * A reply a person logged by hand, on any channel. It stops the Person group in every campaign
 * they're active in: `mark` runs in the logging transaction, so campaignCheck blocks their sends
 * from then on, and `cancel` tidies the queued ones afterwards.
 */
export function campaignOutsideReplies(deps: { items: () => Items }) {
  return {
    async mark(tx: CampaignsTx, personIds: readonly string[], status: "replied" | "removed" = "replied"): Promise<string[]> {
      const itemIds: string[] = [];
      for (const { campaignId, personId } of await markRepliedEverywhere(tx, personIds, status)) {
        for (const link of await activeActions(tx, campaignId, null, personId)) itemIds.push(link.itemId);
      }
      return itemIds;
    },
    async cancel(workspaceId: string, itemIds: readonly string[]): Promise<void> {
      // One already sent, or with an unknown outcome, refuses to cancel, and that's the right answer for it.
      for (const id of itemIds) await deps.items().cancel(workspaceId, id, SYSTEM);
    },
  };
}

export function campaignCoordination({ plans, items, now }: { plans: Plans; items: () => Items; now: () => Date }) {
  return {
    pause: (workspaceId: string, campaignId: string, userId: string) =>
      inWorkspace(workspaceId, async (tx) => ((await setPaused(tx, campaignId, userId, now())) ? ({ ok: true } as const) : ({ ok: false, reason: "not_found" } as const))),

    /** Clears the pause, then each held email passes every check again before it goes. */
    async resume(workspaceId: string, campaignId: string, userId: string) {
      const links = await inWorkspace(workspaceId, async (tx) => ((await setPaused(tx, campaignId, null, now())) ? [...(await activeActions(tx, campaignId, null)), ...(await activePosts(tx, campaignId))] : null));
      if (!links) return { ok: false, reason: "not_found" } as const;
      for (const link of links) {
        const view = await items().view(workspaceId, link.itemId);
        if (view?.reasonCode === PAUSED) await items().resume(workspaceId, link.itemId, { userId });
      }
      return { ok: true } as const;
    },

    /** What Direx counted, and a step whose every email has ended is marked done. */
    async results(workspaceId: string, campaignId: string) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const campaign = await readCampaign(tx, campaignId);
        return campaign && { campaign, counts: await stepCounts(tx, campaignId), posts: await postCounts(tx, campaignId) };
      });
      if (!read) return null;
      const open = new Map<string, number>();
      let sent = 0;
      for (const c of read.counts) {
        if (c.state === "sent") sent += c.n;
        open.set(c.stepKey, (open.get(c.stepKey) ?? 0) + (ENDED.has(c.state) ? 0 : c.n));
      }
      for (const c of read.posts) open.set(c.stepKey, (open.get(c.stepKey) ?? 0) + (ENDED.has(c.state) ? 0 : c.n));
      // ponytail: worked out when someone looks, so a step reads done on the next view; a job on Action end if plan tracking needs it sooner.
      const plan = await plans.plan(workspaceId, read.campaign.planId);
      for (const [stepKey, left] of open) {
        if (left === 0 && plan?.tracking?.steps.find((s) => s.key === stepKey)?.status === "open") {
          await plans.markStep(workspaceId, read.campaign.planId, { stepKey, status: "done", actor: SYSTEM });
        }
      }
      return { sent };
    },
  };
}
