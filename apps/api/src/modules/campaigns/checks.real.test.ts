// SPDX-License-Identifier: AGPL-3.0-only
// The real eval of the draft checks. Only `bun run eval --purpose ... --provider ... --runs N` runs it,
// against a throwaway test database: the vitest config leaves *.real.test.ts out of every other run.
// Each labelled case is asked N times. Progress is kept beside the result, so a run stopped by the
// subscription's usage limit picks up where it stopped. No file holds a key or a draft's words.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { missesBar, resultFileOf, RESULTS_DIR, type EvalResult } from "../agents/index";
import { seedMember } from "../identity/fixtures/member";
import { CHECK_CANDIDATES, CLAIM_CHECK_MODEL, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { askCheck } from "./application/draft-checks";
import { CHECK_CASES, CHECK_FACTS, pendingAsks, scoreCheckRun, tallyCheckRuns, type CheckRun } from "./definitions/check-cases";
import { claimCheck, injectionCheck } from "./definitions/checks";
import type { ClaimAnswer, InjectionAnswer } from "./domain/checks";

const purpose = process.env.DIREX_EVAL_PURPOSE as "claim_check" | "injection_check" | undefined;
const provider = process.env.DIREX_EVAL_PROVIDER as keyof typeof CHECK_CANDIDATES | undefined;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 5);
const secret = provider === "claude_code" ? process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN : process.env.DIREX_EVAL_ANTHROPIC_KEY;

test("a draft check meets its bar on every labelled case with a real model", { timeout: 3_600_000 }, async () => {
  if (!purpose || !provider || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose ... --provider ... --runs N");
  const check = purpose === "claim_check" ? claimCheck : injectionCheck;
  const which = check.id === "claim_check" ? "claim" : "injection";
  // --model tries the check on another model of the same provider; the result file names that model.
  // By default each check runs on the model production gives it; --model tries another one.
  const model = process.env.DIREX_EVAL_MODEL ?? (check.id === "claim_check" && provider === "claude_code" ? CLAIM_CHECK_MODEL.claude_code : CHECK_CANDIDATES[provider].model);
  const candidate = { ...CHECK_CANDIDATES[provider], model };
  const file = join(RESULTS_DIR, resultFileOf(check, candidate.provider, candidate.model));
  const progressFile = `${file}.progress.json`;
  const done: { name: string; n: number; run: CheckRun }[] = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, "utf8")) : [];

  const workspaceId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await seedMember(workspaceId, userId);
  const models = createModels({ deployment: "self_host", routes: { [check.id]: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider) });

  for (const { c, n } of pendingAsks(done, runs)) {
    {
      const asked = await askCheck<ClaimAnswer | InjectionAnswer>(models.generate, workspaceId, check, { key: crypto.randomUUID(), userId, subject: c.subject, text: c.text, facts: CHECK_FACTS, details: c.details });
      if (!("output" in asked) && asked.failure.startsWith("provider_quota")) {
        writeFileSync(progressFile, JSON.stringify(done));
        throw new Error(`usage limit reached after ${done.length} of ${runs * CHECK_CASES.length} asks; run the same command again later to carry on`);
      }
      done.push({ name: c.name, n, run: scoreCheckRun(c, which, "output" in asked ? asked.output : null, "failure" in asked ? asked.failure : undefined) });
      writeFileSync(progressFile, JSON.stringify(done));
    }
  }

  const { cases, measures: tallied } = tallyCheckRuns(done.filter((d) => d.n <= runs));
  // Why runs went unanswered, counted per reason, so a low answered share says what to fix. The
  // reasons are error families and schema paths, never the model's words.
  const measures: Record<string, number> = { ...tallied };
  for (const d of done.filter((d) => d.n <= runs && !d.run.answered)) measures[d.run.why ?? "no answer"] = (measures[d.run.why ?? "no answer"] ?? 0) + 1;
  // Passed means it meets its bar. A case that failed every run still shows in `cases`: a clean draft
  // flagged or left unanswered goes to a person, which the bar allows up to its answered share.
  const scored = { agent: check.id, definitionVersion: check.version, promptDigest: check.promptDigest, provider: candidate.provider, model: candidate.model, at: new Date().toISOString(), runs, cases, measures };
  const why = missesBar(check.id, { ...scored, passed: false }, "en");
  const result: EvalResult = { ...scored, passed: why === null, ...(why && { why }) };
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  rmSync(progressFile, { force: true });
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
