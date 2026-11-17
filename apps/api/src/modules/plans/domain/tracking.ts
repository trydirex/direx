// SPDX-License-Identifier: AGPL-3.0-only
// Pure: planned versus done versus achieved, for the current version. Rows for a step or measure
// the version no longer has stay stored and simply don't show.
import type { PlanBody, StrategyBody } from "./types";

export type StepStatus = "open" | "done" | "skipped";
export type Progress = { stepKey: string; status: StepStatus; at: Date };
export type Reading = { measureKey: string; value: string; observedOn: string; source: "person" | "system"; note: string | null; actorUserId: string | null; at: Date };

/** The later row wins; rows with one timestamp keep the order they were given in. */
function newest<T extends { at: Date }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>((best, r) => (!best || r.at >= best.at ? r : best), undefined);
}

export function tracking(body: PlanBody, progress: Progress[], readings: Reading[]) {
  const steps = body.steps.map((s) => ({
    ...s,
    status: newest(progress.filter((p) => p.stepKey === s.key))?.status ?? ("open" as StepStatus),
  }));
  const measures = body.measures.map((m) => {
    const own = readings.filter((r) => r.measureKey === m.key);
    // The newest date observed, not the newest typed, and the later entry for one date.
    const latest = newest(own.filter((r) => r.observedOn === own.map((o) => o.observedOn).sort().at(-1)));
    return { ...m, latest: latest ?? null, readings: own };
  });
  return {
    planned: steps.length,
    done: steps.filter((s) => s.status === "done").length,
    skipped: steps.filter((s) => s.status === "skipped").length,
    steps,
    measures,
  };
}

/**
 * What a plan's row in a list shows: its dates, its first measure against its target, and the Strategy
 * channels its steps use, by label. A plan with no approved version shows none of it.
 */
export function listFields(body: PlanBody | null, readings: Reading[], channels: StrategyBody["channels"]) {
  if (!body) return { startsOn: null, endsOn: null, measure: null, channels: [] as string[] };
  const main = tracking(body, [], readings).measures[0];
  const keys = [...new Set(body.steps.flatMap((s) => (s.channelKey ? [s.channelKey] : [])))];
  return {
    startsOn: body.startsOn,
    endsOn: body.endsOn,
    measure: main ? { label: main.label, target: main.target, value: main.latest?.value ?? null } : null,
    channels: keys.map((k) => channels.find((c) => c.key === k)?.label ?? k),
  };
}
