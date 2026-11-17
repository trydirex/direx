// SPDX-License-Identifier: AGPL-3.0-only
// Standing rules: a person's bounded, expiring permission to approve one template step's emails.
// items and models don't import this module; the composition root hands them its callbacks.
export { ruleStillCovers, suspendOnProviderLimit, suspendOnStale } from "./application/check";
export type { CampaignPort } from "./application/port";
export { OFFER_KIND, standingRuleKinds } from "./application/offer";
export { createStandingRules, suspendAgentRulesFor, suspendForAgent, type StandingRules } from "./application/rules";
export { MIN_UNEDITED_APPROVALS, type AgentGate } from "./application/agent-written";
export { AGENT_WRITTEN_WORDING } from "./domain/wording";
export { standingRuleRoutes } from "./routes";
