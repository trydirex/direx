// SPDX-License-Identifier: AGPL-3.0-only
// A new plan version while its Campaign runs. The Campaign step owns its text, so new plan text is only
// suggested. A step whose text or channel changed, or that the plan removed, holds in the approval's own
// transaction until a person chooses: keep it, use the new text, or cancel it. What follows the commit
// (moving Items, filling or using text, resuming) is recorded in that transaction as owed work, done
// right after, and retried by a sweep until it's done, so a crash or a refusal can't drop it.
import type { AppliedItem, ItemKind, Items } from "../../items";
import { PLAN_KIND, type OnPlanApproved, type OnPlanCreated, type PlanBody, type Plans } from "../../plans";
import { activeActions, activePosts, campaignOfPlan, cancelSteps, claimSettlements, decidePlanChange, ensureCampaign, failSettlement, finishSettlement, inWorkspace, movableItems, planChangesOf, putPlanChange, putSettlement, readCampaign, retrySettlements, stepCounts, stepsOf, stuckSettlements, unsettledCampaigns, type CampaignsTx } from "../adapters/repo";
import { decideBy, shiftAt } from "../domain/anchor";
import { diffPlans, holdKinds, type HoldKind } from "../domain/plan-diff";
import { fillFromPlan } from "./campaigns";
import type { FactReads } from "./drafting";

export const PLAN_CHANGE_KIND = "plan_change";
/** A plan version changed the step's text or channel, or removed it, and a person hasn't chosen yet. Resuming keeps approvals. */
export const PLAN_CHANGED = "plan_changed";
export type PlanChangePayload = { campaignId: string; stepKey: string; kinds: HoldKind[] };
/** Owed plan change work kept failing; approving it tries again. */
export const UNFINISHED_KIND = "campaign_plan_unfinished";
/** What's owed after a commit. A move names its date, so doing it twice moves nothing twice. */
type SettleWork =
  | { kind: "plan"; planId: string; version: number; userId: string; timeZone: string; moves: { itemId: string; to: string }[] }
  | { kind: "choice"; itemId: string; stepKey: string; userId: string };
/** Tries, counting the one right after the commit, before a person is asked. */
const STUCK_AFTER = 3;
const HOLD_MS = 5 * 60_000;
type Choice = "keep" | "use_new_text" | "cancel";
const CHOICES: readonly string[] = ["keep", "use_new_text", "cancel"] satisfies Choice[];
type Text = { subject: string; text: string };

const groupOf = (campaignId: string, stepKey: string) => `${PLAN_CHANGE_KIND}:${campaignId}:${stepKey}`;
function choiceTitle(title: string, kinds: HoldKind[]) {
  if (kinds.includes("removed")) return `The plan removed "${title}": finish what's scheduled or cancel the step`;
  if (kinds.includes("text")) return `The plan changed "${title}": keep its text, use the new text, or cancel the step`;
  return `The plan changed the channel of "${title}": keep the step as it is or cancel it`;
}

/**
 * Moves each Item to its new slot: later keeps its approval, earlier asks for it again. Says what
 * happened, and who approved the ones that kept theirs.
 */
export async function moveItems(items: Pick<Items, "redateItem" | "setTriage" | "detail">, workspaceId: string, moves: { itemId: string; to: Date }[], actor: { userId: string }, timeZone: string) {
  const tally = { moved: 0, kept: 0, backToApproval: 0, overCap: 0, failed: 0 };
  const approverIds = new Set<string>();
  for (const m of moves) {
    const r = await items.redateItem(workspaceId, m.itemId, m.to, actor);
    if (!r.ok) {
      tally.failed++;
      continue;
    }
    tally.moved++;
    // The decision moves with the send, overruling a date set by hand for the old one.
    await items.setTriage(workspaceId, m.itemId, { decideBy: decideBy({ firstSlot: m.to, draftingDays: 0, timeZone }) });
    if (r.kept) {
      tally.kept++;
      // Who approved it, from its history, so a notice can tell them their approval moved.
      const seen = await items.detail(workspaceId, m.itemId);
      const approval = [...(seen?.timeline ?? [])].reverse().find((e) => e.from === "needs_approval" && e.to === "scheduled");
      if (approval?.actor.kind === "person") approverIds.add(approval.actor.id);
    }
    if (r.backToApproval) tally.backToApproval++;
    if (r.overCap) tally.overCap++;
  }
  return { tally, approverIds };
}

