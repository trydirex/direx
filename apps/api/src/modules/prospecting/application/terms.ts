// SPDX-License-Identifier: AGPL-3.0-only
// Search terms from the Strategy. A person asks, one terms_drafter run reads the Strategy's audience, and
// its terms wait for that person to edit them. Only terms that hold no Person data are kept.
import type { Sink } from "../../agents/index";
import { inWorkspace } from "../adapters/repo";
import { knownNames, readTerms, saveTerms } from "../adapters/terms-repo";
import { termsDrafter, type TermsOutput } from "../definitions/terms-drafter";
import { keptTerms, termsText, type StrategyAudience } from "../domain/terms";

/** The Workspace's approved Strategy, read through plans, which prospecting doesn't import. */
export type ReadStrategy = (workspaceId: string) => Promise<{ current: StrategyAudience | null }>;
/** Starts a run through the agents module, which admits it under its caps. A refusal names why. */
export type StartTerms = (workspaceId: string, a: { agent: string; input: { text: string }; startedBy: string; key?: string; tainted?: boolean }) => Promise<{ ok: true; run: { id: string } } | { ok: false; reason: string }>;

export function createTerms(d: { strategy: ReadStrategy; start: StartTerms }) {
  return {
    /** The Strategy's words go in as data, since a draft of them may have come from pages Direx read. */
    /** `ask` carries an accepted Ask start's key and taint. */
    async draft(workspaceId: string, startedBy: string, ask?: { key: string; tainted: boolean }): Promise<{ ok: true; runId: string } | { ok: false; reason: string }> {
      const { current } = await d.strategy(workspaceId);
      if (!current?.whoFor.trim()) return { ok: false, reason: "no_strategy" };
      const started = await d.start(workspaceId, { agent: termsDrafter.id, input: { text: termsText(current) }, startedBy, ...ask });
      return started.ok ? { ok: true, runId: started.run.id } : started;
    },

    async latest(workspaceId: string) {
      const t = await inWorkspace(workspaceId, readTerms);
      return t && { ...t, proposedAt: t.proposedAt.toISOString() };
    },
  };
}
export type Terms = ReturnType<typeof createTerms>;

/** Where a terms run's output lands. Safe to call twice: the second call writes the same terms again. */
export function termsSink(now: () => Date): Sink {
  return (workspaceId, proposal, context) =>
    inWorkspace(workspaceId, async (tx) => {
      const kept = keptTerms(proposal.body as TermsOutput, await knownNames(tx));
      await saveTerms(tx, workspaceId, { runId: context.runId, ...kept, proposedAt: now() });
      return { ok: true, itemId: null };
    });
}
