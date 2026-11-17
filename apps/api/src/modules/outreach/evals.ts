// SPDX-License-Identifier: AGPL-3.0-only
// The outreach module's opt-out and reply-label sets and their scoring, for tests and scripts/eval-check.ts only.
export { OPTOUT_SETS } from "./evals/optout/sets";
export { forModel, outcomeOf, replySetErrors, scoreSet, scriptedAnswer, type Outcome, type Reply, type ReplySet } from "./evals/optout/score";
export { labelSetErrors, REPLY_LABEL_SET } from "./evals/reply-label/score";
export { replyLabelEval } from "./application/reply-label";
