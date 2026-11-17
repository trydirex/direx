// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a version cites, what its words are, and when it may become current.
import type { Basis, PlanBody, StrategyBody } from "./types";

export type Citation = { factId: string; version: number };

const cited = (bases: Basis[]): Citation[] =>
  bases.flatMap((b) => (b.kind === "fact" ? [{ factId: b.factId, version: b.version }] : []));

export const strategyCitations = (b: StrategyBody): Citation[] => cited(b.channels.map((c) => c.basis));
export const planCitations = (b: PlanBody): Citation[] => cited(b.measures.map((m) => m.basis));

/** All the words a person would read, for the banned-claims check. */
export const strategyText = (b: StrategyBody): string =>
  [b.whoFor, b.positioning, ...b.personas.flatMap((p) => [p.name, p.notes ?? ""]), ...b.channels.flatMap((c) => [c.label, c.reason]), ...b.assumptions.map((a) => a.text)].join("\n");
export const planText = (b: PlanBody): string =>
  [b.goal, b.audience, ...b.steps.map((s) => s.title), ...b.measures.flatMap((m) => [m.label, m.target]), ...b.budget.map((l) => l.label), ...b.assumptions.map((a) => a.text)].join("\n");

/** Steps on a channel the Strategy doesn't have. A warning, not a refusal. */
export const stepsOffStrategy = (plan: PlanBody, strategy: StrategyBody): string[] => {
  const known = new Set(strategy.channels.map((c) => c.key));
  return plan.steps.filter((s) => s.channelKey !== undefined && !known.has(s.channelKey)).map((s) => s.key);
};

/** A version may become current only if nothing else did since it was written. */
export function applyVersion(version: { baseVersion: number | null }, current: number | null): { ok: true } | { ok: false; reason: "target_changed" } {
  return version.baseVersion === current ? { ok: true } : { ok: false, reason: "target_changed" };
}
