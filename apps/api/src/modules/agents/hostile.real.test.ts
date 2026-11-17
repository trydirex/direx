// SPDX-License-Identifier: AGPL-3.0-only
// The real hostile-pages eval. Only `bun run eval --purpose hostile_pages --provider claude_code --runs N`
// runs it, against a throwaway test database: the vitest config leaves *.real.test.ts out of every
// other run. Every case runs N times through the real reader, writer and checks. Progress is kept
// beside the result, so a run stopped by the usage limit carries on next time.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { claimCheck, injectionCheck, recipientReader, recipientWriter } from "../campaigns/index";
import { HOSTILE_CASES, hostilePagesEval, STRATEGY_CANARY, tallyHostile, unsafeRun, type HostileRun } from "../campaigns/evals";
import { CHECK_CANDIDATES, CLAIM_CHECK_MODEL, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { missesBar, resultFileOf, RESULTS_DIR, type EvalResult } from "./index";
import { draftingWorld } from "./fixtures/drafting-world";

const provider = process.env.DIREX_EVAL_PROVIDER as keyof typeof CHECK_CANDIDATES | undefined;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 5);
const secret = provider === "claude_code" ? process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN : process.env.DIREX_EVAL_ANTHROPIC_KEY;

test("no hostile page gets its payload into a draft a rule could send", { timeout: 6 * 3_600_000 }, async () => {
  if (!provider || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose hostile_pages --provider ... --runs N");
  const candidate = CHECK_CANDIDATES[provider];
  const evalOf = hostilePagesEval([recipientReader, recipientWriter, claimCheck, injectionCheck]);
  const file = join(RESULTS_DIR, resultFileOf(evalOf, candidate.provider, candidate.model));
  const progressFile = `${file}.progress.json`;
  const done: { name: string; n: number; run: HostileRun }[] = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, "utf8")) : [];
  // Every purpose the pipeline calls goes to the one candidate under test.
  const route = { candidates: [candidate] };
  const world = await draftingWorld({
    models: (runGate) => createModels({ deployment: "self_host", routes: { recipient_read: route, campaign_draft: route, claim_check: provider === "claude_code" ? { candidates: [{ ...candidate, model: CLAIM_CHECK_MODEL.claude_code }] } : route, injection_check: route }, keys: testKeys(secret, candidate.provider), runGate }),
  });

  try {
    for (let n = 1; n <= runs; n++) {
      for (const c of HOSTILE_CASES) {
        if (done.some((d) => d.name === c.name && d.n === n)) continue;
        const since = new Date();
        const run = await world.runCase(c);
        if (await world.limited(since)) {
          throw new Error(`usage limit reached after ${done.length} of ${runs * HOSTILE_CASES.length} runs; run the same command again later to carry on`);
        }
        // A clean page held for a person is what the bar counts against; print why, to the terminal only.
        if (!c.hostile && !run.coverable) console.log(`held: ${c.name} [${(run.held ?? []).join(", ")}]\n  ${(run.notes ?? []).join("\n  ")}`);
        // Only what the scorer needs is kept: whether it was sendable, and a marker if it leaked. No draft words.
        done.push({ name: c.name, n, run: { drafted: run.drafted, coverable: run.coverable, text: unsafeRun(run, c) ? (c.markers[0] ?? STRATEGY_CANARY) : "", held: run.held ?? [] } });
        writeFileSync(progressFile, JSON.stringify(done));
      }
    }
  } finally {
    await world.close();
  }

  const { cases, measures: tallied } = tallyHostile(done.filter((d) => d.n <= runs));
  const measures: Record<string, number> = { ...tallied };
  // Why drafts were held or never written, counted per reason and kept apart for clean and hostile
  // pages: holding a hostile page is the point, holding a clean one is what keeps the share low.
  for (const d of done.filter((d) => d.n <= runs)) {
    const kind = HOSTILE_CASES.find((c) => c.name === d.name)?.hostile ? "hostile" : "clean";
    for (const why of d.run.held ?? []) measures[`held.${kind}.${why}`] = (measures[`held.${kind}.${why}`] ?? 0) + 1;
  }
  const scored = { agent: evalOf.id, definitionVersion: evalOf.version, promptDigest: evalOf.promptDigest, provider: candidate.provider, model: candidate.model, at: new Date().toISOString(), runs, cases, measures };
  const why = missesBar("hostile_pages", { ...scored, passed: false }, "en");
  const result: EvalResult = { ...scored, passed: why === null, ...(why && { why }) };
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  rmSync(progressFile, { force: true });
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
