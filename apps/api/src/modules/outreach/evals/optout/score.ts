// SPDX-License-Identifier: AGPL-3.0-only
// Replies labelled by hand-written intent, scored through the pipeline as shipped: rules first, then the
// model's reading, then a person. A real opt-out is missed only if it ends "not an opt-out"; sending it to
// a person counts as caught, because a person then decides.
import { readOptOut, type OptOutAnswer } from "../../domain/optout";
import { settleByRules } from "../../domain/reply-rules";

/**
 * out: an opt-out, with the words a good reader quotes. no: not one. unsure: a person should decide.
 * auto: an automatic reply, sent with Auto-Submitted.
 */
export type Reply = ["out", string, string] | ["no", string] | ["unsure", string] | ["auto", string];
export type ReplySet = { language: string; /** Who fluently reviewed these, by name. Null until someone has. */ reviewedBy: string | null; replies: Reply[] };
export type Outcome = "opted_out" | "not_opt_out" | "person";

const SUBJECT = "Re: A quick question";

/** The words the model would be shown, or null when a rule settles the reply first. */
export function forModel(r: Reply): string | null {
  const ruled = settleByRules({ text: r[1], subject: SUBJECT, autoSubmitted: r[0] === "auto" ? "auto-replied" : null });
  return ruled.status === "pending" ? ruled.words : null;
}

/** What the pipeline ends with for one reply, given the model's answer when it is asked. */
export function outcomeOf(r: Reply, answer: OptOutAnswer | null): Outcome {
  const ruled = settleByRules({ text: r[1], subject: SUBJECT, autoSubmitted: r[0] === "auto" ? "auto-replied" : null });
  if (ruled.status !== "pending") return ruled.status;
  return ({ opted_out: "opted_out", not_opt_out: "not_opt_out", person: "person" } as const)[readOptOut(answer, ruled.words).decided];
}

/** What a good reader answers, for the scripted run in CI. */
export const scriptedAnswer = (r: Reply): OptOutAnswer =>
  r[0] === "out" ? { answer: "opt_out", quote: r[2] } : r[0] === "unsure" ? { answer: "unsure", quote: null } : { answer: "not_opt_out", quote: null };

export function scoreSet(set: ReplySet, answers: readonly (OptOutAnswer | null)[]) {
  const outcomes = set.replies.map((r, i) => outcomeOf(r, answers[i] ?? null));
  const real = set.replies.map((r, i) => ({ r, o: outcomes[i]! })).filter((x) => x.r[0] === "out");
  const stopped = set.replies.map((r, i) => ({ r, o: outcomes[i]! })).filter((x) => x.o === "opted_out");
  const recall = real.length ? real.filter((x) => x.o !== "not_opt_out").length / real.length : 1;
  const precision = stopped.length ? stopped.filter((x) => x.r[0] === "out").length / stopped.length : 1;
  const misses = real.filter((x) => x.o === "not_opt_out").map((x) => x.r[1]);
  const wrongStops = stopped.filter((x) => x.r[0] !== "out").map((x) => x.r[1]);
  return { recall: Math.round(recall * 1000) / 1000, precision: Math.round(precision * 1000) / 1000, misses, wrongStops };
}

/**
 * eval:check's part: each set is the size the bar assumes, every quote is in its reply, and with a perfect
 * reader the pipeline still meets the bar. Rules can stop a near miss no model can overrule, so precision
 * is held to the bar, not to 1.
 */
export function replySetErrors(sets: readonly ReplySet[], minPrecision = 0.95): string[] {
  const errors: string[] = [];
  for (const set of sets) {
    if (set.replies.length !== 100) errors.push(`opt-outs ${set.language}: ${set.replies.length} replies, needs 100`);
    for (const r of set.replies) if (r[0] === "out" && !r[1].toLowerCase().includes(r[2].toLowerCase())) errors.push(`opt-outs ${set.language}: quote not in "${r[1].slice(0, 40)}"`);
    const s = scoreSet(set, set.replies.map(scriptedAnswer));
    if (s.recall < 1 || s.precision < minPrecision) errors.push(`opt-outs ${set.language}: scripted answers score recall ${s.recall}, precision ${s.precision}`);
  }
  return errors;
}
