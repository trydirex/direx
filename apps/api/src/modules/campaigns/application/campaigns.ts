// SPDX-License-Identifier: AGPL-3.0-only
// One campaign per approved plan, and how its steps are set up. What a new plan version does to a
// running Campaign is in plan-change.ts.
import { credentialLabel } from "../../credentials";
import type { PlanBody, Plans } from "../../plans";
import type { TemplateBody } from "../definitions/drafter";
import { activityRows, allPeople, campaignMailboxes, deleteDraftRows, interestedPeople, postCounts, repliedCount, repliedPeople, resultCounts, stepCounts, waitingCount, ensureStep, fillTemplate, inWorkspace, isConnectedMailbox, latestOutput, listCampaigns, lockStep, movableItems, planChangesOf, readCampaign, requireApproved, saveStep, saveStepMailboxes, stepMailboxes, setCampaignNotes, setStepMode, stepsOf, type CampaignRow, type OutputRow, type StepRow, type StepSetup } from "../adapters/repo";
import { datedSteps, stepDate } from "../domain/anchor";
import { lifecycle } from "../domain/lifecycle";
import { stepFunnel, sumBy, tally } from "../domain/counts";
import { timeZoneOf } from "../../schedule";
import type { HoldKind } from "../domain/plan-diff";
import { defaultModes, type StepMode } from "../domain/timing";
import { reviewTemplate, type FactReads, type OnSetupChanged, type PostPort, type PostTarget } from "./drafting";
import { RUN_CAP_CENTS } from "./person-drafts";
import { stepLinkRefusal } from "./step-links";
import { reasonLabel, type Items } from "../../items";
import { activityLines, LAUNCH_MOVED_KIND, launchUndo } from "../domain/activity";

/** An email step with no text yet takes its plan's, checked as a person's edit would be. A step that has text keeps it. */
export async function fillFromPlan(d: { facts: FactReads; now: () => Date }, workspaceId: string, campaignId: string, stepKey: string, written: NonNullable<PlanBody["steps"][number]["template"]>) {
  const body = await reviewTemplate(workspaceId, d.facts, { schemaVersion: 1, ...written });
  await inWorkspace(workspaceId, async (tx) => {
    const step = (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey);
    if (step && !step.template && step.templateRevision === 0) await fillTemplate(tx, { campaignId, stepKey, template: body, revision: 1, runId: null, now: d.now() });
  });
}

type PlanStep = { key: string; on: string; title: string };
type StepOutputView = { url: string; version: number; source: "person" | "system"; at: string };
export type CampaignStep = Pick<StepRow, "type" | "touchClass" | "mailboxCredentialId" | "audience" | "templateRevision" | "dmChannel" | "dependsOnStepKey" | "outputConnection" | "outputNetworkId" | "utm" | "writerNotes" | "writerNotesRevision"> & {
  key: string;
  on: string | null;
  title: string | null;
  inPlan: boolean;
  template: TemplateBody | null;
  waitingOn: string | null;
  output: StepOutputView | null;
  draftingMode: StepMode | null;
  cancelled: boolean;
  waived: boolean;
  /** The Mailboxes the step's emails are shared across. `mailboxCredentialId` is the first, until it goes. */
  mailboxCredentialIds: string[];
};
/**
 * A step's setup as a person saves it. The Mailboxes come as a list; one Mailbox alone is still taken
 * until the web picks several. The step's first-Mailbox column follows the list until it is dropped.
 */
export type StepSetupInput = Omit<StepSetup, "mailboxCredentialId"> & { mailboxCredentialId?: string | null; mailboxCredentialIds?: string[] };

const setupOf = (row: StepRow | undefined) => ({
  type: row?.type ?? "manual",
  touchClass: row ? row.touchClass : "cold",
  mailboxCredentialId: row?.mailboxCredentialId ?? null,
  audience: row?.audience ?? "everyone",
  dmChannel: row?.dmChannel ?? null,
  dependsOnStepKey: row?.dependsOnStepKey ?? null,
  outputConnection: row?.outputConnection ?? null,
  outputNetworkId: row?.outputNetworkId ?? null,
  utm: row?.utm ?? false,
  template: (row?.template ?? null) as TemplateBody | null,
  templateRevision: row?.templateRevision ?? 0,
  writerNotes: row?.writerNotes ?? null,
  writerNotesRevision: row?.writerNotesRevision ?? 0,
  draftingMode: (row?.draftingMode ?? null) as StepMode | null,
  cancelled: row?.cancelledAt != null,
  waived: row?.dependencyWaivedAt != null,
});

