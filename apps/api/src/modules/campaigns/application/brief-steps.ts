// SPDX-License-Identifier: AGPL-3.0-only
// SEO brief steps: Make brief starts the seo module's brief agent on the step's page and search, and
// the step shows where that Brief stands. The seo module is reached through a port, never imported.
import type { Plans } from "../../plans";
import { inWorkspace, readCampaign, saveBriefRun, stepsOf, type StepRow } from "../adapters/repo";
import { checkBriefSetup, type BriefSetup } from "../domain/brief-steps";
import { syncedOutput } from "./step-links";

export type StepBriefState =
  | { state: "running" }
  | { state: "failed" | "no_brief"; reason: string }
  | { state: "waiting" | "approved" | "dismissed"; itemId: string };

/** What a Campaign asks of the module that writes Briefs. Absent on cloud, where Briefs have no model route yet. */
export type BriefPort = {
  start: (workspaceId: string, a: { page: string; query: string; step: { campaignId: string; stepKey: string; campaign: string; step: string }; userId: string }) => Promise<{ ok: true; run: { id: string } } | { ok: false; reason: string }>;
  get: (workspaceId: string, runId: string) => Promise<StepBriefState>;
};

export function briefSteps(deps: { plans: Plans; briefs?: (() => BriefPort | undefined) | undefined; now: () => Date }) {
  async function readStep(workspaceId: string, campaignId: string, stepKey: string) {
    const read = await inWorkspace(workspaceId, async (tx) => {
      const row = await readCampaign(tx, campaignId);
      return row && { row, step: (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey) };
    });
    if (!read) return { ok: false, reason: "not_found" } as const;
    const plan = await deps.plans.plan(workspaceId, read.row.planId);
    const planStep = plan?.current?.steps.find((s) => s.key === stepKey);
    if (!plan || !planStep) return { ok: false, reason: "step_not_in_plan" } as const;
    if (read.step?.type !== "seo_brief") return { ok: false, reason: "not_a_brief_step" } as const;
    return { ok: true, step: read.step, campaign: plan.title, title: planStep.title } as const;
  }

  const stateOf = async (workspaceId: string, step: StepRow) => (step.briefRunId ? ((await deps.briefs?.()?.get(workspaceId, step.briefRunId)) ?? null) : null);

  return {
    /** The step's page and search, and where its latest Brief stands. */
    async briefStep(workspaceId: string, campaignId: string, stepKey: string) {
      const r = await readStep(workspaceId, campaignId, stepKey);
      if (!r.ok) return r;
      return { ok: true, setup: (r.step.seoSetup as BriefSetup | null) ?? null, brief: await stateOf(workspaceId, r.step), available: deps.briefs?.() !== undefined } as const;
    },

    /**
     * Saves the page and search and starts a Brief on them, as the person who pressed it. Refused while
     * one is running, once one is approved, and while one waits on the same page and search.
     */
    async makeBrief(workspaceId: string, campaignId: string, stepKey: string, input: { page: string | null; query: string }, userId: string) {
      const port = deps.briefs?.();
      if (!port) return { ok: false, reason: "cloud_unavailable" } as const;
      const r = await readStep(workspaceId, campaignId, stepKey);
      if (!r.ok) return r;
      const checked = checkBriefSetup({ ...input, dependsOn: r.step.dependsOnStepKey });
      if (!checked.ok) return checked;
      const setup = checked.setup;
      let page = setup.page;
      if (r.step.dependsOnStepKey) {
        const dependsOn = r.step.dependsOnStepKey;
        const output = await inWorkspace(workspaceId, (tx) => syncedOutput(tx, { workspaceId, campaignId, stepKey: dependsOn, at: deps.now() }));
        if (!output) return { ok: false, reason: "waiting_on_step", waitingOn: dependsOn } as const;
        page = output.url;
      }
      const last = await stateOf(workspaceId, r.step);
      if (last?.state === "running") return { ok: false, reason: "brief_running" } as const;
      if (last?.state === "approved") return { ok: false, reason: "brief_approved" } as const;
      const before = r.step.seoSetup as BriefSetup | null;
      if (last?.state === "waiting" && before?.page === setup.page && before.query === setup.query) return { ok: false, reason: "brief_waiting" } as const;
      // ponytail: two presses in the same instant can both start a run; the later one wins the step. Lock the row if that shows up.
      const started = await port.start(workspaceId, { page: page!, query: setup.query, step: { campaignId, stepKey, campaign: r.campaign, step: r.title }, userId });
      if (!started.ok) return started;
      await inWorkspace(workspaceId, (tx) => saveBriefRun(tx, { campaignId, stepKey, setup, runId: started.run.id, now: deps.now() }));
      return { ok: true, runId: started.run.id } as const;
    },

    /** Whether the step's latest Brief is approved: until then it has no output to record. */
    async briefApproved(workspaceId: string, step: StepRow) {
      return (await stateOf(workspaceId, step))?.state === "approved";
    },
  };
}