/** A new plan's Campaign, in the plan's transaction, owned by the person who started it (ADR 0023). */
export const campaignOnPlanCreated: OnPlanCreated = (tx, p) => ensureCampaign(tx, { workspaceId: p.workspaceId, planId: p.planId, ownerUserId: p.createdBy, now: p.at });

/**
 * Holds each set-up step the new version changed against the version it last settled on. The Campaign
 * is made with its plan; ensuring it here is a fallback for a plan that somehow has none, and never
 * changes an owner.
 */
export function campaignOnPlanApproved(deps: { now?: () => Date; items: () => Pick<Items, "settleGroupIn"> }): OnPlanApproved {
  const now = deps.now ?? (() => new Date());
  return async (tx, p) => {
    await ensureCampaign(tx, { workspaceId: p.workspaceId, planId: p.planId, ownerUserId: p.ownerUserId, now: now() });
    if (p.previousVersion === null) return;
    const campaign = await campaignOfPlan(tx, p.planId);
    const next = await p.readVersion(p.version);
    if (!campaign || !next) return;
    const bodies = new Map<number, PlanBody | null>();
    const bodyOf = async (v: number) => (bodies.has(v) ? bodies.get(v)! : bodies.set(v, await p.readVersion(v)).get(v)!);
    const open = new Map((await planChangesOf(tx, campaign.id)).filter((c) => !c.decided).map((c) => [c.stepKey, c]));
    const slots = await movableItems(tx, campaign.id);
    const actor = { userId: p.approvedBy };
    // Emails move after the commit; a choice is due by where its step's first one is going.
    const previous = await bodyOf(p.previousVersion);
    const shifts = new Map(previous ? diffPlans(previous, next, new Map()).steps.flatMap((c) => (c.kind === "changed" && c.redatedDays ? [[c.key, c.redatedDays] as const] : [])) : []);
    const timeZone = campaign.advanceTimeZone ?? "UTC";
    for (const row of await stepsOf(tx, campaign.id)) {
      if (row.cancelledAt) continue;
      const fromVersion = open.get(row.stepKey)?.fromVersion ?? p.previousVersion;
      const settled = await bodyOf(fromVersion);
      if (!settled) continue;
      const owned = new Map<string, Text>(row.template ? [[row.stepKey, row.template as Text]] : []);
      const change = diffPlans(settled, next, owned).steps.find((c) => c.key === row.stepKey);
      const kinds = change ? holdKinds(change) : [];
      const groupKey = groupOf(campaign.id, row.stepKey);
      if (!kinds.length) {
        // Back where it settled: nothing left to choose. Its Items resume after the commit.
        if (open.has(row.stepKey)) {
          await deps.items().settleGroupIn(tx, p.workspaceId, { kind: PLAN_CHANGE_KIND, groupKey, actor, next: null });
          await decidePlanChange(tx, row.campaignId, row.stepKey, { decided: "keep", userId: p.approvedBy, at: now() });
        }
        continue;
      }
      const step = (next.steps.find((s) => s.key === row.stepKey) ?? settled.steps.find((s) => s.key === row.stepKey))!;
      const earliest = slots.filter((s) => s.stepKey === row.stepKey).reduce<Date | null>((min, s) => (min && min <= s.plannedAt ? min : s.plannedAt), null);
      const shift = shifts.get(row.stepKey);
      const first = earliest && shift ? shiftAt(earliest, shift, timeZone) : earliest;
      const payload: PlanChangePayload = { campaignId: campaign.id, stepKey: row.stepKey, kinds };
      const { itemId } = await deps.items().settleGroupIn(tx, p.workspaceId, {
        kind: PLAN_CHANGE_KIND,
        groupKey,
        actor,
        next: { payload, details: { title: choiceTitle(step.title, kinds), workArea: "outreach", warnings: [] }, ...(first && { decideBy: first }) },
      });
      await putPlanChange(tx, {
        workspaceId: p.workspaceId,
        campaignId: campaign.id,
        stepKey: row.stepKey,
        fromVersion,
        toVersion: p.version,
        kinds,
        suggestedTemplate: kinds.includes("text") ? step.template! : null,
        itemId: itemId!,
      });
    }
    const moves = slots.flatMap((s) => {
      const days = shifts.get(s.stepKey);
      return days ? [{ itemId: s.itemId, to: shiftAt(s.plannedAt, days, timeZone).toISOString() }] : [];
    });
    const work: SettleWork = { kind: "plan", planId: p.planId, version: p.version, userId: p.approvedBy, timeZone, moves };
    await putSettlement(tx, { workspaceId: p.workspaceId, campaignId: campaign.id, key: `plan:${p.version}`, work, now: now() });
  };
}