/**
 * The plan's steps in order, then any set up earlier that the plan has since dropped, titled as in the last
 * version that held them (`pastTitles`). `outputs` holds each step's latest recorded output; a step waits
 * while the step it depends on has none.
 */
export function stepsView(planSteps: PlanStep[], rows: StepRow[], outputs: ReadonlyMap<string, OutputRow> = new Map(), pastTitles: ReadonlyMap<string, string> = new Map(), mailboxes: ReadonlyMap<string, string[]> = new Map()): CampaignStep[] {
  const byKey = new Map(rows.map((r) => [r.stepKey, r]));
  const keys = new Set(planSteps.map((s) => s.key));
  const links = (key: string, row: StepRow | undefined) => {
    const out = outputs.get(key);
    const dependsOn = row?.dependsOnStepKey ?? null;
    return {
      waitingOn: dependsOn !== null && !outputs.has(dependsOn) ? dependsOn : null,
      output: out ? { url: out.url, version: out.version, source: out.source as StepOutputView["source"], at: out.at.toISOString() } : null,
    };
  };
  return [
    ...planSteps.map((s) => ({ key: s.key, on: s.on, title: s.title, inPlan: true, ...setupOf(byKey.get(s.key)), mailboxCredentialIds: mailboxes.get(s.key) ?? [], ...links(s.key, byKey.get(s.key)) })),
    ...rows.filter((r) => !keys.has(r.stepKey)).map((r) => ({ key: r.stepKey, on: null, title: pastTitles.get(r.stepKey) ?? null, inPlan: false, ...setupOf(r), mailboxCredentialIds: mailboxes.get(r.stepKey) ?? [], ...links(r.stepKey, r) })),
  ];
}

export type { PostPort, PostTarget, StepPost } from "./drafting";

