// SPDX-License-Identifier: AGPL-3.0-only
// Importing People is the moment drafting costs runs, so the import screen says what the first email
// step will take before anything starts, and its confirm starts it. A Person who can't be drafted yet
// is counted under a reason and drafted by a later confirm, never twice.
import { memberEmail } from "../../identity";
import type { Items } from "../../items";
import type { Plans } from "../../plans";
import { activeActions, inWorkspace, peopleCount, perPersonSteps, readCampaign, stepStateCounts, stepsOf } from "../adapters/repo";
import { datedSteps, decideBy } from "../domain/anchor";
import { followUpStepsDue, stepProgress, waitingTitle, type StepMode, type WaitReason } from "../domain/timing";
import { WAITING_KIND } from "./coordination";
import type { makeDrafting } from "./make-drafts";
import type { personDrafting } from "./person-drafts";

type MakeDrafting = Pick<ReturnType<typeof makeDrafting>, "previewDrafts" | "makeDrafts">;
type PersonDrafting = Pick<ReturnType<typeof personDrafting>, "personPreview" | "writePerPerson">;

export function importDrafting(d: { plans: Plans; make: MakeDrafting; person: PersonDrafting; items: () => Pick<Items, "settleGroup">; now: () => Date }) {
  /** The first email step in plan order, which import drafts. Follow-ups are drafted nearer their date. */
  async function firstEmailStep(workspaceId: string, campaignId: string) {
    const read = await inWorkspace(workspaceId, async (tx) => {
      const campaign = await readCampaign(tx, campaignId);
      return campaign && { campaign, rows: await stepsOf(tx, campaignId) };
    });
    if (!read) return { ok: false, reason: "not_found" } as const;
    const plan = await d.plans.plan(workspaceId, read.campaign.planId);
    const byKey = new Map(read.rows.map((r) => [r.stepKey, r]));
    const step = plan?.current?.steps.map((s) => byKey.get(s.key)).find((r) => r?.type === "email");
    if (!step?.draftingMode) return { ok: false, reason: "no_email_step" } as const;
    return { ok: true, stepKey: step.stepKey, mode: step.draftingMode as StepMode } as const;
  }

  const api = {
    async previewDrafting(workspaceId: string, campaignId: string) {
      const s = await firstEmailStep(workspaceId, campaignId);
      if (!s.ok) return s;
      const step = { stepKey: s.stepKey, mode: s.mode };
      if (s.mode === "template") {
        const p = await d.make.previewDrafts(workspaceId, campaignId, s.stepKey);
        if (!p.ok) return p;
        return { ok: true, ...step, people: p.willMake, already: p.already, leftOut: p.leftOut, runs: 0, worstCaseCents: 0, days: 1 } as const;
      }
      const p = await d.person.personPreview(workspaceId, campaignId, s.stepKey);
      if (!p.ok) return p;
      return { ok: true, ...step, people: p.willWrite, already: p.already, leftOut: p.leftOut, runs: p.runs, worstCaseCents: p.worstCaseCents, days: p.days } as const;
    },

    /**
     * Per-Person follow-ups whose drafting lead has come, across Workspaces, for the daily job that
     * offers drafting them. Who still needs one is decided when the card is made, as for any step.
     */
    async followUpsDue(): Promise<{ workspaceId: string; campaignId: string; stepKey: string }[]> {
      const today = d.now().toISOString().slice(0, 10);
      const due: { workspaceId: string; campaignId: string; stepKey: string }[] = [];
      const byCampaign = new Map<string, { workspaceId: string; campaignId: string }>();
      for (const s of await perPersonSteps()) byCampaign.set(`${s.workspaceId}:${s.campaignId}`, s);
      for (const { workspaceId, campaignId } of byCampaign.values()) {
        const read = await inWorkspace(workspaceId, async (tx) => {
          const campaign = await readCampaign(tx, campaignId);
          return campaign && { campaign, rows: await stepsOf(tx, campaignId) };
        });
        if (!read) continue;
        const plan = await d.plans.plan(workspaceId, read.campaign.planId);
        if (!plan?.current || plan.archivedAt) continue;
        const rows = new Map(read.rows.map((r) => [r.stepKey, r]));
        const steps = datedSteps(plan.current, read.campaign.anchorOn).map((s) => ({ key: s.key, on: s.on, email: rows.get(s.key)?.type === "email", mode: (rows.get(s.key)?.draftingMode ?? null) as StepMode | null }));
        for (const s of followUpStepsDue(steps, today)) due.push({ workspaceId, campaignId, stepKey: s.key });
      }
      return due;
    },

    /** Each email step's drafting progress, in plan order, and every step's Items by state, for the Campaign page and the waiting-on Item. */
    async progress(workspaceId: string, campaignId: string) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const campaign = await readCampaign(tx, campaignId);
        return campaign && { campaign, rows: await stepsOf(tx, campaignId), people: await peopleCount(tx, campaignId), counts: await stepStateCounts(tx, campaignId) };
      });
      if (!read) return null;
      const plan = await d.plans.plan(workspaceId, read.campaign.planId);
      const planSteps = plan?.current ? datedSteps(plan.current, read.campaign.anchorOn) : [];
      const rows = new Map(read.rows.map((r) => [r.stepKey, r]));
      const today = d.now().toISOString().slice(0, 10);
      const steps = [];
      for (const planned of planSteps) {
        const row = rows.get(planned.key);
        if (row?.type !== "email" || !row.draftingMode) continue;
        const mode = row.draftingMode as StepMode;
        const p = mode === "template" ? await d.make.previewDrafts(workspaceId, campaignId, planned.key) : await d.person.personPreview(workspaceId, campaignId, planned.key);
        const base = { stepKey: planned.key, title: planned.title, mode, on: planned.on };
        if (p.ok) {
          const toWrite = "willMake" in p ? p.willMake : p.willWrite;
          const days = "days" in p ? p.days : 1;
          steps.push({ ...base, ...stepProgress({ written: p.already, toWrite, days, today, people: read.people, notEligible: p.leftOut.filter((x) => x.leftOut.reason === "not_eligible").length, blocked: null }) });
          continue;
        }
        const written = (await inWorkspace(workspaceId, (tx) => activeActions(tx, campaignId, planned.key))).length;
        const waitsOn = planSteps.find((s) => s.key === row.dependsOnStepKey)?.title ?? row.dependsOnStepKey ?? "another step";
        const blocked: WaitReason | null = p.reason === "mailbox_required" ? { kind: "no_mailbox" } : p.reason === "no_template" ? { kind: "no_text" } : p.reason === "waiting_on_step" ? { kind: "step_output", label: waitsOn } : null;
        steps.push({ ...base, ...stepProgress({ written, toWrite: 0, days: 1, today, people: read.people, notEligible: 0, blocked }), refused: blocked ? null : p.reason });
      }
      return { ownerUserId: read.campaign.ownerUserId, timeZone: read.campaign.advanceTimeZone ?? "UTC", steps, counts: read.counts };
    },

    /**
     * The one waiting-on Item for a Campaign, Workspace-wide and naming its owner: made or replaced when
     * what a person can fix changes, closed when nothing is left. A Person waiting on two steps for the
     * same reason counts once.
     */
    async refreshWaiting(workspaceId: string, campaignId: string) {
      const p = await api.progress(workspaceId, campaignId);
      if (!p) return;
      const counts = new Map<string, WaitReason[]>();
      for (const s of p.steps) {
        const byLabel = new Map<string, WaitReason[]>();
        for (const r of s.reasons) {
          const label = r.kind === "step_output" ? r.label : r.kind;
          byLabel.set(label, [...(byLabel.get(label) ?? []), r]);
        }
        for (const [label, rs] of byLabel) if (rs.length > (counts.get(label)?.length ?? 0)) counts.set(label, rs);
      }
      const owner = (await memberEmail(workspaceId, p.ownerUserId)) ?? "Someone";
      const title = waitingTitle(owner, [...counts.values()].flat());
      // Due by the first step still waiting, a working day before it goes, so Needs you sorts it with what it holds up.
      const first = p.steps.filter((s) => s.reasons.some((r) => r.kind !== "daily_cap")).map((s) => s.on).sort()[0];
      const due = first ? decideBy({ firstSlot: new Date(`${first}T09:00:00Z`), draftingDays: 0, timeZone: p.timeZone }) : undefined;
      await d.items().settleGroup(workspaceId, {
        kind: WAITING_KIND,
        groupKey: `${WAITING_KIND}:${campaignId}`,
        actor: { system: "campaigns" },
        next: title ? { payload: { campaignId }, details: { title, workArea: "outreach", warnings: [] }, ...(due && { decideBy: due }) } : null,
      });
    },

    async confirmDrafting(workspaceId: string, campaignId: string, a: { timeZone: string; userId: string }) {
      const s = await firstEmailStep(workspaceId, campaignId);
      if (!s.ok) return s;
      if (s.mode === "template") {
        const r = await d.make.makeDrafts(workspaceId, campaignId, s.stepKey, a);
        if (!r.ok) return r;
        return { ok: true, stepKey: s.stepKey, mode: s.mode, made: r.results.filter((x) => x.ok && !x.already).length, started: 0 } as const;
      }
      const r = await d.person.writePerPerson(workspaceId, campaignId, s.stepKey, a);
      if (!r.ok) return r;
      return { ok: true, stepKey: s.stepKey, mode: s.mode, made: 0, started: r.started } as const;
    },
  };
  return api;
}
