// SPDX-License-Identifier: AGPL-3.0-only
// Starting a Strategy or plan drafting run: the one path the Plan screen's buttons and Ask's starts
// both take, so asking in Ask starts exactly what the button would (ADR 0008 rule 028).
import type { DraftInput } from "../../agents";
import type { Plans } from "./create";

/** Starts a drafting run. Passed in, so this module doesn't reach for the running agents itself. */
export type StartDraft = (workspaceId: string, a: { agent: string; input: DraftInput; startedBy: string; key?: string; tainted?: boolean }) => Promise<{ ok: true; run: { id: string } } | { ok: false; reason: string }>;
/** Who starts it; `key` and `tainted` come from an accepted Ask start. */
export type DraftBy = { startedBy: string; key?: string; tainted?: boolean };

export function draftRuns({ plans, startDraft }: { plans: () => Pick<Plans, "strategyDraftInput" | "planDraftInput">; startDraft: StartDraft }) {
  return {
    async strategy(workspaceId: string, request: string, by: DraftBy) {
      const input = await plans().strategyDraftInput(workspaceId, request);
      return startDraft(workspaceId, { agent: "strategy_drafter", input, ...by });
    },
    async plan(workspaceId: string, planId: string, by: DraftBy) {
      const asked = await plans().planDraftInput(workspaceId, planId);
      if (!asked.ok) return asked;
      return startDraft(workspaceId, { agent: "plan_drafter", input: asked.input, ...by });
    },
  };
}
export type DraftRuns = ReturnType<typeof draftRuns>;
