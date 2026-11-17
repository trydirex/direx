// SPDX-License-Identifier: AGPL-3.0-only
// Starts what an accepted Next step names, as the person who accepted it, through the same campaigns
// calls the Campaign page's buttons use. Starting twice is safe: a step with text is skipped, a run
// already going is reused by agents, and drafts are made once per Person.
import type { Campaigns } from "../../campaigns";
import { warn, type Items } from "../../items";
import type { StartJob } from "../adapters/queue";
import type { NextStep } from "../domain/chain";
import { ADVANCE, type NextStepMaker } from "./make";
import { NextStepPayload } from "./payload";

export type StartDeps = {
  items: () => Pick<Items, "detail">;
  campaigns: () => Pick<Campaigns, "campaign" | "startDraft" | "makeDrafts" | "writePerPerson">;
  maker: Pick<NextStepMaker, "offerTemplates" | "offerDrafts" | "offerFollowUp">;
};

// Refusals that mean the work is already there, not that it failed.
const DONE = new Set(["drafts_already_made"]);

export function nextStepStarter(d: StartDeps) {
  /** Null when everything started, otherwise why something didn't. */
  async function work(job: StartJob, s: NextStep, trigger: "advance" | undefined): Promise<string | null> {
    if (s.link === "due_to_drafts") {
      const r = await d.campaigns().writePerPerson(job.workspaceId, s.campaignId, s.stepKey, { timeZone: job.timeZone!, userId: job.userId });
      return r.ok ? null : r.reason;
    }
    if (s.link === "template_to_drafts") {
      const r = await d.campaigns().makeDrafts(job.workspaceId, s.campaignId, s.stepKey, { timeZone: job.timeZone!, userId: job.userId });
      return r.ok ? null : r.reason;
    }
    const c = await d.campaigns().campaign(job.workspaceId, s.campaignId);
    if (!c) return "not_found";
    const reasons = new Set<string>();
    for (const key of s.stepKeys) {
      if (c.steps.find((x) => x.key === key)?.template) continue;
      const r = await d.campaigns().startDraft(job.workspaceId, s.campaignId, key, job.userId, trigger);
      if (!r.ok && !DONE.has(r.reason)) reasons.add(r.reason);
    }
    return reasons.size ? [...reasons].join(", ") : null;
  }

  // ponytail: if nothing can be offered again (the step stopped being ready), the reason is only logged; show it on the Applied card if that happens in the pilot.
  async function offerAgain(workspaceId: string, s: NextStep, reason: string) {
    console.error("next steps: could not start", s, reason);
    const warnings = [warn("unspecified", `Couldn't start last time: ${reason}`)];
    if (s.link === "plan_to_templates") await d.maker.offerTemplates(workspaceId, s.campaignId, warnings);
    else if (s.link === "due_to_drafts") await d.maker.offerFollowUp(workspaceId, s.campaignId, s.stepKey, warnings);
    else await d.maker.offerDrafts(workspaceId, s.campaignId, s.stepKey, s.templateRevision, warnings);
  }

  return async function start(job: StartJob, lastTry: boolean): Promise<void> {
    const seen = await d.items().detail(job.workspaceId, job.itemId);
    if (seen?.item.state !== "applied") return;
    const s = NextStepPayload.parse(seen.content);
    // The card's history says whether a Campaign set to run started it, so the run records that too.
    const trigger = seen.timeline.some((e) => e.to === "applied" && e.actor.kind === "system" && e.actor.id === ADVANCE) ? "advance" : undefined;
    let refused: string | null;
    try {
      refused = await work(job, s, trigger);
    } catch (e) {
      if (!lastTry) throw e;
      refused = e instanceof Error ? e.message : String(e);
    }
    if (refused) await offerAgain(job.workspaceId, s, refused);
  };
}
