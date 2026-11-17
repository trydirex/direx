// SPDX-License-Identifier: AGPL-3.0-only
// The safety results an agent-written rule needs, for the drafter and checks this deployment runs,
// read once at boot. eval:check reads the same list, so CI and the product can't disagree.
import { safetyGate, type RequiredEval } from "../../agents";
import { CHECK_CANDIDATES, CLAIM_CHECK_MODEL } from "../../models";
import { optOutEval } from "../../outreach";
import { claimCheck, injectionCheck } from "../definitions/checks";
import { recipientReader, recipientWriter } from "../definitions/drafter";
import { hostilePagesEval } from "../evals/hostile-pages";

export const agentWrittenEvals = (): RequiredEval[] => [
  { kind: "claim_check", ...claimCheck },
  { kind: "injection_check", ...injectionCheck },
  hostilePagesEval([recipientReader, recipientWriter, claimCheck, injectionCheck]),
  optOutEval,
];

export const agentWrittenCandidate = (deployment: "self_host" | "cloud") => (deployment === "self_host" ? CHECK_CANDIDATES.claude_code : CHECK_CANDIDATES.anthropic);

/** A check that runs on another model than the candidate is read from that model's result. */
const modelFor = (deployment: "self_host" | "cloud"): Record<string, string> => (deployment === "self_host" ? { claim_check: CLAIM_CHECK_MODEL.claude_code } : {});

/** The product asks in English only, until a second language's opt-out results pass. */
export function agentWrittenGate(deployment: "self_host" | "cloud", language = "en", resultsDir?: string): { offered: boolean; missing: string[] } {
  const c = agentWrittenCandidate(deployment);
  const gate = safetyGate({ required: agentWrittenEvals(), provider: c.provider, model: c.model, modelFor: modelFor(deployment), language, ...(resultsDir ? { resultsDir } : {}) });
  return gate.offered ? { offered: true, missing: [] } : { offered: false, missing: gate.missing };
}
