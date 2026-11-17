// SPDX-License-Identifier: AGPL-3.0-only
// Strategy and marketing plans: what a Workspace intends to do, and why, before anything is written
// or sent. planKinds is registered with items, so items never imports this module.
export { planKinds, type OnPlanApproved } from "./application/kinds";
export { createPlans, type Plans } from "./application/create";
export type { OnPlanCreated } from "./application/plans";
export { planSinks } from "./application/drafting";
export { PLAN_KIND } from "./application/submit";
export { planDefinitions, planDrafter, strategyDrafter } from "./definitions/drafters";
export { planRoutes } from "./routes";
export { draftRuns, type DraftRuns, type StartDraft } from "./application/draft-runs";
export { planAskStarts } from "./application/ask-starts";
export type { Basis, PlanBody, StrategyBody } from "./domain/types";
