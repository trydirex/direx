// SPDX-License-Identifier: AGPL-3.0-only
// The real eval of the lesson check. Only `bun run eval --purpose lesson_check --provider ... --runs N`
// runs it, against a throwaway test database: the vitest config leaves *.real.test.ts out of every other
// run. Each labelled sentence is asked N times and scored on the injection check's signed bar: no
// refused sentence may pass, and enough must be answered.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { missesBar, resultFileOf, RESULTS_DIR, type EvalResult } from "../agents/index";
import { seedMember } from "../identity/fixtures/member";
import { CHECK_CANDIDATES, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { askLessonCheck } from "./application/check";
import { judgeLesson, LESSON_CASES, lessonCheck } from "./definitions/lesson-check";

const provider = process.env.DIREX_EVAL_PROVIDER as keyof typeof CHECK_CANDIDATES | undefined;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 5);
const secret = provider === "claude_code" ? process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN : process.env.DIREX_EVAL_ANTHROPIC_KEY;

test("the lesson check meets the injection check's bar on every labelled sentence", { timeout: 3_600_000 }, async () => {
  if (!provider || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose lesson_check --provider ... --runs N");
  const candidate = CHECK_CANDIDATES[provider];
  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await seedMember(workspaceId, userId);
  const models = createModels({ deployment: "self_host", routes: { [lessonCheck.id]: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider) });

  const tally = LESSON_CASES.map((c) => ({ name: c.name, passes: 0, wrongPasses: 0, answered: 0 }));
  for (let n = 1; n <= runs; n++) {
    for (const [i, c] of LESSON_CASES.entries()) {
      // A new sentence each time, so a cached answer can't stand in for a new one.
      const asked = await askLessonCheck(models.generate, workspaceId, userId, `${c.text}${" ".repeat(n - 1)}`);
      const j = "output" in asked ? judgeLesson(asked.output) : { status: "malformed" as const };
      const t = tally[i]!;
      if (j.status === "malformed") continue;
      t.answered++;
      const said = j.status === "passed" ? "clean" : "refused";
      if (said === c.label) t.passes++;
      if (said === "clean" && c.label === "refused") t.wrongPasses++;
    }
  }
  const asks = runs * LESSON_CASES.length;
  const measures = { wrongPasses: tally.reduce((s, t) => s + t.wrongPasses, 0), answered: tally.reduce((s, t) => s + t.answered, 0) / asks };
  const scored = { agent: lessonCheck.id, definitionVersion: lessonCheck.version, promptDigest: lessonCheck.promptDigest, provider: candidate.provider, model: candidate.model, at: new Date().toISOString(), runs, measures, cases: tally.map((t) => ({ name: t.name, passed: t.passes === runs, passes: t.passes })) };
  const why = missesBar("injection_check", { ...scored, passed: false }, "en");
  const result: EvalResult = { ...scored, passed: why === null, ...(why && { why }) };
  writeFileSync(join(RESULTS_DIR, resultFileOf(lessonCheck, candidate.provider, candidate.model)), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
