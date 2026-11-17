// SPDX-License-Identifier: AGPL-3.0-only
// Next steps: after a plan approval or a saved template, the work that can start next waits in Needs
// you, and accepting it starts that work as the person who accepts. Nothing here starts on its own.
// items, campaigns and plans don't import this module; the composition root hands its hooks to them.
import type { PgBoss } from "pg-boss";
import { workStarts } from "./adapters/queue";
import { nextStepKinds, type KindDeps } from "./application/kinds";
import { nextStepMaker, type MakeDeps } from "./application/make";
import { nextStepStarter, type StartDeps } from "./application/start";

export { NEXT_STEP_KIND } from "./domain/chain";
export type { Offered } from "./application/make";

export function createNextSteps(d: MakeDeps & Omit<KindDeps, "campaigns"> & { campaigns: MakeDeps["campaigns"] & KindDeps["campaigns"] & StartDeps["campaigns"]; items: MakeDeps["items"] & StartDeps["items"] }) {
  const maker = nextStepMaker(d);
  const start = nextStepStarter({ items: d.items, campaigns: d.campaigns, maker });
  return {
    kinds: () => nextStepKinds(d),
    onApplied: maker.onApplied,
    onSetupChanged: maker.onSetupChanged,
    onTemplateSaved: maker.onTemplateSaved,
    offerFollowUps: maker.offerFollowUps,
    offerFollowUp: maker.offerFollowUp,
    offerAsked: maker.offerAsked,
    work: (boss: PgBoss) => workStarts(boss, start),
  };
}
export type NextSteps = ReturnType<typeof createNextSteps>;
