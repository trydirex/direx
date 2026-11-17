// SPDX-License-Identifier: AGPL-3.0-only
// The real eval of the sentence behind each number on Home. Only `bun run eval --purpose result_why --provider ...
// --runs N [--model ...]` runs it, against a throwaway test database: the vitest config leaves *.real.test.ts out of
// every other run. Each case is asked N times and scored on WHY_BAR, which can't be met until the founder signs it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { resultFileOf, RESULTS_DIR, type EvalResult } from "../agents/index";
import { seedMember } from "../identity/fixtures/member";
import { CHECK_CANDIDATES, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { askResultWhy } from "./application/result-why";
import { resultWhy } from "./definitions/result-why";
import { missesWhyBar, refusedRun, scoreWhyRun, WHY_CASES, whyMeasures } from "./evals";

const provider = process.env.DIREX_EVAL_PROVIDER as keyof typeof CHECK_CANDIDATES | undefined;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 5);
const secret = provider === "claude_code" ? process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN : process.env.DIREX_EVAL_ANTHROPIC_KEY;

test("the sentence behind each Home number meets its bar on every labelled case", { timeout: 3_600_000 }, async () => {
  if (!provider || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose result_why --provider ... --runs N");
  const candidate = { ...CHECK_CANDIDATES[provider], ...(process.env.DIREX_EVAL_MODEL && { model: process.env.DIREX_EVAL_MODEL }) };
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await seedMember(workspaceId, userId);
  const models = createModels({ deployment: "self_host", routes: { [resultWhy.id]: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider) });

  const all: Parameters<typeof whyMeasures>[0][number][] = [];
  const perCase = WHY_CASES.map((c) => ({ name: c.name, clean: 0, notes: [] as string[] }));
  for (let n = 1; n <= runs; n++) {
    for (const [i, c] of WHY_CASES.entries()) {
      // A new input each time, so a cached answer can't stand in for a new one.
      const asked = await askResultWhy(models.generate, workspaceId, userId, c.results, " ".repeat(n - 1));
      if (!("output" in asked)) {
        all.push(refusedRun(c));
        perCase[i]!.notes.push(`refused: ${asked.failure}`);
        continue;
      }
      const run = scoreWhyRun(c, asked.output);
      all.push(run);
      const right = run.hits === run.reasons && run.falseReasons === 0 && run.problems.length === 0;
      if (right) perCase[i]!.clean++;
      else perCase[i]!.notes.push(`${asked.output.lines.map((l) => `${l.key}: ${l.why ?? "null"}`).join(" | ")}${run.problems.length ? ` (${run.problems.join("; ")})` : ""}`);
    }
  }
  const measures = whyMeasures(all);
  const why = missesWhyBar(measures, runs);
  const result: EvalResult = {
    agent: resultWhy.id,
    definitionVersion: resultWhy.version,
    promptDigest: resultWhy.promptDigest,
    provider: candidate.provider,
    model: candidate.model,
    at: new Date().toISOString(),
    runs,
    measures,
    cases: perCase.map((p) => ({ name: p.name, passed: p.clean === runs, passes: p.clean, ...(p.notes.length && { why: p.notes.slice(0, 3).join(" / ") }) })),
    passed: why === null,
    ...(why && { why }),
  };
  writeFileSync(join(RESULTS_DIR, resultFileOf(resultWhy, candidate.provider, candidate.model)), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
