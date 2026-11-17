// SPDX-License-Identifier: AGPL-3.0-only
// The competitors module's eval cases and scoring, for tests and scripts only.
export { CHANGE_CASES, CONTOSO_FACTS, missesChangeBar, scoreChangeRun, type ChangeCase, type ChangeScore } from "./definitions/eval-cases";
export { labelInput, labelsProblem, type LabelOut } from "./domain/labels";
export { COMPARISON_CASES, COMPARISON_FACTS, comparisonCaseInput, missesComparisonBar, scoreComparisonRun, type ComparisonBar, type ComparisonCase, type ComparisonScore } from "./definitions/comparison-eval-cases";
export type { ComparisonBrief } from "./domain/comparison-brief";
export { missesPostBar, POST_CASES, POST_FACTS, postCaseInput, scorePostRun, type PostBar, type PostCase, type PostScore } from "./definitions/post-eval-cases";
export type { CounterPost } from "./domain/post";
