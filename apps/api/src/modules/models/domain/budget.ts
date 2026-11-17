// SPDX-License-Identifier: AGPL-3.0-only
// Pure: which limit a call meets. "Spent" is always settled plus held; the caller reads it
// under the workspace lock.

export type Deployment = "cloud" | "self_host";

export const DEFAULT_BUDGET_MICROS: Record<Deployment, bigint> = { cloud: 15_000_000n, self_host: 50_000_000n };
export const SAFETY_DAILY_CALLS = 5_000;
const HARD_CEILING_MULTIPLE = 2n;

export type BudgetDecision = "normal" | "step_down" | "budget_stop";

export function budgetDecision(a: {
  deployment: Deployment;
  spentMicros: bigint;
  budgetMicros: bigint;
  reservationMicros: bigint;
  /** The step-down route's reservation; null when the purpose has none. */
  stepDownMicros: bigint | null;
}): BudgetDecision {
  if (a.spentMicros + a.reservationMicros <= a.budgetMicros) return "normal";
  if (a.deployment === "self_host" || a.stepDownMicros === null) return "budget_stop";
  return a.spentMicros + a.stepDownMicros <= a.budgetMicros * HARD_CEILING_MULTIPLE ? "step_down" : "budget_stop";
}

/** Safety purposes skip the budget, and meet only this limit and the run cap. */
export const safetyAllowed = (callsToday: number): boolean => callsToday < SAFETY_DAILY_CALLS;

export const withinRunCap = (a: { capMicros: bigint; spentOnRunMicros: bigint; reservationMicros: bigint }): boolean =>
  a.spentOnRunMicros + a.reservationMicros <= a.capMicros;

/** The incident thresholds settled spend crossed in this step. Holds never open one. */
export function thresholdsCrossed(beforeMicros: bigint, afterMicros: bigint, budgetMicros: bigint): (80 | 100)[] {
  return ([80, 100] as const).filter((t) => {
    const at = budgetMicros * BigInt(t);
    return beforeMicros * 100n < at && afterMicros * 100n >= at;
  });
}

/** Direx pays the bill on cloud, so an Admin there may only lower the budget. */
export const budgetChangeAllowed = (deployment: Deployment, nextMicros: bigint): boolean =>
  nextMicros > 0n && (deployment === "self_host" || nextMicros <= DEFAULT_BUDGET_MICROS.cloud);
