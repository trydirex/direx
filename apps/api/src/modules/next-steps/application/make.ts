// SPDX-License-Identifier: AGPL-3.0-only
// Puts a Next step in Needs you once an approval or a save has committed. Each one only suggests work,
// so the caller logs a failure here and never undoes what the person did. Whether a step can start is
// asked of campaigns, never worked out again here.
import { decideBy, type Campaigns } from "../../campaigns";
import type { AppliedItem, Items, Warning } from "../../items";
import { PLAN_KIND, type Plans } from "../../plans";
import { NEXT_STEP_KIND, needsTimeZone, targetOf, titleOf, workAreaOf, type NextStep } from "../domain/chain";

export type MakeDeps = {
  items: () => Pick<Items, "createItem" | "applyByGrant" | "setTriage" | "settleGroup">;
  campaigns: () => Pick<Campaigns, "list" | "campaign" | "draftInput" | "previewDrafts" | "personPreview" | "followUpsDue">;
  plans: Pick<Plans, "plan">;
};

const SYSTEM = { system: "next_steps" } as const;
/** How the history names a Next step a Campaign set to run started. */
export const ADVANCE = "campaign_advance";

/** A card made, the work area it would have been in when a person named another, or why none could be made. */
export type Offered = { itemId: string } | { otherArea: string } | { why: string };

type Campaign = NonNullable<Awaited<ReturnType<Campaigns["campaign"]>>>;