/**
 * A person's choice on a held step, recorded in the choice's own transaction. Using the new text is
 * offered only when the plan suggested some, and only for a template step until per-Person redrafts exist.
 */
export function planChangeKinds(deps: { now?: () => Date } = {}): Record<string, ItemKind> {
  const now = deps.now ?? (() => new Date());
  return {
    [PLAN_CHANGE_KIND]: {
      permission: "item.edit",
      // Each step's choice is read on its own, never settled by "approve all clean".
      bulk: false,
      // Dismissing it would leave the step's emails held with nothing left to decide.
      dismiss: false,
      async apply(tx: CampaignsTx, item, actor, choice) {
        if (!choice || !CHOICES.includes(choice)) return { ok: false, reason: "choice_required" };
        const p = item.payload as PlanChangePayload;
        const change = (await planChangesOf(tx, p.campaignId)).find((c) => c.stepKey === p.stepKey && !c.decided && c.itemId === item.id);
        if (!change || !("userId" in actor)) return { ok: false, reason: "not_found" };
        if (choice === "use_new_text") {
          const step = (await stepsOf(tx, p.campaignId)).find((s) => s.stepKey === p.stepKey);
          if (!change.kinds.includes("text") || step?.draftingMode === "per_person") return { ok: false, reason: "choice_not_offered" };
        }
        if (choice === "cancel") await cancelSteps(tx, p.campaignId, [p.stepKey], actor.userId, now());
        await decidePlanChange(tx, p.campaignId, p.stepKey, { decided: choice as Choice, userId: actor.userId, at: now() });
        const work: SettleWork = { kind: "choice", itemId: item.id, stepKey: p.stepKey, userId: actor.userId };
        await putSettlement(tx, { workspaceId: item.workspaceId, campaignId: p.campaignId, key: `choice:${item.id}`, work, now: now() });
        return { ok: true };
      },
    },
    [UNFINISHED_KIND]: {
      permission: "item.edit",
      async apply(tx: CampaignsTx, item) {
        await retrySettlements(tx, (item.payload as { campaignId: string }).campaignId);
        return { ok: true };
      },
    },
  };
}

/** Lets each Item held for a plan change go again once its step has nothing left to choose. */
async function resumeSettled(items: Pick<Items, "view" | "resume">, workspaceId: string, campaignId: string, actor: { userId: string }) {
  const read = await inWorkspace(workspaceId, async (tx) => ({
    open: new Set((await planChangesOf(tx, campaignId)).filter((c) => !c.decided).map((c) => c.stepKey)),
    links: [...(await activeActions(tx, campaignId, null)), ...(await activePosts(tx, campaignId))],
  }));
  // ponytail: reads every Item of the Campaign once per decision; read only held ones if Campaigns grow past pilot size.
  for (const link of read.links) {
    if (read.open.has(link.stepKey)) continue;
    if ((await items.view(workspaceId, link.itemId))?.reasonCode === PLAN_CHANGED) await items.resume(workspaceId, link.itemId, actor);
  }
}

