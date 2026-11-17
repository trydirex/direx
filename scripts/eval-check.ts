// SPDX-License-Identifier: AGPL-3.0-only
// CI's eval gate: needs no key and no database.
import { checkEvals, checkRouteResults } from "../apps/api/src/modules/agents/index";
import { agentWrittenGate, claimCheck, injectionCheck } from "../apps/api/src/modules/campaigns/index";
import { campaignEvalSuites, checkCaseErrors, hostileCaseErrors } from "../apps/api/src/modules/campaigns/evals";
import { CHECK_CANDIDATES, routesFor } from "../apps/api/src/modules/models/index";
import { OPTOUT_PROMPT, optOutEval } from "../apps/api/src/modules/outreach/index";
import { labelSetErrors, OPTOUT_SETS, REPLY_LABEL_SET, replyLabelEval, replySetErrors } from "../apps/api/src/modules/outreach/evals";
import { planEvalSuites } from "../apps/api/src/modules/plans/evals";
import { clipEvalSuites } from "../apps/api/src/modules/clips/evals";
import { prospectingEvalSuites } from "../apps/api/src/modules/prospecting/evals";
import { askEvalSuites } from "../apps/api/src/modules/ask/evals";
import { changeClassifier, comparisonBrief, counterPost } from "../apps/api/src/modules/competitors/index";
import { voiceCheck } from "../apps/api/src/modules/facts/index";
import { resultWhy } from "../apps/api/src/modules/items/index";
import { lessonCheck } from "../apps/api/src/modules/lessons/index";
import { pageBrief } from "../apps/api/src/modules/seo/index";
import { SKILLS, unprovenSkill } from "../test/skills/run";

const routes = { cloud: routesFor("cloud"), self_host: routesFor("self_host") };
const errors = [
  ...checkEvals({ suites: [...planEvalSuites, ...campaignEvalSuites, ...prospectingEvalSuites, ...clipEvalSuites, ...askEvalSuites], routes }),
  // The draft checks are scored against labels, not agent invariants, but their routes follow the same rule.
  ...checkCaseErrors(),
  ...hostileCaseErrors(),
  ...replySetErrors(OPTOUT_SETS),
  ...labelSetErrors(REPLY_LABEL_SET),
  // No route yet: one is added only with a passing real-key result (reply desk, Gate G).
  ...checkRouteResults(replyLabelEval, routes),
  ...checkRouteResults(claimCheck, routes),
  ...checkRouteResults(injectionCheck, routes),
  ...checkRouteResults({ id: optOutEval.id, version: optOutEval.version, prompt: OPTOUT_PROMPT, purposes: ["optout_detect"] }, routes),
  // Agents scored by their own real evals, with no scripted suite: their routes follow the same rule.
  ...[changeClassifier, comparisonBrief, counterPost, voiceCheck, resultWhy, lessonCheck].flatMap((a) => checkRouteResults(a, routes)),
  // The Brief's result is filed as seo_brief and digests its id and version with the prompt (page-brief.real.test.ts).
  ...checkRouteResults({ id: "seo_brief", version: pageBrief.version, prompt: `${pageBrief.id}@${pageBrief.version}\n${pageBrief.prompt}`, purposes: pageBrief.purposes }, routes),
];
for (const e of errors) console.error(`eval:check: ${e}`);

// Whether the agent-written mode could be offered. Closed is the expected state until every bar is met
// and signed, so this reports and never fails.
// The product's own gate, so CI and the running app can't disagree.
for (const [deployment, provider] of [["self_host", CHECK_CANDIDATES.claude_code.provider], ["cloud", CHECK_CANDIDATES.anthropic.provider]] as const) {
  for (const { language } of OPTOUT_SETS) {
    const gate = agentWrittenGate(deployment, language);
    console.log(`eval:check: agent-written mode on ${deployment} (${provider}, ${language}): ${gate.offered ? "could be offered" : `closed: ${gate.missing.join("; ")}`}`);
  }
}
// The published skills: each change runs on both agents before it goes out (skills/README.md). Reports, never fails.
for (const skill of SKILLS) {
  const missing = unprovenSkill(skill);
  console.log(`eval:check: skill ${skill}: ${missing.length ? `no passing result for its current files on ${missing.join(", ")}` : "proven on both agents"}`);
}
if (errors.length > 0) process.exit(1);
console.log("eval:check: ok");
