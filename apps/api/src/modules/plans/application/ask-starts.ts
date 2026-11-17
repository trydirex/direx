// SPDX-License-Identifier: AGPL-3.0-only
// The Plan screen's two drafting buttons, as starts a person can ask for in Ask (ADR 0008 rule 028).
// Each start runs the button's own draftRuns call, and checks only this server's records.
import { z } from "zod";
import { askStart, type AskStart, type WorkReport } from "../../agents";
import type { Plans } from "./create";
import type { DraftRuns } from "./draft-runs";

type Deps = { plans: () => Pick<Plans, "strategyDraftInput" | "planDraftInput">; runs: DraftRuns; report: (workspaceId: string, runId: string) => Promise<WorkReport | null> };

const RUN = "agent_run";
const started = (r: { ok: true; run: { id: string } } | { ok: false; reason: string }) => (r.ok ? ({ ok: true, work: { kind: RUN, id: r.run.id } } as const) : ({ ok: false, why: r.reason } as const));

export function planAskStarts(d: Deps): AskStart[] {
  const report: AskStart["report"] = (workspaceId, work) => (work.kind === RUN ? d.report(workspaceId, work.id) : Promise.resolve(null));
  return [
    askStart({
      id: "draft_strategy",
      definition: "strategy_drafter",
      area: null,
      says: "Draft the Strategy. Args: request, what the person wants the Strategy to cover, in their words.",
      args: z.strictObject({ request: z.string().trim().min(1).max(1000) }),
      permission: "item.edit",
      async check(workspaceId) {
        const input = await d.plans().strategyDraftInput(workspaceId, "");
        return { ok: true, title: "Draft the Strategy", basis: `strategy_draft:${input.target.draftRevision}` };
      },
      start: async (workspaceId, a, by) => started(await d.runs.strategy(workspaceId, a.request, { startedBy: by.userId, key: by.key, tainted: by.tainted })),
      report,
    }),
    askStart({
      id: "draft_plan",
      definition: "plan_drafter",
      area: null,
      says: "Draft one marketing plan's text from its request and the current Strategy. Args: planId, from read_plans.",
      args: z.strictObject({ planId: z.uuid() }),
      permission: "item.edit",
      async check(workspaceId, a) {
        const asked = await d.plans().planDraftInput(workspaceId, a.planId);
        if (!asked.ok) return { ok: false, why: asked.reason };
        const strategy = asked.input.brief.find((b) => b.kind === "strategy");
        return { ok: true, title: `Draft the plan "${asked.title}"`, basis: `plan_draft:${asked.input.target.draftRevision}:strategy:${strategy?.version ?? ""}` };
      },
      start: async (workspaceId, a, by) => started(await d.runs.plan(workspaceId, a.planId, { startedBy: by.userId, key: by.key, tainted: by.tainted })),
      report,
    }),
  ];
}
