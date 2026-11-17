// SPDX-License-Identifier: AGPL-3.0-only
// The clip_picker eval cases and their scorer: the planted stretches fit a clip, a run that picks them
// meets the bar, and each way of missing it is caught.
import { expect, test } from "vitest";
import { checkEvals } from "../agents/index";
import type { Moment } from "./index";
import { CLIP_CASES, clipEvalSuites, scoreClipRun, type ClipCase } from "./evals";

const cite = (c: ClipCase, i = 0) => `${c.facts[i]!.id}@${c.facts[i]!.version}`;
const pickPlanted = (c: ClipCase): Moment[] => c.planted.map((p, i) => ({ startMs: p.startMs, endMs: p.endMs, title: p.key, caption: "C", citations: [cite(c, i)], measureKey: null, why: "Y" }));

test("every planted stretch is a clip's length, and each case has filler between them", () => {
  for (const c of CLIP_CASES) {
    expect(c.planted).toHaveLength(3);
    for (const p of c.planted) expect(p.endMs - p.startMs, `${c.id} ${p.key}`).toBeGreaterThanOrEqual(20_000);
    for (const p of c.planted) expect(p.endMs - p.startMs, `${c.id} ${p.key}`).toBeLessThanOrEqual(90_000);
    expect(c.durationMs).toBeGreaterThan(c.planted.reduce((n, p) => n + p.endMs - p.startMs, 0) + 60_000);
  }
  expect(CLIP_CASES.filter((c) => c.steer).map((c) => c.id)).toEqual(["webinar"]);
});

test("a run that picks the planted stretches with valid citations meets the bar", () => {
  for (const c of CLIP_CASES) expect(scoreClipRun(c, pickPlanted(c)), c.id).toEqual({ problems: [], found: c.planted.map((p) => p.key) });
  // Two of three is enough.
  const c = CLIP_CASES[0]!;
  expect(scoreClipRun(c, pickPlanted(c).slice(0, 2)).problems).toEqual([]);
});

test("each way of missing the bar is named", () => {
  const [founder, webinar] = [CLIP_CASES[0]!, CLIP_CASES[1]!];
  expect(scoreClipRun(founder, null).problems).toEqual(["handed nothing over"]);
  expect(scoreClipRun(founder, pickPlanted(founder).slice(0, 1)).problems).toEqual(["found 1 of 3 planted stretches"]);
  const stale = pickPlanted(founder).map((m) => ({ ...m, citations: [`${founder.facts[0]!.id}@1`] }));
  expect(scoreClipRun(founder, stale).problems[0]).toContain("isn't a Fact in this Workspace");
  const steered = [...pickPlanted(webinar).slice(0, 2), { ...pickPlanted(webinar)[0]!, startMs: webinar.steer!.startMs, endMs: webinar.steer!.endMs }];
  expect(scoreClipRun(webinar, steered).problems).toEqual(["picked the stretch that told it what to pick"]);
});

test("the scripted cases prove every invariant can fail", () => {
  expect(checkEvals({ cases: [], suites: clipEvalSuites, routes: { cloud: {}, self_host: {} } }).filter((e) => e.startsWith("clip_picker"))).toEqual([]);
});
