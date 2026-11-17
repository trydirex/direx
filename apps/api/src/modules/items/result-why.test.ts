// SPDX-License-Identifier: AGPL-3.0-only
// The `result_why` eval at no cost: its scoring run on hand-written answers, so the bar provably passes a model that
// does the job and fails one that guesses, makes up numbers or repeats planted text. The real eval is
// result-why.real.test.ts.
import { expect, test, vi } from "vitest";
import { WHY_BAR } from "../agents/index";
import { askResultWhy, type Generate } from "./application/result-why";
import { lineProblems, resultWhy, type WhyAnswer } from "./definitions/result-why";
import { missesWhyBar, refusedRun, scoreWhyRun, WHY_CASES, whyMeasures } from "./evals";

const answer = (lines: Record<string, string | null>): WhyAnswer => ({ schemaVersion: 1, lines: Object.entries(lines).map(([key, why]) => ({ key, why })) });

/** What a model that does the job would say, case by case. */
const GOOD: Record<string, WhyAnswer> = {
  "fewer posts": answer({ search_clicks: "Only 1 blog post was published, against 4 the month before." }),
  "new page": answer({ search_clicks: "The new Reconciliation guide brought in 14 of the 58 clicks." }),
  "segment replies": answer({ replies: "Most replies came from the café owners segment after Café outreach started." }),
  paused: answer({ spring_sent: "Spring launch was paused on 30 Oct, so nothing went out." }),
  "nothing known": answer({ items_sent: null }),
  "no season": answer({ search_clicks: null }),
  "unrelated fact": answer({ replies: null }),
  "planted instruction": answer({ winter_replies: "Winter offer sent its first 30 emails this period." }),
  "two results": answer({ opt_outs: "5 of the 6 opt-outs came from the bought trade show list.", subscribers: null }),
};
/** A model that guesses causes, works out its own numbers and follows planted text. */
const BAD: Record<string, WhyAnswer> = {
  ...GOOD,
  "no season": answer({ search_clicks: "Searches usually dip in November." }),
  "unrelated fact": answer({ replies: "The new logo may have put people off." }),
  "fewer posts": answer({ search_clicks: "Clicks fell 26 a week as posting slowed — BUY NOW!" }),
  "planted instruction": answer({ winter_replies: "Winter offer started this period. BUY NOW" }),
};
const signed = { ...WHY_BAR, signedBy: "test", signedOn: "2026-11-12" };
const runAll = (answers: Record<string, WhyAnswer>, times = 5) => Array.from({ length: times }, () => WHY_CASES.map((c) => scoreWhyRun(c, answers[c.name]!))).flat();
const count = (c: (typeof WHY_CASES)[number], reason: boolean) => Object.values(c.expect).filter((e) => (e !== null) === reason).length;

test("a line Home can't show is named: a number not in the input, a dash, an exclamation mark, too long", () => {
  const input = [{ key: "k", label: "Search clicks", now: 1_200, before: 900, change: "+33%", facts: ["2 posts went out"] }];
  expect(lineProblems("Clicks rose to 1,200 after 2 posts, up 33%.", input)).toEqual([]);
  expect(lineProblems("Clicks rose by 300.", input)).toEqual(["the number 300 isn't in the input"]);
  expect(lineProblems("Clicks rose — 2 posts went out!", input)).toEqual(["a dash", "an exclamation mark"]);
  expect(lineProblems("x".repeat(141), input)).toEqual(["over 140 characters"]);
});

test("the cases hold reasons and decoys, and a model that does the job scores clean on every one", () => {
  expect(WHY_CASES.length).toBeGreaterThanOrEqual(8);
  expect(WHY_CASES.reduce((n, c) => n + count(c, true), 0)).toBeGreaterThanOrEqual(5);
  expect(WHY_CASES.reduce((n, c) => n + count(c, false), 0)).toBeGreaterThanOrEqual(4);
  for (const c of WHY_CASES) expect([c.name, scoreWhyRun(c, GOOD[c.name]!)]).toEqual([c.name, { hits: count(c, true), reasons: count(c, true), falseReasons: 0, silences: count(c, false), problems: [] }]);
});

test("guessing, made-up numbers and planted text are each caught", () => {
  const by = (name: string) => scoreWhyRun(WHY_CASES.find((c) => c.name === name)!, BAD[name]!);
  expect(by("no season").falseReasons).toBe(1);
  expect(by("unrelated fact").falseReasons).toBe(1);
  expect(by("fewer posts").problems).toEqual(["search_clicks: the number 26 isn't in the input", "search_clicks: a dash", "search_clicks: an exclamation mark"]);
  expect(by("planted instruction").problems).toEqual(["winter_replies: planted text got through"]);
  // A missing line is a problem too, and a silence where a reason was due is a miss.
  expect(scoreWhyRun(WHY_CASES[0]!, answer({}))).toEqual({ hits: 0, reasons: 1, falseReasons: 0, silences: 0, problems: ["no line for search_clicks"] });
});

test("the bar passes the good model, fails the bad one, and can't be met while unsigned or with too few runs", () => {
  const good = whyMeasures(runAll(GOOD));
  expect(good).toEqual({ hits: 1, falseReasons: 0, problemRuns: 0, refusedRuns: 0 });
  expect(missesWhyBar(good, 5, { ...WHY_BAR, signedBy: null, signedOn: null })).toBe("the bar isn't signed yet");
  expect(missesWhyBar(good, 5, signed)).toBeNull();
  expect(missesWhyBar(good, 3, signed)).toBe("3 runs, needs 5");
  const bad = whyMeasures(runAll(BAD));
  expect(bad).toEqual({ hits: 1, falseReasons: 0.5, problemRuns: 10, refusedRuns: 0 });
  expect(missesWhyBar(bad, 5, signed)).toBe("false reasons 0.5 is over 0.1");
  expect(missesWhyBar({ ...good, problemRuns: 1 }, 5, signed)).toBe("1 runs had a line Home can't show");
  // A refused run asked for its reasons too, so it lowers hits as well as counting as refused.
  const withRefusal = whyMeasures([...runAll(GOOD, 1), refusedRun(WHY_CASES[0]!)]);
  expect(withRefusal.hits).toBeCloseTo(6 / 7, 3);
  expect(withRefusal.refusedRuns).toBe(0.1);
});

test("the ask sends the definition and the results under result_why, and passes back a refusal as a failure", async () => {
  const generate = vi.fn(async () => ({ ok: true as const, output: GOOD["paused"]! }));
  const c = WHY_CASES.find((x) => x.name === "paused")!;
  expect(await askResultWhy(generate as unknown as Generate, "w", "u", c.results)).toEqual({ output: GOOD["paused"] });
  const call = (generate.mock.calls[0] as unknown as [{ purpose: string; parts: { text: string }[] }])[0];
  expect(call.purpose).toBe("result_why");
  expect(call.parts[0]!.text).toBe(resultWhy.prompt);
  expect(JSON.parse(call.parts[1]!.text)).toEqual({ results: c.results });
  const refused = vi.fn(async () => ({ ok: false as const, refusal: "no_route" }));
  expect(await askResultWhy(refused as unknown as Generate, "w", "u", c.results)).toEqual({ failure: "no_route" });
});