/** Today in the Workspace's time zone, the day a Campaign's dates are read against. */
const todayIn = async (workspaceId: string, at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: await timeZoneOf(workspaceId), year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

/** The run's last day: the plan's end, moved with the launch like every step. */
const runEndsOn = (row: CampaignRow, current: PlanBody | null) =>
  current ? (row.anchorOn ? stepDate({ planStartsOn: current.startsOn, stepOn: current.endsOn, anchorOn: row.anchorOn }) : current.endsOn) : null;

/** ADR 0023 rule 003: the Campaign's status and the changes-waiting marker, from its row and its plan. */
const statusOf = (row: CampaignRow, plan: { currentVersion: number | null; waiting: unknown; current: PlanBody | null }, today: string) =>
  lifecycle({ endsOn: runEndsOn(row, plan.current), paused: row.pausedAt !== null, approved: plan.currentVersion !== null, waiting: plan.waiting !== null, launchOn: row.anchorOn ?? plan.current?.startsOn ?? null }, today);

export function campaignStore({ plans, facts, items, outreach, posts, now, onSetupChanged }: { plans: Plans; facts: FactReads; items: () => Items; outreach: () => { canSendFrom: (workspaceId: string, credentialId: string) => Promise<boolean> }; posts?: (() => PostPort) | undefined; now: () => Date; onSetupChanged?: OnSetupChanged | undefined }) {
  // Versions are oldest first, so the last title wins for a step no longer in the plan.
  const pastTitlesOf = async (workspaceId: string, planId: string, rows: StepRow[], current: PlanBody | null | undefined) => {
    const titles = new Map<string, string>();
    if (rows.some((r) => !current?.steps.some((s) => s.key === r.stepKey)))
      for (const v of await plans.planVersions(workspaceId, planId)) for (const s of (v.body as PlanBody).steps) titles.set(s.key, s.title);
    return titles;
  };
  return {
    /** One draft per account. A step's drafts go through the same Items and approvals as email. */
    async draftPosts(workspaceId: string, campaignId: string, stepKey: string, a: { plannedAt: Date; targets: readonly PostTarget[] }, userId: string) {
      if (!posts) return { ok: false, reason: "posts_unavailable" } as const;
      const read = await inWorkspace(workspaceId, async (tx) => {
        const row = await readCampaign(tx, campaignId);
        return row && { row, steps: await stepsOf(tx, campaignId) };
      });
      if (!read) return { ok: false, reason: "not_found" } as const;
      if (read.steps.find((s) => s.stepKey === stepKey)?.type !== "post") return { ok: false, reason: "not_a_post_step" } as const;
      const plan = await plans.plan(workspaceId, read.row.planId);
      const step = plan?.current?.steps.find((s) => s.key === stepKey);
      if (!step) return { ok: false, reason: "step_not_in_plan" } as const;
      // A time already gone can't be approved, so it isn't drafted either, as on the Calendar.
      if (a.plannedAt <= now()) return { ok: false, reason: "slot_in_past" } as const;
      return { ok: true, results: await posts().draft(workspaceId, { campaignId, stepKey, title: step.title, plannedAt: a.plannedAt }, a.targets, userId) } as const;
    },

    /**
     * Each campaign with what its row on the list says: its status, dates, steps done, sent, replied, and what
     * waits for approval. An archived plan's campaign leaves the list; a Draft is listed with its status (ADR 0023).
     */
    // ponytail: a plan read and two counts per campaign; one grouped query once a Workspace has hundreds of campaigns.
    async list(workspaceId: string) {
      const [rows, planRows, today] = await Promise.all([inWorkspace(workspaceId, listCampaigns), plans.plans(workspaceId), todayIn(workspaceId, now())]);
      const live = new Set(planRows.map((p) => p.id));
      const listed = await Promise.all(
        rows
          .filter((r) => live.has(r.planId))
          .map(async (r) => {
            const [plan, counts, replied, needApproval, steps] = await Promise.all([
              plans.plan(workspaceId, r.planId),
              inWorkspace(workspaceId, (tx) => stepCounts(tx, r.id)),
              inWorkspace(workspaceId, (tx) => repliedCount(tx, r.id)),
              inWorkspace(workspaceId, (tx) => waitingCount(tx, r.id)),
              inWorkspace(workspaceId, (tx) => stepsOf(tx, r.id)),
            ]);
            if (!plan) return undefined;
            // The plan's first measure is its main one.
            const main = plan.tracking?.measures[0];
            const total = (state: string) => counts.filter((c) => c.state === state).reduce((n, c) => n + c.n, 0);
            return {
              id: r.id,
              planId: r.planId,
              title: plan.title,
              ownerUserId: r.ownerUserId,
              draftingMode: r.draftingMode,
              paused: r.pausedAt !== null,
              ...statusOf(r, plan, today),
              goal: plan.current?.goal ?? null,
              startsOn: plan.current?.startsOn ?? null,
              launchOn: r.anchorOn ?? plan.current?.startsOn ?? null,
              endsOn: plan.current?.endsOn ?? null,
              planned: plan.tracking?.planned ?? 0,
              done: plan.tracking?.done ?? 0,
              sent: total("sent"),
              replied,
              needApproval,
              measure: main ? { label: main.label, target: main.target, value: main.latest?.value ?? null } : null,
              channels: [...new Set(steps.filter((s) => !s.cancelledAt).map((s) => s.type))],
            };
          }),
      );
      return listed.filter((c): c is NonNullable<typeof c> => c !== undefined);
    },

    /**
     * What is known of how the campaign went: sends by channel, what came back on its email, each plan
     * measure against its target, and each step's funnel. Opens and clicks are not recorded for campaign
     * email, so they are absent.
     */
    async outcomes(workspaceId: string, id: string) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const row = await readCampaign(tx, id);
        if (!row) return row;
        const sent = (await stepCounts(tx, id)).filter((c) => c.state === "sent");
        const stepPosts = (await postCounts(tx, id)).filter((c) => c.state === "sent");
        const people = { replied: tally(await repliedPeople(tx, id)), interested: tally(await interestedPeople(tx, id)) };
        return { row, steps: await stepsOf(tx, id), sent, stepPosts, people, replied: await repliedCount(tx, id), emails: sent.reduce((n, c) => n + c.n, 0), ...(await resultCounts(tx, id)) };
      });
      if (!read) return undefined;
      const plan = await plans.plan(workspaceId, read.row.planId);
      const pastTitles = await pastTitlesOf(workspaceId, read.row.planId, read.steps, plan?.current);
      const steps = stepsView(plan?.current?.steps ?? [], read.steps, new Map(), pastTitles).map((s) => ({ stepKey: s.key, title: s.title, type: s.type, dmChannel: s.dmChannel }));
      return {
        sent: [
          ...(read.emails ? [{ kind: "email" as const, channel: "email", n: read.emails }] : []),
          ...read.posts.map((p) => ({ kind: "post" as const, ...p })),
          ...[...sumBy(read.dms, "channel")].map(([channel, n]) => ({ kind: "dm" as const, channel, n })),
        ],
        // Nothing comes back on email that was never sent.
        email: read.emails ? { replied: read.replied, bounced: read.bounced, optedOut: read.optedOut } : null,
        measures: (plan?.tracking?.measures ?? []).map((m) => ({ key: m.key, label: m.label, target: m.target, value: m.latest?.value ?? null, observedOn: m.latest?.observedOn ?? null })),
        steps: stepFunnel(steps, { emails: sumBy(read.sent, "stepKey"), dms: sumBy(read.dms, "stepKey"), posts: sumBy(read.stepPosts, "stepKey"), replied: read.people.replied.byStep, interested: read.people.interested.byStep }),
      };
    },

    async campaign(workspaceId: string, id: string) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const row = await readCampaign(tx, id);
        if (!row) return row;
        const people = await allPeople(tx, id);
        const counts = await stepCounts(tx, id);
        const steps = await stepsOf(tx, id);
        const outputs = new Map<string, OutputRow>();
        for (const s of steps) {
          const out = await latestOutput(tx, id, s.stepKey);
          if (out) outputs.set(s.stepKey, out);
        }
        const changes = (await planChangesOf(tx, id)).filter((c) => !c.decided);
        const slots = changes.length ? await movableItems(tx, id) : [];
        return { row, steps, outputs, mailboxes: await campaignMailboxes(tx, id), changes, slots, sent: counts.filter((c) => c.state === "sent").reduce((n, c) => n + c.n, 0), replied: people.filter((p) => p.status === "replied").length };
      });
      if (!read) return undefined;
      const plan = await plans.plan(workspaceId, read.row.planId);
      if (!plan) return undefined;
      // A dropped step keeps the title from the last version that held it; versions are read only when one is dropped.
      const pastTitles = await pastTitlesOf(workspaceId, read.row.planId, read.steps, plan.current);
      // A step a plan version held carries what changed and the choice waiting on it.
      const steps = stepsView(plan.current ? datedSteps(plan.current, read.row.anchorOn) : [], read.steps, read.outputs, pastTitles, read.mailboxes).map((s) => {
        const c = read.changes.find((x) => x.stepKey === s.key);
        const text = c?.suggestedTemplate as { subject: string; text: string } | null | undefined;
        // Emails whose slot has passed while they waited move to the next free slot on "keep".
        const expired = read.slots.filter((x) => x.stepKey === s.key && x.plannedAt < now()).length;
        return { ...s, planChange: c ? { kinds: c.kinds as HoldKind[], suggestedTemplate: text ? { subject: text.subject, text: text.text } : null, itemId: c.itemId, expired } : null };
      });
      return {
        id: read.row.id,
        planId: read.row.planId,
        title: plan.title,
        ownerUserId: read.row.ownerUserId,
        draftingMode: read.row.draftingMode,
        paused: read.row.pausedAt !== null,
        ...statusOf(read.row, plan, await todayIn(workspaceId, now())),
        createdBy: plan.createdBy,
        outsideContentAllowed: read.row.outsideContentAllowed,
        advance: read.row.advance as "offer" | "run",
        advanceSetBy: read.row.advanceSetBy,
        advanceTimeZone: read.row.advanceTimeZone,
        goal: plan.current?.goal ?? null,
        startsOn: plan.current?.startsOn ?? null,
        // The launch every step keeps its distance from, and the step it follows, if any.
        anchor: { on: read.row.anchorOn ?? plan.current?.startsOn ?? null, stepKey: read.row.anchorStepKey },
        endsOn: plan.current?.endsOn ?? null,
        planned: plan.tracking?.planned ?? 0,
        done: plan.tracking?.done ?? 0,
        skipped: plan.tracking?.skipped ?? 0,
        steps,
        // What run may spend before anyone presses Start: one capped drafting run per step still without text.
        advanceUpToCents: steps.filter((s) => !s.template && (s.type === "email" || s.type === "post")).length * RUN_CAP_CENTS,
        sent: read.sent,
        replied: read.replied,
        notes: read.row.notes,
        notesRevision: read.row.notesRevision,
        notesUpdatedBy: read.row.notesUpdatedBy,
        notesUpdatedAt: read.row.notesUpdatedAt?.toISOString() ?? null,
      };
    },

    /**
     * ADR 0023 rule 005: a Draft's creator, or someone who may delete any Draft, removes it for good with its
     * plan and versions. The database function refuses once anything else hangs on it. A version's approval
     * Item stays as history; one still waiting is dismissed, so nobody is asked to approve what is gone.
     */
    async deleteDraft(workspaceId: string, id: string, who: { userId: string; mayDeleteAny: boolean }) {
      const row = await inWorkspace(workspaceId, (tx) => readCampaign(tx, id));
      const plan = row && (await plans.plan(workspaceId, row.planId));
      if (!row || !plan) return { ok: false, reason: "not_found" } as const;
      if (!who.mayDeleteAny && plan.createdBy !== who.userId) return { ok: false, reason: "forbidden" } as const;
      const r = await deleteDraftRows(workspaceId, row.planId);
      if (r.ok && plan.waiting) await items().cancel(workspaceId, plan.waiting.id, { userId: who.userId });
      return r;
    },

    /**
     * A person's notes on the Campaign. A Draft takes them too: they create nothing that runs (ADR 0023,
     * revised 2026-11-14), so there is no approved-plan check here. Refused if someone saved since `revision`.
     */
    async setNotes(workspaceId: string, id: string, a: { notes: string; revision: number; userId: string }) {
      const notes = a.notes.trim();
      const r = await inWorkspace(workspaceId, async (tx) => {
        if (!(await readCampaign(tx, id))) return "not_found" as const;
        return (await setCampaignNotes(tx, { campaignId: id, notes, revision: a.revision, userId: a.userId, now: now() })) ? null : ("revision_moved" as const);
      });
      return r ? ({ ok: false, reason: r } as const) : ({ ok: true, revision: a.revision + 1 } as const);
    },

    /** What Direx did for this Campaign, newest first, at most `limit` lines. */
    async activity(workspaceId: string, id: string, limit = 20) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const row = await readCampaign(tx, id);
        return row && { row, ...(await activityRows(tx, id, limit)) };
      });
      if (!read) return undefined;
      const plan = await plans.plan(workspaceId, read.row.planId);
      const titles = new Map((plan?.current?.steps ?? []).map((s) => [s.key, s.title.replace(/\.$/, "")]));
      const undo = launchUndo(read.notices, LAUNCH_MOVED_KIND, read.row.anchorOn);
      const undoable = undo?.notice;
      return activityLines(
        [
          { kind: "created", at: read.row.createdAt },
          ...read.changes.map((c) => ({ kind: "actions" as const, ...c })),
          ...read.notices.map((n) => ({ kind: "notice" as const, title: n.title, at: n.at, ...(n === undoable && { undo: undo!.undo }) })),
          ...read.running.map((r) => ({ kind: "running" as const, ...r })),
        ],
        (k) => titles.get(k) ?? k,
        reasonLabel,
        limit,
      );
    },

    async setupStep(workspaceId: string, campaignId: string, stepKey: string, input: StepSetupInput) {
      const { mailboxCredentialIds, mailboxCredentialId, ...rest } = input;
      if (mailboxCredentialIds && mailboxCredentialId) return { ok: false, reason: "mailbox_twice" } as const;
      const ids = mailboxCredentialIds ?? (mailboxCredentialId ? [mailboxCredentialId] : []);
      let setup: StepSetup = { ...rest, mailboxCredentialId: ids[0] ?? null };
      const approved = await inWorkspace(workspaceId, (tx) => requireApproved(tx, campaignId));
      if (!approved.ok) return approved;
      const row = approved.campaign;
      const plan = await plans.plan(workspaceId, row.planId);
      if (!plan?.current?.steps.some((s) => s.key === stepKey)) return { ok: false, reason: "step_not_in_plan" } as const;
      // A post is not a Touch, nor is a clip posted from a clips step, nor an SEO brief; everything else is.
      if ((setup.type === "post" || setup.type === "clips" || setup.type === "seo_brief") !== (setup.touchClass === null)) return { ok: false, reason: "touch_class_mismatch" } as const;
      // A DM goes to one network and is sent by hand, cold, from no mailbox.
      const dmChannel = setup.type === "dm" ? (setup.dmChannel ?? null) : null;
      if (setup.type === "dm" && (!dmChannel || setup.touchClass !== "cold" || ids.length)) return { ok: false, reason: "dm_setup" } as const;
      setup = { ...setup, dmChannel };
      if (new Set(ids).size !== ids.length) return { ok: false, reason: "duplicate_mailbox" } as const;
      for (const mailbox of ids) {
        const refused = await inWorkspace(workspaceId, async (tx) => {
          if (!(await credentialLabel(tx, mailbox))) return "mailbox_not_found" as const;
          return (await isConnectedMailbox(tx, mailbox)) ? null : ("not_a_mailbox" as const);
        });
        if (refused) return { ok: false, reason: refused } as const;
        // A connection with no mailbox provider, such as a social account, can't send this step's email.
        if (!(await outreach().canSendFrom(workspaceId, mailbox))) return { ok: false, reason: "not_a_mailbox" } as const;
      }
      const planSteps = plan.current.steps;
      const saved = await inWorkspace(workspaceId, async (tx) => {
        const linkRefusal = await stepLinkRefusal(tx, { campaignId, stepKey, setup, planKeys: planSteps.map((s) => s.key) });
        if (linkRefusal) return { ok: false, reason: linkRefusal } as const;
        const at = now();
        if (setup.dependsOnStepKey) await ensureStep(tx, { workspaceId, campaignId, stepKey: setup.dependsOnStepKey, now: at });
        // Serialize settings saves before reading the mailbox order, including a step's first setup.
        await ensureStep(tx, { workspaceId, campaignId, stepKey, now: at });
        const step = await lockStep(tx, campaignId, stepKey);
        // Results have one kind per step. Keep that kind once work has actually been sent.
        if (step?.type !== setup.type) {
          const sentEmail = (await stepCounts(tx, campaignId)).some((c) => c.stepKey === stepKey && c.state === "sent" && c.n > 0);
          const sentPost = (await postCounts(tx, campaignId)).some((c) => c.stepKey === stepKey && c.state === "sent" && c.n > 0);
          const sentDm = (await resultCounts(tx, campaignId)).dms.some((c) => c.stepKey === stepKey && c.n > 0);
          if (sentEmail || sentPost || sentDm) return { ok: false, reason: "step_has_results" } as const;
        }
        // A Mailbox already on the step keeps its place, so the first of those stays the step's first Mailbox.
        const existing = await stepMailboxes(tx, campaignId, stepKey);
        // The legacy settings form only knows the primary. Resubmitting it keeps the full set;
        // an explicit list, a different primary, or clearing the mailbox still replaces it.
        const savedIds = mailboxCredentialIds === undefined && mailboxCredentialId === existing[0] && setup.type === "email" ? existing : ids;
        const primary = existing.find((m) => savedIds.includes(m)) ?? savedIds[0] ?? null;
        await saveStep(tx, { workspaceId, campaignId, stepKey, setup: { ...setup, mailboxCredentialId: primary }, now: at });
        await saveStepMailboxes(tx, { workspaceId, campaignId, stepKey, ids: savedIds, now: at });
        // A new email step gets a mode: the one its Campaign was answered with before modes moved to
        // steps, or the default for where it sits in the plan. A person changes it until it has a draft.
        const rows = await stepsOf(tx, campaignId);
        if (setup.type === "email" && !rows.find((r) => r.stepKey === stepKey)?.draftingMode) {
          const email = new Set(rows.filter((r) => r.type === "email").map((r) => r.stepKey));
          const mode = (row.draftingMode as StepMode | null) ?? defaultModes(planSteps.map((s) => ({ key: s.key, email: email.has(s.key) })), row.outsideContentAllowed)[stepKey]!;
          await setStepMode(tx, campaignId, stepKey, mode, at);
        }
        return { ok: true } as const;
      });
      if (!saved.ok) return saved;
      // A new email step starts with the text its plan wrote, checked as a person's edit would be. From
      // then on the step owns it, so a step that already has text, or a later plan version, changes nothing.
      const written = setup.type === "email" ? planSteps.find((s) => s.key === stepKey)?.template : undefined;
      if (written) await fillFromPlan({ facts, now }, workspaceId, campaignId, stepKey, written);
      await onSetupChanged?.(workspaceId, { campaignId }).catch((e) => console.error("campaigns: onSetupChanged failed", campaignId, e));
      return saved;
    },
  };
}
