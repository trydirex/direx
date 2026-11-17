// SPDX-License-Identifier: AGPL-3.0-only
// The real skeleton-drift eval. Only `bun run eval --purpose person_skeleton --provider claude_code --runs N`
// runs it, against a throwaway test database. Each clean page goes through the real reader, writer and
// checks with the step's email as a skeleton, and is scored on how much of the skeleton the draft kept.
// Each draft is then rewritten with the Shorter preset, and scored on how many of its words are left.
// Only numbers are written to the result, never draft words.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { recipientWriter, REWRITE_PRESETS } from "../campaigns/index";
import { HOSTILE_CASES, SKELETON_TEMPLATE, skeletonDrift, tallyDrift, type DriftRun } from "../campaigns/evals";
import { CHECK_CANDIDATES, CLAIM_CHECK_MODEL, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { RESULTS_DIR } from "./index";
import { draftingWorld } from "./fixtures/drafting-world";

const provider = process.env.DIREX_EVAL_PROVIDER as keyof typeof CHECK_CANDIDATES | undefined;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 3);
/** A Shorter rewrite keeps at most this share of the words. The preset asks for about half; a short email that keeps its facts, links and ask may stop nearer two thirds. */
const SHORTER_KEEPS = 0.75;
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const secret = provider === "claude_code" ? process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN : process.env.DIREX_EVAL_ANTHROPIC_KEY;

test("per-Person drafts keep to their step's skeleton", { timeout: 6 * 3_600_000 }, async () => {
  if (!provider || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose person_skeleton --provider ... --runs N");
  const candidate = CHECK_CANDIDATES[provider];
  const route = { candidates: [candidate] };
  const world = await draftingWorld({
    template: SKELETON_TEMPLATE,
    models: (runGate) => createModels({ deployment: "self_host", routes: { recipient_read: route, campaign_draft: route, claim_check: provider === "claude_code" ? { candidates: [{ ...candidate, model: CLAIM_CHECK_MODEL.claude_code }] } : route, injection_check: route }, keys: testKeys(secret, candidate.provider), runGate }),
  });
  const done: (DriftRun & { name: string })[] = [];
  const shorter: { name: string; before: number; after: number }[] = [];
  try {
    for (let n = 1; n <= runs; n++) {
      for (const c of HOSTILE_CASES.filter((c) => !c.hostile)) {
        const since = new Date();
        const run = await world.runCase(c);
        if (await world.limited(since)) throw new Error(`usage limit reached after ${done.length} runs; run it again later`);
        // The draft's body only; the subject is read by eye at checkpoint B.
        const body = run.text.slice(run.text.indexOf("\n") + 1);
        done.push({ name: c.name, drafted: run.drafted, ...(run.drafted ? skeletonDrift(SKELETON_TEMPLATE.text, c.person, body) : { kept: 0, addedSentences: 0 }) });
        if (!run.drafted) continue;
        const rewritten = await world.rewriteLast(REWRITE_PRESETS.shorter);
        shorter.push({ name: c.name, before: words(body), after: rewritten ? words(rewritten.after) : words(body) });
      }
    }
  } finally {
    await world.close();
  }
  const drift = tallyDrift(done);
  const shortened = shorter.filter((r) => r.after <= r.before * SHORTER_KEEPS).length;
  const shorterShare = shorter.length ? shortened / shorter.length : 0;
  const passed = drift.passed && shorterShare >= 0.9;
  const measures = { ...drift.measures, shorterRuns: shorter.length, shortened, shorterShare };
  const result = { agent: recipientWriter.id, promptRevision: recipientWriter.promptRevision, purpose: "person_skeleton", provider: candidate.provider, model: candidate.model, at: new Date().toISOString(), runs, cases: done, shorter, measures, passed };
  writeFileSync(join(RESULTS_DIR, `person_skeleton-${candidate.provider}-${candidate.model}.json`), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  expect(passed).toBe(true);
});
