// SPDX-License-Identifier: AGPL-3.0-only
// Writing a step's template. A run is given Facts, the Strategy and the plan, and no Person's data. Its
// output only fills the step's template: no Item and no Action, so a person reads it first.
import { datedSteps } from "../domain/anchor";
import type { DraftInput, Sink } from "../../agents";
import type { Facts } from "../../facts";
import { warn, type Warning } from "../../items";
import type { Plans } from "../../plans";
import { activeActions, anyDrafts, fillTemplate, inWorkspace, lockStep, readCampaign, requireApproved, setAdvance, setDraftingMode, setOutsideContent, setStepMode, stepHasDraft, stepsOf, warnTemplatesOfRuns, type CampaignsTx } from "../adapters/repo";
import { reviewClaims } from "../domain/claims";
import { fieldsIn, unknownFields } from "../domain/merge";
import type { TemplateBody, TemplateOutput } from "../definitions/drafter";

export type DraftingMode = "template" | "per_person";

/** A post as the posts module lists it, with the clip it carries. */
export type StepPost = { clipId: string | null; itemId: string; connection: string; mode: "publish" | "manual"; item: { state: string } };

/** What a campaign asks of the module that owns posts, so that module never imports this one. */
export type PostPort = {
  draft: (workspaceId: string, step: { campaignId: string; stepKey: string; title: string; plannedAt: Date }, targets: readonly PostTarget[], userId: string) => Promise<readonly unknown[]>;
  /** A step's posts, each with the clip it carries; a clips step reads them to see what is drafted. */
  list?: (workspaceId: string, campaignId: string, stepKey: string) => Promise<readonly StepPost[]>;
  /** A campaign post's step, words and revision, for a rewrite; null for any other Item. */
  ofItem?: (workspaceId: string, itemId: string) => Promise<{ campaignId: string; stepKey: string; text: string; state: string; revision: number } | null>;
  /** The same edit a person makes, with what the rewrite's words were checked for. */
  edit?: (workspaceId: string, itemId: string, text: string, userId: string, checked: { warnings: Warning[]; citations: readonly { factId: string; version: number }[] }) => Promise<{ ok: true } | { ok: false; reason: string }>;
};
export type PostTarget = {
  connection: string;
  credentialId: string | null;
  networkId: string | null;
  text: string;
  followUps?: string[] | undefined;
  mediaId?: string | null | undefined;
  mediaIds?: readonly string[] | undefined;
  alt?: readonly string[] | undefined;
  clipId?: string | null | undefined;
  at?: Date | undefined;
  citations?: readonly { factId: string; version: number }[] | undefined;
};

export type StepDraftInput = DraftInput & { target: DraftInput["target"] & { stepKey: string } };
/** `redraft` is the post a rewrite revises, as `userId` asked; without it the run fills the step's template. */
type PostRedraftInput = StepDraftInput & { target: StepDraftInput["target"] & { redraft?: string; userId?: string } };
/** Where a post may still be rewritten, as for an email: before it goes. */
const REWRITABLE: ReadonlySet<string> = new Set(["draft", "needs_approval", "scheduled"]);
export type StartDraft = (workspaceId: string, a: { agent: string; input: DraftInput; startedBy: string; trigger?: "advance"; tainted?: boolean }) => Promise<{ ok: true; run: { id: string } } | { ok: false; reason: string }>;
export type FactReads = Pick<Facts, "usableFacts" | "checkCitation" | "bannedClaimsIn">;

/** Checks written text, whoever wrote it, so a person's edit is held to the same words as a run's. */
export async function reviewTemplate(workspaceId: string, facts: FactReads, o: TemplateOutput, sourced: readonly string[] = []): Promise<TemplateBody> {
  const usable = await facts.usableFacts(workspaceId);
  const text = `${o.subject}\n${o.text}`;
  const citations: TemplateOutput["citations"] = [];
  for (const c of o.citations) if ((await facts.checkCitation(workspaceId, c.factId, c.version)) === "ok") citations.push(c);
  const cited = usable.filter((f) => citations.some((c) => c.factId === f.id && c.version === f.version)).map((f) => f.value);
  const prices = usable.filter((f) => f.field === "price").map((f) => f.value);
  const { uncited, conflicts } = reviewClaims(text, [...cited, ...sourced], prices);
  const banned = await facts.bannedClaimsIn(workspaceId, text);
  return {
    ...o,
    citations,
    warnings: [...uncited.map((n) => warn("uncited_number", `A number with no source: "${n}"`)), ...banned.map((p) => warn("banned_claim", `Uses a banned claim: "${p}"`))],
    needsDecision: conflicts.map((n) => warn("price_conflict", `No price Fact says "${n}"`)),
  };
}

