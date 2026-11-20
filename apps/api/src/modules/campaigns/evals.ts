// SPDX-License-Identifier: AGPL-3.0-only
// The campaigns module's eval cases and scoring, for tests and scripts/eval-check.ts only. They stay
// beside the drafters and checks they score; index.ts carries only what the product runs.
export { HOSTILE_CASES, hostileCaseErrors, hostilePagesEval, PROMPT_MARKERS, STRATEGY_CANARY, tallyHostile, unsafeRun, type HostileCase, type HostileRun } from "./evals/hostile-pages";
export { CHECK_CASES, CHECK_FACTS, checkCaseErrors, scoreCheckCase, scoreCheckRun, tallyCheckRuns, type CheckCase, type CheckRun } from "./definitions/check-cases";
export { campaignEvalSuites } from "./definitions/eval-cases";
export { SKELETON_TEMPLATE, skeletonDrift, tallyDrift, type DriftRun } from "./evals/skeleton-drift";
export { COPY_CASES, copyFactId, scoreCopyRun, type CopyCase, type CopyOutput } from "./evals/drafted-copy";
export { writeUpProblem, type Brief, type WriteUpOutput } from "./domain/write-up";
