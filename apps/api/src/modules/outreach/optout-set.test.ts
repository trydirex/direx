// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { EN } from "./evals/optout/en";
import { outcomeOf, replySetErrors, scoreSet, scriptedAnswer, type ReplySet } from "./evals/optout/score";

const small: ReplySet = {
  language: "xx",
  reviewedBy: null,
  replies: [
    ["out", "Kindly leave us off your list going forward.", "leave us off your list"],
    ["no", "Can we talk on Friday?"],
    ["unsure", "Who gave you my address?"],
  ],
};

test("a real opt-out the model calls not an opt-out is a miss; sending it to a person isn't", () => {
  const none = { answer: "not_opt_out" as const, quote: null };
  expect(scoreSet(small, [none, none, null]).recall).toBe(0);
  expect(scoreSet(small, [null, none, null]).recall).toBe(1);
  expect(scoreSet(small, small.replies.map(scriptedAnswer))).toMatchObject({ recall: 1, precision: 1, misses: [], wrongStops: [] });
});

test("stopping someone who didn't ask lowers precision and is listed", () => {
  const stopTheQuestion = [scriptedAnswer(small.replies[0]!), { answer: "opt_out" as const, quote: "talk on Friday" }, null];
  expect(scoreSet(small, stopTheQuestion)).toMatchObject({ precision: 0.5, wrongStops: ["Can we talk on Friday?"] });
});

test("a rule settles before the model, and an automatic reply is never an opt-out", () => {
  expect(outcomeOf(["out", "Please unsubscribe me.", "unsubscribe me"], { answer: "not_opt_out", quote: null })).toBe("opted_out");
  expect(outcomeOf(["auto", "I'm out of the office. To stop these alerts, unsubscribe here."], { answer: "opt_out", quote: "unsubscribe" })).toBe("not_opt_out");
});

test("the English set is complete, its quotes are real, and a perfect reader meets the bar through the rules", () => {
  expect(replySetErrors([EN])).toEqual([]);
  expect(EN.reviewedBy).toContain("not a fluent person's");
  expect(replySetErrors([{ ...EN, replies: EN.replies.slice(1) }])).toEqual([expect.stringContaining("99 replies")]);
});
