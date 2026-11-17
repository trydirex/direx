// SPDX-License-Identifier: AGPL-3.0-only
// Campaigns: an approved plan becomes work a person can approve. plans and agents don't import this
// module; the composition root hands campaignOnPlanApproved to planKinds and campaignOnPlanCreated to createPlans.
export { campaignOnPlanApproved, campaignOnPlanCreated } from "./application/plan-change";
export { decideBy } from "./domain/anchor";
export { campaignCheck, campaignKinds, campaignOutsideReplies, campaignReplies, CONFLICT_KIND } from "./application/coordination";
export { createCampaigns, type Campaigns } from "./application/create";
export type { PostPort, StartDraft } from "./application/drafting";
export { campaignSinks } from "./application/sinks";
export { checksPassed } from "./application/draft-checks";
export { agentWrittenEvals, agentWrittenGate } from "./application/agent-gate";
export type { CheckRecord } from "./domain/checks";
export { MERGE_FIELDS, merge, type StepUrls } from "./domain/merge";
export { REWRITE_PRESETS } from "./domain/rewrite";
export { claimCheck, injectionCheck } from "./definitions/checks";
export { campaignRulePort } from "./application/rule-port";
export { templateStep, type StepOutput } from "./application/step-links";
export { stepOutputVersion, templateVersion } from "./application/snapshot";
export { MAX_ROWS, type PersonInput, type PersonResult } from "./application/people";
export { campaignDefinitions, campaignDrafter, recipientReader, recipientWriter, socialDrafter } from "./definitions/drafter";
export { campaignRoutes } from "./routes";
