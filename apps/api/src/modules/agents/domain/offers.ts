// SPDX-License-Identifier: AGPL-3.0-only
// What a draft that lost to a person's save was for, so it can be offered on that page.

export type OfferTarget = { targetKind: "strategy" | "plan" | "step"; targetId: string | null; targetStepKey: string | null };

type Target = { id?: string | null; stepKey?: string };

/** The page a refused draft belongs to, or null for a proposal that is never offered. */
export function offerTarget(kind: string, input: unknown): OfferTarget | null {
  const target = (input as { target?: Target } | null)?.target;
  if (!target) return null;
  // One Strategy per Workspace, so it needs no id.
  if (kind === "strategy_proposal") return { targetKind: "strategy", targetId: null, targetStepKey: null };
  if (kind === "plan_proposal" && target.id) return { targetKind: "plan", targetId: target.id, targetStepKey: null };
  if (kind === "draft" && target.id && target.stepKey) return { targetKind: "step", targetId: target.id, targetStepKey: target.stepKey };
  return null;
}