/** What every drafter is told, from inside the Workspace: the date, Facts, the Strategy and the plan. */
export async function briefFor(workspaceId: string, d: { plans: Plans; facts: FactReads; now: () => Date }, planId: string, plan: unknown, planVersion: number | null, strategyVersion: number | null): Promise<DraftInput["brief"]> {
  const usable = await d.facts.usableFacts(workspaceId);
  const list = usable.map((f) => `${f.id} version ${f.version}: ${f.field}${f.subject ? ` (${f.subject})` : ""}: ${f.value}`).join("\n");
  const pinned = (await d.plans.strategyVersions(workspaceId)).find((v) => v.version === strategyVersion);
  return [
    { kind: "date", refId: "today", version: null, text: `Today is ${d.now().toISOString().slice(0, 10)}.` },
    { kind: "citable_facts", refId: "usable_facts", version: null, text: usable.length ? `Facts you may cite, by id and version:\n${list}` : "There are no Facts to cite." },
    ...(pinned ? [{ kind: "strategy", refId: pinned.strategyId, version: String(pinned.version), text: `The Strategy:\n${JSON.stringify(pinned.body)}` }] : []),
    { kind: "plan", refId: planId, version: String(planVersion), text: `The plan:\n${JSON.stringify(plan)}` },
  ];
}

/** After a step's template is written and committed, by a person (their id) or by a drafting run (null). */
export type OnTemplateSaved = (workspaceId: string, s: { campaignId: string; stepKey: string; revision: number; userId: string | null }) => Promise<void>;

/** Given by the composition root, so standing rules hear of a changed answer in the same transaction. */
export type OnOutsideContentChanged = (tx: CampaignsTx, campaignId: string, at: Date) => Promise<void>;

/** After a Campaign's setup (drafting mode, a step's type or mailbox) is saved and committed. Only suggests work, so a failure never undoes it. */
export type OnSetupChanged = (workspaceId: string, s: { campaignId: string }) => Promise<void>;