export function nextStepMaker(d: MakeDeps) {
  /** `onlyArea` is the work area a person named; a card for another area isn't made, and its area comes back instead. */
  async function offer(workspaceId: string, s: NextStep, c: Campaign, card: { title: string; workArea: string; warnings: Warning[]; decideBy?: Date; onlyArea?: string | undefined }): Promise<Offered> {
    if (card.onlyArea && card.onlyArea !== card.workArea) return { otherArea: card.workArea };
    const made = await d.items().createItem(workspaceId, {
      kind: NEXT_STEP_KIND,
      payload: s,
      actor: SYSTEM,
      replace: true,
      details: { title: card.title, workArea: card.workArea, groupKey: targetOf(s), groupLabel: c.title, warnings: card.warnings },
    });
    if (!made.ok) throw new Error(`next steps: ${made.reason}`);
    if (card.decideBy) await d.items().setTriage(workspaceId, made.item.id, { decideBy: card.decideBy });
    // Under run, the person who chose it already said yes to this start. A card that failed before
    // waits for a person, so a start that keeps failing can't loop; a refusal leaves it waiting too.
    if (c.advance !== "run" || card.warnings.length || !c.advanceSetBy) return { itemId: made.item.id };
    const choice = needsTimeZone(s) ? (c.advanceTimeZone ?? undefined) : undefined;
    await d.items().applyByGrant(workspaceId, made.item.id, { userId: c.advanceSetBy, as: ADVANCE, ...(choice && { choice }) });
    return { itemId: made.item.id };
  }

  /** The steps of the Campaign that could start drafting their text now, and why the last other one can't. */
  async function textless(workspaceId: string, c: Campaign) {
    const startable: { key: string; type: string }[] = [];
    let refused = "all_have_text";
    for (const step of c.steps) {
      if (step.template) continue;
      const input = await d.campaigns().draftInput(workspaceId, c.id, step.key);
      if (input.ok) startable.push(step);
      else refused = input.reason;
    }
    return { startable, refused };
  }
  /** A waiting text card has nothing left to start, so it goes. */
  const closeTemplates = (workspaceId: string, campaignId: string) => d.items().settleGroup(workspaceId, { kind: NEXT_STEP_KIND, groupKey: `plan_to_templates:${campaignId}`, actor: SYSTEM, next: null });

  /** One card for every step of the Campaign that could start drafting its text now. */
  async function offerTemplates(workspaceId: string, campaignId: string, warnings: Warning[] = [], onlyArea?: string): Promise<Offered> {
    const c = await d.campaigns().campaign(workspaceId, campaignId);
    if (!c) return { why: "not_found" };
    const plan = await d.plans.plan(workspaceId, c.planId);
    if (!plan || plan.currentVersion === null || plan.archivedAt) return { why: "plan_not_approved" };
    const { startable, refused } = await textless(workspaceId, c);
    if (!startable.length) {
      await closeTemplates(workspaceId, campaignId);
      return { why: refused };
    }
    const s: NextStep = { link: "plan_to_templates", campaignId, planId: c.planId, planVersion: plan.currentVersion, stepKeys: startable.map((x) => x.key) };
    return offer(workspaceId, s, c, { title: titleOf(s, { campaign: c.title }), workArea: workAreaOf(startable.map((x) => x.type)), warnings, onlyArea });
  }

  /** One card for a step whose saved template has People still without a draft. */
  async function offerDrafts(workspaceId: string, campaignId: string, stepKey: string, templateRevision: number, warnings: Warning[] = [], onlyArea?: string): Promise<Offered> {
    const preview = await d.campaigns().previewDrafts(workspaceId, campaignId, stepKey);
    if (!preview.ok) return { why: preview.reason };
    if (preview.willMake === 0) return { why: "nobody_waiting" };
    const c = await d.campaigns().campaign(workspaceId, campaignId);
    const step = c?.steps.find((x) => x.key === stepKey);
    if (!c || !step) return { why: "not_found" };
    const s: NextStep = { link: "template_to_drafts", campaignId, stepKey, templateRevision };
    return offer(workspaceId, s, c, { title: titleOf(s, { campaign: c.title, step: step.title ?? stepKey, people: preview.willMake }), workArea: workAreaOf([step.type]), warnings, onlyArea });
  }

  /** One card for a per-Person follow-up due soon, while People are still waiting on it. */
  async function offerFollowUp(workspaceId: string, campaignId: string, stepKey: string, warnings: Warning[] = [], onlyArea?: string): Promise<Offered> {
    const preview = await d.campaigns().personPreview(workspaceId, campaignId, stepKey);
    if (!preview.ok) return { why: preview.reason };
    if (preview.willWrite === 0) return { why: "nobody_waiting" };
    const c = await d.campaigns().campaign(workspaceId, campaignId);
    const step = c?.steps.find((x) => x.key === stepKey);
    if (!c || !step) return { why: "not_found" };
    const s: NextStep = { link: "due_to_drafts", campaignId, stepKey };
    // Drafting takes its days before the step's first send, and approving takes a working day after.
    const timeZone = c.advanceTimeZone ?? "UTC";
    const due = step.on ? decideBy({ firstSlot: new Date(`${step.on}T09:00:00Z`), draftingDays: preview.days ?? 0, timeZone }) : undefined;
    return offer(workspaceId, s, c, { title: titleOf(s, { campaign: c.title, step: step.title ?? stepKey, people: preview.willWrite }), workArea: "outreach", warnings, onlyArea, ...(due && { decideBy: due }) });
  }

  return {
    offerTemplates,
    offerDrafts,
    offerFollowUp,

    /**
     * A Next step a person asked for in Ask: the same card the chain would make, made now. When the
     * work can't start, the reason comes back, so Ask says why instead of claiming a card.
     */
    async offerAsked(workspaceId: string, a: { link: NextStep["link"]; campaignId: string; stepKey?: string | undefined; onlyArea?: string | undefined }): Promise<Offered> {
      if (a.link === "plan_to_templates") return offerTemplates(workspaceId, a.campaignId, [], a.onlyArea);
      if (!a.stepKey) return { why: "no_step" };
      if (a.link === "due_to_drafts") return offerFollowUp(workspaceId, a.campaignId, a.stepKey, [], a.onlyArea);
      const step = (await d.campaigns().campaign(workspaceId, a.campaignId))?.steps.find((x) => x.key === a.stepKey);
      if (!step) return { why: "not_found" };
      return step.template ? offerDrafts(workspaceId, a.campaignId, a.stepKey, step.templateRevision, [], a.onlyArea) : { why: "no_text_yet" };
    },

    /** The daily job: a card for every per-Person follow-up whose drafting lead has come. One failing Campaign doesn't stop the rest. */
    async offerFollowUps(): Promise<void> {
      for (const due of await d.campaigns().followUpsDue()) {
        await offerFollowUp(due.workspaceId, due.campaignId, due.stepKey).catch((e) => console.error("next steps: follow-up card failed", due, e));
      }
    },

    async onApplied(workspaceId: string, item: AppliedItem): Promise<void> {
      if (item.kind !== PLAN_KIND) return;
      const planId = (item.payload as { targetId: string }).targetId;
      const c = (await d.campaigns().list(workspaceId)).find((x) => x.planId === planId);
      if (c) await offerTemplates(workspaceId, c.id);
    },

    /** A drafting mode, a step type or a mailbox can each make text or drafts possible. */
    async onSetupChanged(workspaceId: string, s: { campaignId: string }): Promise<void> {
      await offerTemplates(workspaceId, s.campaignId);
      const c = await d.campaigns().campaign(workspaceId, s.campaignId);
      for (const step of c?.steps ?? []) if (step.type === "email" && step.template) await offerDrafts(workspaceId, s.campaignId, step.key, step.templateRevision);
    },

    /** The step's drafts can be made now, and once no step is left without text, its "Draft the text" card goes. */
    onTemplateSaved: async (workspaceId: string, s: { campaignId: string; stepKey: string; revision: number }): Promise<void> => {
      await offerDrafts(workspaceId, s.campaignId, s.stepKey, s.revision);
      const c = await d.campaigns().campaign(workspaceId, s.campaignId);
      if (c && !(await textless(workspaceId, c)).startable.length) await closeTemplates(workspaceId, s.campaignId);
    },
  };
}
export type NextStepMaker = ReturnType<typeof nextStepMaker>;
