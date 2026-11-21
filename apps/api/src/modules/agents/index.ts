// SPDX-License-Identifier: AGPL-3.0-only
// The agents module's only entry point. A run's output can only become typed proposals that a
// person sees as Items. Sinks are passed in, so this module writes no other module's tables.
export { factContext, factSink } from "./adapters/fact-sink";
export { createAgents, starterNotice, type Agents } from "./application/create";
export { createDrift, type Drift } from "./application/drift";
export { checkEvals, checkRouteResults, RESULTS_DIR, type EvalResult, type EvalSuite } from "./evals/check";
export { BRIEF_BAR, CHANGE_BAR, COMPARISON_BAR, MIN_RUNS, missesBar, POST_BAR, REPLY_LABEL_BAR, WHY_BAR } from "./evals/bars";
export { resultFileOf, safetyGate, shippedEvals, voiceCheckOpen, type RequiredEval } from "./evals/gate";
export type { ScriptedCase } from "./evals/brand_reader/cases";
export { defineAgent, type AgentDefinition } from "./definitions/define";
export { brandAskStarts } from "./application/brand-start";
export { AREAS, askStart, workState, type Area, type AskStart, type WorkRef, type WorkReport, type WorkState } from "./application/ask-start";
export { createFetchHtml, createFetchImage, createFetchJson, htmlToText, linksIn, PAGE_READER_AGENT, type FetchHtml, type FetchImage, type FetchJson, type JsonResult } from "./adapters/fetch-page";
export { createFetchSitemap, type FetchSitemap } from "./adapters/fetch-page";
export { allowed, robotsFrom } from "./domain/robots";
export { capped } from "./domain/snapshot";
export { sinkByOutputKey, type Producer, type Sink } from "./application/proposals";
export type { DraftInput } from "./application/runs";
export type { Transcript } from "./domain/invariants";
export { agentRoutes } from "./routes";
