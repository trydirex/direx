// SPDX-License-Identifier: AGPL-3.0-only
// The real-key evals, against a throwaway test database; each writes its result file. Keys stay in
// this process's environment and are never printed.
//   DIREX_EVAL_ANTHROPIC_KEY=... bun run eval --agent brand_reader   (or DIREX_EVAL_CLAUDE_CODE_TOKEN=... with --provider claude_code)
//   DIREX_EVAL_ANTHROPIC_KEY=... bun run eval --purpose claim_check --provider anthropic
//   DIREX_EVAL_CLAUDE_CODE_TOKEN=... bun run eval --purpose injection_check --provider claude_code --runs 5
//   DIREX_EVAL_CLAUDE_CODE_TOKEN=... bun run eval --purpose seo_brief --provider claude_code --runs 5
//   DIREX_EVAL_CLAUDE_CODE_TOKEN=... bun run eval --purpose clip_pick --provider claude_code --runs 5
//   DIREX_EVAL_CLAUDE_CODE_TOKEN=... bun run eval --purpose lesson_check --provider claude_code --runs 5
//   DIREX_EVAL_CLAUDE_CODE_TOKEN=... bun run eval --purpose plan_draft --provider claude_code --runs 3
//   DIREX_EVAL_CLAUDE_CODE_TOKEN=... bun run eval --purpose ask --provider claude_code --runs 5
//   DIREX_EVAL_CLAUDE_CODE_TOKEN=... bun run eval --purpose person_skeleton --provider claude_code --runs 3
//   DIREX_EVAL_CLAUDE_CODE_TOKEN=... bun run eval --purpose result_why --provider claude_code --runs 5 [--model M]
//   DIREX_EVAL_CLAUDE_CODE_TOKEN=... bun run eval --purpose names_read|terms_draft|strategy_draft|campaign_draft|social_draft --provider claude_code --runs 5
//   bun run eval --skill cold-email-compliance --provider codex [--runs N] [--case ID]   (needs no database)
import { parseArgs } from "node:util";
import { evalSkill, type Provider, SKILLS } from "../test/skills/run";

const USAGE = "usage: bun run eval --agent brand_reader [--provider claude_code] | --purpose claim_check|injection_check|hostile_pages|optout_detect|reply_label|seo_brief|clip_pick|lesson_check|voice_check|plan_draft|ask|person_skeleton|competitor_change|competitor_brief|competitor_post|result_why|names_read|terms_draft|strategy_draft|campaign_draft|social_draft --provider anthropic|claude_code [--runs N] [--model M, reply_label, claim_check, injection_check, competitor_change, competitor_brief, competitor_post, result_why, names_read, terms_draft, strategy_draft, campaign_draft and social_draft only] | --skill NAME --provider claude_code|codex [--runs N] [--model M] [--case ID]";
const { values } = parseArgs({ options: { agent: { type: "string" }, purpose: { type: "string" }, provider: { type: "string" }, runs: { type: "string" }, model: { type: "string" }, skill: { type: "string" }, case: { type: "string" } } });

if (values.skill) {
  if (!SKILLS.includes(values.skill) || (values.provider !== "claude_code" && values.provider !== "codex")) throw new Error(USAGE);
  if (values.provider === "claude_code" && !process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN) throw new Error("DIREX_EVAL_CLAUDE_CODE_TOKEN is not set");
  const passed = await evalSkill({ skill: values.skill, provider: values.provider as Provider, runs: Number(values.runs ?? "5"), model: values.model, only: values.case });
  process.exit(passed ? 0 : 1);
}

const vitest = (file: string, env: Record<string, string> = {}) =>
  process.exit(Bun.spawnSync(["bun", "--bun", "vitest", "run", file], { stdout: "inherit", stderr: "inherit", env: { ...process.env, ...env } }).exitCode);

if (values.agent === "brand_reader" && !values.purpose) {
  const needs = values.provider === "claude_code" ? "DIREX_EVAL_CLAUDE_CODE_TOKEN" : "DIREX_EVAL_ANTHROPIC_KEY";
  if (!process.env[needs]) throw new Error(`${needs} is not set`);
  vitest("apps/api/src/modules/agents/evals/real.test.ts", { DIREX_EVAL_PURPOSE: "brand_extract", DIREX_EVAL_PROVIDER: values.provider ?? "anthropic" });
}
const purposes = ["claim_check", "injection_check", "hostile_pages", "optout_detect", "reply_label", "seo_brief", "clip_pick", "lesson_check", "voice_check", "plan_draft", "ask", "person_skeleton", "competitor_change", "competitor_brief", "competitor_post", "result_why", "names_read", "terms_draft", "strategy_draft", "campaign_draft", "social_draft"];
const providers = { anthropic: "DIREX_EVAL_ANTHROPIC_KEY", claude_code: "DIREX_EVAL_CLAUDE_CODE_TOKEN" } as const;
if (values.agent || !values.purpose || !purposes.includes(values.purpose) || !values.provider || !(values.provider in providers)) throw new Error(USAGE);
const needs = providers[values.provider as keyof typeof providers];
if (!process.env[needs]) throw new Error(`${needs} is not set`);
if (values.model && values.purpose !== "reply_label" && values.purpose !== "claim_check" && values.purpose !== "injection_check" && values.purpose !== "competitor_change" && values.purpose !== "competitor_brief" && values.purpose !== "competitor_post" && values.purpose !== "result_why" && values.purpose !== "names_read" && values.purpose !== "terms_draft" && values.purpose !== "strategy_draft" && values.purpose !== "campaign_draft" && values.purpose !== "social_draft") throw new Error(USAGE);
const FILES: Record<string, string> = {
  hostile_pages: "apps/api/src/modules/agents/hostile.real.test.ts",
  optout_detect: "apps/api/src/modules/outreach/optout.real.test.ts",
  reply_label: "apps/api/src/modules/outreach/reply-label.real.test.ts",
  seo_brief: "apps/api/src/modules/agents/page-brief.real.test.ts",
  clip_pick: "apps/api/src/modules/agents/clip-picker.real.test.ts",
  lesson_check: "apps/api/src/modules/lessons/check.real.test.ts",
  voice_check: "apps/api/src/modules/facts/voice-check.real.test.ts",
  plan_draft: "apps/api/src/modules/agents/plan-drafter.real.test.ts",
  ask: "apps/api/src/modules/agents/ask.real.test.ts",
  person_skeleton: "apps/api/src/modules/agents/skeleton.real.test.ts",
  competitor_change: "apps/api/src/modules/agents/change-classifier.real.test.ts",
  competitor_brief: "apps/api/src/modules/agents/comparison-brief.real.test.ts",
  competitor_post: "apps/api/src/modules/agents/counter-post.real.test.ts",
  result_why: "apps/api/src/modules/items/result-why.real.test.ts",
  names_read: "apps/api/src/modules/agents/prospecting.real.test.ts",
  terms_draft: "apps/api/src/modules/agents/prospecting.real.test.ts",
  strategy_draft: "apps/api/src/modules/agents/strategy-drafter.real.test.ts",
  campaign_draft: "apps/api/src/modules/agents/campaign-copy.real.test.ts",
  social_draft: "apps/api/src/modules/agents/campaign-copy.real.test.ts",
};
const file = FILES[values.purpose] ?? "apps/api/src/modules/campaigns/checks.real.test.ts";
vitest(file, { DIREX_EVAL_PURPOSE: values.purpose, DIREX_EVAL_PROVIDER: values.provider, DIREX_EVAL_RUNS: values.runs ?? "5", ...(values.model && { DIREX_EVAL_MODEL: values.model }) });
