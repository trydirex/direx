// SPDX-License-Identifier: AGPL-3.0-only
// The real opt-out eval. Only `bun run eval --purpose optout_detect --provider claude_code` runs it,
// against a throwaway test database: the vitest config leaves *.real.test.ts out of every other run.
// Each reply goes through the rules, and the model reads only those the rules leave. Progress is kept
// beside the result, so a run stopped by the usage limit carries on next time. No reply's words are stored.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resultFileOf, RESULTS_DIR, type EvalResult } from "../agents/index";
import { seedMember } from "../identity/fixtures/member";
import { CHECK_CANDIDATES, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { askOptOutWithReason, optOutEval } from "./application/optout-model";
import type { OptOutAnswer } from "./domain/optout";
import { forModel, scoreSet } from "./evals/optout/score";
import { OPTOUT_SETS } from "./evals/optout/sets";

const provider = process.env.DIREX_EVAL_PROVIDER as keyof typeof CHECK_CANDIDATES | undefined;
const secret = provider === "claude_code" ? process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN : process.env.DIREX_EVAL_ANTHROPIC_KEY;

test("opt-out detection meets its bar in each language through the rules and a real model", { timeout: 6 * 3_600_000 }, async () => {
  if (!provider || !secret) throw new Error("run through bun run eval --purpose optout_detect --provider ...");
  const candidate = CHECK_CANDIDATES[provider];
  const file = join(RESULTS_DIR, resultFileOf(optOutEval, candidate.provider, candidate.model));
  const progressFile = `${file}.progress.json`;
  const done: Record<string, OptOutAnswer | null> = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, "utf8")) : {};
  const workspaceId = crypto.randomUUID();
  await seedMember(workspaceId, crypto.randomUUID());
  const models = createModels({ deployment: "self_host", routes: { optout_detect: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider) });

  for (const set of OPTOUT_SETS) {
    for (const [i, r] of set.replies.entries()) {
      const key = `${set.language}:${i}`;
      const words = forModel(r);
      if (key in done || words === null) continue;
      const asked = await askOptOutWithReason(models.generate, workspaceId, crypto.randomUUID(), words);
      if (asked.failure === "provider_quota") {
        writeFileSync(progressFile, JSON.stringify(done));
        throw new Error(`usage limit reached after ${Object.keys(done).length} replies; run the same command again later to carry on`);
      }
      done[key] = asked.answer;
      writeFileSync(progressFile, JSON.stringify(done));
    }
  }

  const measures: Record<string, number> = {};
  const cases: EvalResult["cases"] = [];
  for (const set of OPTOUT_SETS) {
    const s = scoreSet(set, set.replies.map((_, i) => done[`${set.language}:${i}`] ?? null));
    measures[`recall.${set.language}`] = s.recall;
    measures[`precision.${set.language}`] = s.precision;
    measures[`misses.${set.language}`] = s.misses.length;
    measures[`wrongStops.${set.language}`] = s.wrongStops.length;
    // Counts only: the replies' words stay in the set file, not in the result.
    // The terminal gets which replies went wrong, so a miss says what to fix; the replies are the set's own.
    for (const m of s.misses) console.log(`missed (${set.language}): ${m}`);
    for (const w of s.wrongStops) console.log(`stopped who didn't ask (${set.language}): ${w}`);
    const passed = s.recall === 1 && s.precision >= 0.95;
    cases.push({ name: set.language, passed, passes: set.replies.length - s.misses.length - s.wrongStops.length, ...(!passed && { why: `${s.misses.length} missed, ${s.wrongStops.length} stopped who didn't ask` }) });
  }
  const reviewedLanguages = OPTOUT_SETS.filter((s) => s.reviewedBy).map((s) => s.language);
  const result: EvalResult = { agent: optOutEval.id, definitionVersion: optOutEval.version, promptDigest: optOutEval.promptDigest, provider: candidate.provider, model: candidate.model, passed: cases.every((c) => c.passed), at: new Date().toISOString(), runs: 1, cases, measures, reviewedLanguages };
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  rmSync(progressFile, { force: true });
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
