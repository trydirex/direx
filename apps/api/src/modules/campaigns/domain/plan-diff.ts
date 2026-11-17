// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a new plan version changes in a running Campaign. Steps match by key. The Campaign step
// owns its text, so new plan text is only a suggestion, and only text, channel and removed steps hold.
import { daysBetween } from "./anchor";

type Text = { subject: string; text: string };
type Step = { key: string; on: string; channelKey?: string | undefined; title: string; template?: Text | undefined };
type Plan = { goal: string; audience: string; measures: unknown; budget: unknown; assumptions: unknown; steps: Step[] };

export type StepChange =
  | { key: string; kind: "added" }
  | { key: string; kind: "removed" }
  | { key: string; kind: "changed"; redatedDays: number; retitled: boolean; channel: boolean; text: boolean };
export type PlanField = "goal" | "audience" | "measures" | "budget" | "assumptions";
export type PlanDiff = { steps: StepChange[]; plan: PlanField[] };
export type HoldKind = "text" | "channel" | "removed";

const PLAN_FIELDS: readonly PlanField[] = ["goal", "audience", "measures", "budget", "assumptions"];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sameText = (a: Text | undefined, b: Text | undefined) => a?.subject === b?.subject && a?.text === b?.text;

/**
 * The changes from `prev` to `next`. `ownedText` holds the text each Campaign step already has. Text
 * counts as changed only when the plan's own text changed and differs from the step's, so a person's
 * edit on the step is never re-suggested, and a step with no text yet just takes the plan's.
 */
export function diffPlans(prev: Plan, next: Plan, ownedText: ReadonlyMap<string, Text>): PlanDiff {
  const before = new Map(prev.steps.map((s) => [s.key, s]));
  const after = new Set(next.steps.map((s) => s.key));
  const steps: StepChange[] = [];
  for (const s of next.steps) {
    const old = before.get(s.key);
    if (!old) {
      steps.push({ key: s.key, kind: "added" });
      continue;
    }
    const owned = ownedText.get(s.key);
    const change = {
      key: s.key,
      kind: "changed" as const,
      redatedDays: daysBetween(old.on, s.on),
      retitled: old.title !== s.title,
      channel: (old.channelKey ?? null) !== (s.channelKey ?? null),
      text: owned !== undefined && s.template !== undefined && !sameText(old.template, s.template) && !sameText(owned, s.template),
    };
    if (change.redatedDays || change.retitled || change.channel || change.text) steps.push(change);
  }
  for (const s of prev.steps) if (!after.has(s.key)) steps.push({ key: s.key, kind: "removed" });
  return { steps, plan: PLAN_FIELDS.filter((f) => !same(prev[f], next[f])) };
}

/** Why a change holds its step's Items until a person chooses; none for anything else. */
export function holdKinds(c: StepChange): HoldKind[] {
  if (c.kind === "removed") return ["removed"];
  if (c.kind === "added") return [];
  return [...(c.text ? (["text"] as const) : []), ...(c.channel ? (["channel"] as const) : [])];
}
