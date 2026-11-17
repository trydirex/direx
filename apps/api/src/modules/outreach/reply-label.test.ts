// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { askReplyLabel, labelReply, REPLY_LABEL_PROMPT } from "./application/reply-label";
import type { Generate } from "./application/optout-model";
import { readLabel } from "./domain/reply-label";
import { labelSetErrors, REPLY_LABEL_SET, scoreLabels, scriptedLabel, type LabelSet } from "./evals/reply-label/score";

const reply = "Sounds good.  Can we TALK on Friday?";

test("a label counts only with the sender's own words, spacing and case aside", () => {
  expect(readLabel({ label: "interested", quote: "can we talk on friday" }, reply)).toEqual({ label: "interested", quote: "can we talk on friday" });
  expect(readLabel({ label: "interested", quote: "book a demo" }, reply)).toEqual({ label: "unlabelled" });
  expect(readLabel({ label: "no", quote: "  " }, reply)).toEqual({ label: "unlabelled" });
  expect(readLabel(null, reply)).toEqual({ label: "unlabelled" });
});

const answering = (output: unknown): Generate => (async () => ({ ok: true, output })) as unknown as Generate;

test("the model sees the reply as untrusted text with no tools, and a failure or made-up quote is unlabelled", async () => {
  const calls: unknown[] = [];
  const gen = (async (req: unknown) => {
    calls.push(req);
    return { ok: true, output: { label: "interested", quote: "Can we talk on Friday" } };
  }) as unknown as Generate;
  expect(await labelReply(gen, "w", "s1", reply)).toEqual({ label: "interested", quote: "Can we talk on Friday" });
  expect(calls[0]).toMatchObject({ purpose: "reply_label", idempotencyKey: "reply_label:s1", parts: [{ role: "system", kind: "definition", text: REPLY_LABEL_PROMPT }, { role: "user", kind: "reply_text", text: reply }] });
  expect(calls[0]).not.toHaveProperty("tools");

  expect(await labelReply(undefined, "w", "s1", reply)).toEqual({ label: "unlabelled" });
  expect(await labelReply(answering({ label: "no", quote: "please stop" }), "w", "s1", reply)).toEqual({ label: "unlabelled" });
  expect(await labelReply(answering("plain words"), "w", "s1", reply)).toEqual({ label: "unlabelled" });
  const refused = (async () => ({ ok: false, refusal: "no_route" })) as unknown as Generate;
  expect(await askReplyLabel(refused, "w", "s1", reply)).toEqual({ answer: null, failure: "no_route" });
  const failed = (async () => ({ ok: false, errorFamily: "provider_quota" })) as unknown as Generate;
  expect(await askReplyLabel(failed, "w", "s1", reply)).toEqual({ answer: null, failure: "provider_quota" });
});

const small: LabelSet = {
  source: "test",
  replies: [
    ["interested", "Let's talk Tuesday.", "Let's talk Tuesday"],
    ["interested", "Send a calendar link.", "Send a calendar link"],
    ["no", "We'll pass.", "We'll pass"],
  ],
};

test("a missed interested reply lowers recall and is listed; an unlabelled one counts as missed", () => {
  const answers = [scriptedLabel(small.replies[0]!), { label: "question" as const, quote: "Send a calendar link" }, null];
  expect(scoreLabels(small, answers)).toEqual({ interestedRecall: 0.5, accuracy: 0.333, missedHot: ["Send a calendar link."] });
  expect(scoreLabels(small, small.replies.map(scriptedLabel))).toEqual({ interestedRecall: 1, accuracy: 1, missedHot: [] });
});

test("the seed set's quotes are real, and a quote not in its reply is caught", () => {
  expect(labelSetErrors(REPLY_LABEL_SET)).toEqual([]);
  expect(labelSetErrors({ source: "t", replies: [["no", "We'll pass.", "not today"]] })).toEqual([expect.stringContaining("quote not in"), expect.stringContaining("scripted answers")]);
});