type SaveTemplate = (workspaceId: string, campaignId: string, stepKey: string, a: { revision: number; subject: string; text: string; userId: string }) => Promise<{ ok: boolean }>;

export function planChanges(d: { plans: Plans; facts: FactReads; items: () => Items; saveTemplate: SaveTemplate; now: () => Date }) {
  /** One owed piece of work. Each part is safe to do again, since a try can stop anywhere. */
  async function runWork(workspaceId: string, campaignId: string, w: SettleWork) {
    const actor = { userId: w.userId };
    if (w.kind === "plan") {
      const moves: { itemId: string; to: Date }[] = [];
      for (const m of w.moves) {
        const to = new Date(m.to);
        // Already there from an earlier try: moving it again would ask for its approval again.
        if ((await d.items().view(workspaceId, m.itemId))?.at?.getTime() !== to.getTime()) moves.push({ itemId: m.itemId, to });
      }
      await moveItems(d.items(), workspaceId, moves, actor, w.timeZone);
      const body = (await d.plans.planVersions(workspaceId, w.planId)).find((v) => v.version === w.version)?.body as PlanBody | undefined;
      for (const row of await inWorkspace(workspaceId, (tx) => stepsOf(tx, campaignId))) {
        const written = body?.steps.find((s) => s.key === row.stepKey)?.template;
        if (row.type === "email" && !row.template && written) await fillFromPlan(d, workspaceId, campaignId, row.stepKey, written);
      }
    } else {
      const read = await inWorkspace(workspaceId, async (tx) => ({
        change: (await planChangesOf(tx, campaignId)).find((c) => c.stepKey === w.stepKey && c.itemId === w.itemId),
        step: (await stepsOf(tx, campaignId)).find((s) => s.stepKey === w.stepKey),
        links: [...(await activeActions(tx, campaignId, w.stepKey)), ...(await activePosts(tx, campaignId)).filter((l) => l.stepKey === w.stepKey)],
      }));
      if (read.change && read.step && read.change.decided === "use_new_text") {
        const text = read.change.suggestedTemplate as Text;
        const now = read.step.template as Text | null;
        // A try after the save went through finds the new text in place.
        if (now?.subject !== text.subject || now.text !== text.text) {
          const saved = await d.saveTemplate(workspaceId, campaignId, w.stepKey, { revision: read.step.templateRevision, subject: text.subject, text: text.text, userId: w.userId });
          if (!saved.ok) throw new Error(`the plan's new text wasn't saved: ${(saved as { reason?: string }).reason ?? "refused"}`);
        }
      }
      // One already sent, or with an unknown outcome, refuses to cancel, and that's the right answer for it.
      if (read.change?.decided === "cancel") for (const link of read.links) await d.items().cancel(workspaceId, link.itemId, actor);
    }
    await resumeSettled(d.items(), workspaceId, campaignId, actor);
  }

  /** One Next step per Campaign while owed work keeps failing; none once it's done. */
  async function askIfStuck(workspaceId: string, campaignId: string) {
    const stuck = await inWorkspace(workspaceId, async (tx) => ({ rows: await stuckSettlements(tx, campaignId, STUCK_AFTER), campaign: await readCampaign(tx, campaignId) }));
    const groupKey = `${UNFINISHED_KIND}:${campaignId}`;
    const actor = { system: "campaigns" } as const;
    if (!stuck.rows.length || !stuck.campaign) return void (await d.items().settleGroup(workspaceId, { kind: UNFINISHED_KIND, groupKey, actor, next: null }));
    const title = (await d.plans.plan(workspaceId, stuck.campaign.planId))?.title ?? "this Campaign";
    await d.items().settleGroup(workspaceId, {
      kind: UNFINISHED_KIND,
      groupKey,
      actor,
      next: { payload: { campaignId }, details: { title: `A plan change to "${title}" didn't finish: some emails may be held or on old dates. Approve to try again`, workArea: "outreach", warnings: [] } },
    });
  }

  /** Does the Campaign's owed work, oldest first. A failure is counted and left for the sweep. */
  async function settle(workspaceId: string, campaignId: string) {
    const at = d.now();
    const rows = await inWorkspace(workspaceId, (tx) => claimSettlements(tx, campaignId, at, new Date(at.getTime() + HOLD_MS)));
    for (const row of rows) {
      try {
        await runWork(workspaceId, campaignId, row.work as SettleWork);
        await inWorkspace(workspaceId, (tx) => finishSettlement(tx, campaignId, row.key, d.now()));
      } catch (e) {
        await inWorkspace(workspaceId, (tx) => failSettlement(tx, campaignId, row.key, e instanceof Error ? e.message : String(e)));
      }
    }
    await askIfStuck(workspaceId, campaignId);
  }

  return {
    /**
     * What approving the plan's draft would do to this Campaign: the diff against the current version,
     * and each set-up step it would hold with its emails counted by state. Changes nothing.
     */
    async planImpact(workspaceId: string, campaignId: string) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const campaign = await readCampaign(tx, campaignId);
        return campaign && { campaign, rows: await stepsOf(tx, campaignId), counts: await stepCounts(tx, campaignId) };
      });
      if (!read) return null;
      const plan = await d.plans.plan(workspaceId, read.campaign.planId);
      if (!plan) return null;
      const draft = plan.draft as PlanBody | null;
      if (!plan.current || !Array.isArray(draft?.steps)) return { diff: { steps: [], plan: [] }, affected: [], titles: {} };
      const owned = new Map(read.rows.flatMap((r) => (r.template ? [[r.stepKey, r.template as Text] as const] : [])));
      const diff = diffPlans(plan.current, draft, owned);
      const setUp = new Map(read.rows.filter((r) => !r.cancelledAt).map((r) => [r.stepKey, r]));
      const affected = diff.steps.flatMap((c) => {
        const kinds = holdKinds(c);
        if (!kinds.length || !setUp.has(c.key)) return [];
        const counts = Object.fromEntries(read.counts.filter((n) => n.stepKey === c.key).map((n) => [n.state, n.n]));
        return [{ key: c.key, kinds, counts }];
      });
      // A removed step keeps the title it had; the draft's wins for the rest.
      const titles = Object.fromEntries([...plan.current.steps, ...draft.steps].map((s) => [s.key, s.title]));
      return { diff, affected, titles };
    },

    /** ADR 0023 rule 004: the Campaign an old plan link leads to, or undefined when the plan has none here. */
    async campaignIdOfPlan(workspaceId: string, planId: string): Promise<string | undefined> {
      return (await inWorkspace(workspaceId, (tx) => campaignOfPlan(tx, planId)))?.id;
    },

    /** After a plan version, a choice on one, or a person's "try again" commits: the owed work, now. */
    async planApplied(workspaceId: string, item: AppliedItem): Promise<void> {
      if (item.kind === PLAN_CHANGE_KIND || item.kind === UNFINISHED_KIND) return settle(workspaceId, (item.payload as { campaignId: string }).campaignId);
      if (item.kind !== PLAN_KIND) return;
      const { targetId: planId } = item.payload as { targetId: string };
      const campaign = await inWorkspace(workspaceId, (tx) => campaignOfPlan(tx, planId));
      if (campaign) await settle(workspaceId, campaign.id);
    },

    /** The sweep: every Campaign with owed work no run holds. */
    async settleAll(): Promise<void> {
      for (const c of await unsettledCampaigns()) {
        try {
          await settle(c.workspaceId, c.campaignId);
        } catch (e) {
          console.error("campaigns: settling a plan change failed", c, e);
        }
      }
    },
  };
}
