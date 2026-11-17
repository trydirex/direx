// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, vi } from "vitest";
import { collectLabels, evalSettings, progressFileOf } from "./evals/reply-label/run";
import type { ReplyLabel } from "./domain/reply-label";
import type { LabelSet } from "./evals/reply-label/score";

const set: LabelSet = { source: "test", replies: [["interested", "Private reply: let's talk", "let's talk"], ["no", "Private refusal: no thanks", "no thanks"]] };

test("repetitions resume by run and reply, persist only validated outcomes, and report no reply words", async () => {
  const done: Record<string, ReplyLabel | null> = {};
  const save = vi.fn();
  const report = vi.fn();
  const ask = vi.fn()
    .mockResolvedValueOnce({ answer: { label: "interested", quote: "invented" }, failure: null })
    .mockResolvedValueOnce({ answer: { label: "no", quote: "no thanks" }, failure: null })
    .mockResolvedValueOnce({ answer: null, failure: "provider_quota" });
  await expect(collectLabels({ set, runs: 2, done, ask, save, report })).rejects.toThrow("usage limit");
  expect(done).toEqual({ "0:0": null, "0:1": "no" });
  const resumed = vi.fn(async (words: string) => ({ answer: { label: (words.includes("refusal") ? "no" : "interested") as ReplyLabel, quote: words }, failure: null }));
  const result = await collectLabels({ set, runs: 2, done, ask: resumed, save, report });
  expect(resumed).toHaveBeenCalledTimes(2);
  expect(result).toMatchObject({ count: 4, score: { accuracy: 0.75, interestedRecall: 0.5 } });
  expect(done).toEqual({ "0:0": null, "0:1": "no", "1:0": "interested", "1:1": "no" });
  expect(JSON.stringify(save.mock.calls)).not.toContain("Private");
  expect(report.mock.calls).toEqual([["missed interested reply 1, run 1 (got no answer)"], ["missed interested reply 1, run 1 (got no answer)"]]);
});

test("settings honor overrides and checkpoints change with prompt, replies, ordering and run count", () => {
  expect(evalSettings("default", {})).toEqual({ model: "default", runs: 5 });
  expect(evalSettings("default", { DIREX_EVAL_MODEL: "other", DIREX_EVAL_RUNS: "2" })).toEqual({ model: "other", runs: 2 });
  for (const runs of ["0", "-1", "1.5", "NaN"]) expect(() => evalSettings("default", { DIREX_EVAL_RUNS: runs })).toThrow("positive integer");
  const file = progressFileOf("result", "prompt", set, 2);
  expect(progressFileOf("result", "prompt", structuredClone(set), 2)).toBe(file);
  expect(progressFileOf("result", "changed", set, 2)).not.toBe(file);
  expect(progressFileOf("result", "prompt", { ...set, replies: [...set.replies].reverse() }, 2)).not.toBe(file);
  expect(progressFileOf("result", "prompt", { ...set, replies: [set.replies[0]!] }, 2)).not.toBe(file);
  expect(progressFileOf("result", "prompt", set, 3)).not.toBe(file);
});