export function campaignDrafting({ plans, facts, startDraft, now, onOutsideContentChanged, onSetupChanged, posts }: { plans: Plans; facts: FactReads; startDraft: () => StartDraft; now: () => Date; onOutsideContentChanged?: OnOutsideContentChanged | undefined; onSetupChanged?: OnSetupChanged | undefined; posts?: (() => PostPort) | undefined }) {
  async function draftInput(workspaceId: string, campaignId: string, stepKey: string) {
    const read = await inWorkspace(workspaceId, async (tx) => {
      const row = await readCampaign(tx, campaignId);
      return row && { row, step: (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey), hasDrafts: (await activeActions(tx, campaignId, stepKey)).length > 0 };
    });
    if (!read) return { ok: false, reason: "not_found" } as const;
    // A post has one text and no Person, so the email's choice of mode doesn't apply.
    const post = read.step?.type === "post";
    if (read.step?.type === "email" && !read.step.draftingMode) return { ok: false, reason: "drafting_mode_required" } as const;
    if (read.step?.type === "email" && read.step.draftingMode !== "template") return { ok: false, reason: "wrong_mode" } as const;
    const plan = await plans.plan(workspaceId, read.row.planId);
    const planned = plan?.current ? datedSteps(plan.current, read.row.anchorOn).find((s) => s.key === stepKey) : undefined;
    if (!plan?.current || !planned) return { ok: false, reason: "step_not_in_plan" } as const;
    if (read.step?.type !== "email" && !post) return { ok: false, reason: "not_an_email_step" } as const;
    // A person edits text under existing drafts, so a run can't swap the template out from under them.
    if (read.hasDrafts) return { ok: false, reason: "drafts_already_made" } as const;

    const brief = await briefFor(workspaceId, { plans, facts, now }, read.row.planId, plan.current, plan.currentVersion, plan.strategyVersion);
    // A step waiting on another's output links to it through the one field that names it.
    const dependsOn = read.step?.dependsOnStepKey ? plan.current.steps.find((s) => s.key === read.step!.dependsOnStepKey) : undefined;
    const link = dependsOn ? ` Include the link to "${dependsOn.title}" written exactly as {{steps.${dependsOn.key}.url}}.` : "";
    const input: StepDraftInput = {
      request: `Write the ${post ? "post" : "email"} for the step "${planned.title}", planned for ${planned.on}.${link}`,
      brief,
      target: { id: campaignId, draftRevision: read.step!.templateRevision, stepKey },
    };
    return { ok: true, input, agent: post ? "social_drafter" : "campaign_drafter" } as const;
  }

  return {
    draftInput,

    /**
     * Rewrites one campaign post as a person asked: the Social agent gets the post's words as data and the
     * person's words in its request. Null when the Item is no campaign post, so an email's rewrite takes it.
     */
    /** `tainted` when the instruction came from a run that read untrusted text, such as Ask's. */
    async redraftPost(workspaceId: string, itemId: string, a: { instruction: string; userId: string; tainted?: boolean | undefined }) {
      const post = await posts?.().ofItem?.(workspaceId, itemId);
      if (!post) return null;
      if (!REWRITABLE.has(post.state)) return { ok: false, reason: "already_going" } as const;
      const row = await inWorkspace(workspaceId, (tx) => readCampaign(tx, post.campaignId));
      const plan = row && (await plans.plan(workspaceId, row.planId));
      const planned = plan?.current ? datedSteps(plan.current, row!.anchorOn).find((s) => s.key === post.stepKey) : undefined;
      if (!row || !plan?.current || !planned) return { ok: false, reason: "step_not_in_plan" } as const;
      const input: PostRedraftInput = {
        request: `Rewrite the post for the step "${planned.title}", planned for ${planned.on}, as the person asked: ${a.instruction}`,
        brief: await briefFor(workspaceId, { plans, facts, now }, row.planId, plan.current, plan.currentVersion, plan.strategyVersion),
        // The current words may be a model's, so they ride as data, never in the request.
        attached: { id: itemId, text: `The current post, to rewrite:\n${post.text}` },
        target: { id: post.campaignId, draftRevision: post.revision, stepKey: post.stepKey, redraft: itemId, userId: a.userId },
      };
      const run = await startDraft()(workspaceId, { agent: "social_drafter", input, startedBy: a.userId, ...(a.tainted && { tainted: true }) });
      return run.ok ? ({ ok: true, runId: run.run.id } as const) : ({ ok: false, reason: run.reason } as const);
    },

    /** Marks templates these runs wrote, unless a person saved over them since; drafts made from one carry it. */
    warnTemplates: (workspaceId: string, runIds: readonly string[], text: string) => inWorkspace(workspaceId, (tx) => warnTemplatesOfRuns(tx, runIds, warn("unspecified", text))),

    /** `trigger` is "advance" when a Campaign set to run started it rather than a press of Start. */
    async startDraft(workspaceId: string, campaignId: string, stepKey: string, startedBy: string, trigger?: "advance") {
      const asked = await draftInput(workspaceId, campaignId, stepKey);
      if (!asked.ok) return asked;
      return startDraft()(workspaceId, { agent: asked.agent, input: asked.input, startedBy, ...(trigger && { trigger }) });
    },

    /**
     * One answer for the whole Campaign, from before modes moved to steps: it sets every email step,
     * and steps set up later start with it. Refused once anything has been written.
     */
    async setDraftingMode(workspaceId: string, campaignId: string, mode: DraftingMode) {
      const set = await inWorkspace(workspaceId, async (tx) => {
        const approved = await requireApproved(tx, campaignId);
        if (!approved.ok) return approved;
        if (await anyDrafts(tx, campaignId)) return { ok: false, reason: "drafting_mode_locked" } as const;
        const at = now();
        await setDraftingMode(tx, campaignId, mode, at);
        for (const s of await stepsOf(tx, campaignId)) if (s.type === "email") await setStepMode(tx, campaignId, s.stepKey, mode, at);
        return { ok: true } as const;
      });
      if (set.ok) await onSetupChanged?.(workspaceId, { campaignId }).catch((e) => console.error("campaigns: onSetupChanged failed", campaignId, e));
      return set;
    },

    /** How one email step is written. It can change until that step has a draft. */
    async setStepDraftingMode(workspaceId: string, campaignId: string, stepKey: string, mode: DraftingMode) {
      const set = await inWorkspace(workspaceId, async (tx) => {
        const approved = await requireApproved(tx, campaignId);
        if (!approved.ok) return approved;
        if ((await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey)?.type !== "email") return { ok: false, reason: "not_an_email_step" } as const;
        if (await stepHasDraft(tx, campaignId, stepKey)) return { ok: false, reason: "drafting_mode_locked" } as const;
        await setStepMode(tx, campaignId, stepKey, mode, now());
        return { ok: true } as const;
      });
      if (set.ok) await onSetupChanged?.(workspaceId, { campaignId }).catch((e) => console.error("campaigns: onSetupChanged failed", campaignId, e));
      return set;
    },

    /**
     * Whether drafts shaped by a recipient's website or list values may go out under an agent-written
     * rule. A change either way stops those rules, in the same transaction, until a person re-confirms.
     */
    setOutsideContent: (workspaceId: string, campaignId: string, a: { allowed: boolean; userId: string }) =>
      inWorkspace(workspaceId, async (tx) => {
        const approved = await requireApproved(tx, campaignId);
        if (!approved.ok) return approved;
        const row = approved.campaign;
        if (row.outsideContentAllowed === a.allowed) return { ok: true } as const;
        const at = now();
        await setOutsideContent(tx, campaignId, a.allowed, a.userId, at);
        await onOutsideContentChanged?.(tx, campaignId, at);
        return { ok: true } as const;
      }),

    /**
     * Under run, Next steps start as soon as they are made, as this person, with drafts timed in their
     * zone. Turning it on offers the Campaign's work again, so a card already waiting starts too.
     */
    async setAdvance(workspaceId: string, campaignId: string, a: { advance: "offer" | "run"; timeZone: string | null; userId: string }) {
      if (a.advance === "run" && (!a.timeZone || !isTimeZone(a.timeZone))) return { ok: false, reason: "bad_time_zone" } as const;
      const set = await inWorkspace(workspaceId, async (tx) => {
        const approved = await requireApproved(tx, campaignId);
        if (!approved.ok) return approved;
        await setAdvance(tx, campaignId, { ...a, timeZone: a.advance === "run" ? a.timeZone : null }, now());
        return { ok: true } as const;
      });
      if (set.ok && a.advance === "run") await onSetupChanged?.(workspaceId, { campaignId }).catch((e) => console.error("campaigns: onSetupChanged failed", campaignId, e));
      return set;
    },
  };
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Where a template lands. Safe to call twice: a run that already wrote the template is done. */
export async function templateSink(workspaceId: string, proposal: Parameters<Sink>[1], context: Parameters<Sink>[2], d: { facts: FactReads; now: () => Date; onTemplateSaved?: OnTemplateSaved | undefined; posts?: (() => PostPort) | undefined }): ReturnType<Sink> {
  // A post's draft has no subject, and no Person for a merge field to stand for.
  const output = { subject: "", ...(proposal.body as Omit<TemplateOutput, "subject">) } as TemplateOutput;
  const { target } = context.input as PostRedraftInput;
  if (target.redraft) return postRedraftSink(workspaceId, output, { ...target, redraft: target.redraft }, d);
  // Only the step this one waits on may be named. A post has no Person, so it may name nothing else.
  const linked = await inWorkspace(workspaceId, async (tx) => (await stepsOf(tx, target.id!)).find((s) => s.stepKey === target.stepKey));
  const allowedSteps = linked?.dependsOnStepKey ? [linked.dependsOnStepKey] : [];
  const written = `${output.subject}\n${output.text}`;
  const refused = output.subject ? unknownFields(written, allowedSteps) : fieldsIn(written).filter((f) => !allowedSteps.some((k) => f === `steps.${k}.url`));
  if (refused.length) return { ok: false, code: "unknown_merge_field" };
  const body = await reviewTemplate(workspaceId, d.facts, output);
  const filled = await inWorkspace(workspaceId, async (tx) => {
    const step = await lockStep(tx, target.id!, target.stepKey);
    if (!step) return { ok: false, code: "not_found" } as const;
    if (step.draftRunId === context.runId) return { ok: true, revision: null } as const;
    if (step.templateRevision !== target.draftRevision) return { ok: false, code: "target_changed" } as const;
    await fillTemplate(tx, { campaignId: target.id!, stepKey: target.stepKey, template: body, revision: step.templateRevision + 1, runId: context.runId, now: d.now() });
    return { ok: true, revision: step.templateRevision + 1 } as const;
  });
  if (!filled.ok) return filled;
  // A repeat hand-over wrote nothing, so it tells no one. A kept draft a person used names them.
  if (filled.revision !== null) await d.onTemplateSaved?.(workspaceId, { campaignId: target.id!, stepKey: target.stepKey, revision: filled.revision, userId: context.userId ?? null }).catch((e) => console.error("campaigns: onTemplateSaved failed", target.id, target.stepKey, e));
  return { ok: true, itemId: null };
}

/**
 * A post's rewrite lands only on the post it was asked for, as it stood: a person's edit since wins. It goes
 * through a person's edit, so the network's rules apply and any approval is void; it waits for approval again.
 */
async function postRedraftSink(workspaceId: string, output: TemplateOutput, target: PostRedraftInput["target"] & { redraft: string }, d: { facts: FactReads; posts?: (() => PostPort) | undefined }): ReturnType<Sink> {
  const port = d.posts?.();
  if (!port?.ofItem || !port.edit || !target.userId) return { ok: false, code: "posts_unavailable" };
  if (fieldsIn(output.text).length) return { ok: false, code: "unknown_merge_field" };
  if ((await port.ofItem(workspaceId, target.redraft))?.revision !== target.draftRevision) return { ok: false, code: "changed_since" };
  const body = await reviewTemplate(workspaceId, d.facts, output);
  // A price no Fact says is a person's call, as it is when they edit an email.
  if (body.needsDecision.length) return { ok: false, code: "needs_decision" };
  const edited = await port.edit(workspaceId, target.redraft, output.text, target.userId, { warnings: body.warnings, citations: body.citations });
  return edited.ok ? { ok: true, itemId: target.redraft } : { ok: false, code: edited.reason };
}
