// SPDX-License-Identifier: AGPL-3.0-only
// The real reply-label eval. Only `bun run eval --purpose reply_label --provider claude_code` runs it, against
// a throwaway test database: the vitest config leaves *.real.test.ts out of every other run. Progress is kept
// beside the result, so a run stopped by the usage limit carries on next time. No reply's words are stored.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { REPLY_LABEL_BAR, resultFileOf, RESULTS_DIR, type EvalResult } from "../agents/index";
import { seedMember } from "../identity/fixtures/member";
import { CHECK_CANDIDATES, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { askReplyLabel, replyLabelEval } from "./application/reply-label";
import type { ReplyLabel } from "./domain/reply-label";
import { collectLabels, evalSettings, progressFileOf } from "./evals/reply-label/run";
import { REPLY_LABEL_SET } from "./evals/reply-label/score";

const provider = process.env.DIREX_EVAL_PROVIDER as keyof typeof CHECK_CANDIDATES | undefined;
const secret = provider === "claude_code" ? process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN : process.env.DIREX_EVAL_ANTHROPIC_KEY;

test("reply labels meet their bar through a real model", { timeout: 3_600_000 }, async () => {
  if (!provider || !secret) throw new Error("run through bun run eval --purpose reply_label --provider ...");
  const { model, runs } = evalSettings(CHECK_CANDIDATES[provider].model, process.env);
  const candidate = { ...CHECK_CANDIDATES[provider], model };
  const file = join(RESULTS_DIR, resultFileOf({ id: replyLabelEval.id, version: replyLabelEval.version }, candidate.provider, candidate.model));
  const progressFile = progressFileOf(file, replyLabelEval.promptDigest, REPLY_LABEL_SET, runs);
  const done: Record<string, ReplyLabel | null> = existsSync(progressFile) ? JSON.parse(readFileSync(progressFile, "utf8")) : {};
  const workspaceId = crypto.randomUUID();
  await seedMember(workspaceId, crypto.randomUUID());
  const models = createModels({ deployment: "self_host", routes: { reply_label: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider) });

  const { score: s, count } = await collectLabels({
    set: REPLY_LABEL_SET, runs, done,
    ask: (words) => askReplyLabel(models.generate, workspaceId, crypto.randomUUID(), words),
    save: (progress) => writeFileSync(progressFile, JSON.stringify(progress)),
    report: (line) => console.log(line),
  });
  const passed = s.interestedRecall >= REPLY_LABEL_BAR.minInterestedRecall && s.accuracy >= REPLY_LABEL_BAR.minAccuracy;
  const result: EvalResult = {
    agent: replyLabelEval.id,
    definitionVersion: replyLabelEval.version,
    promptDigest: replyLabelEval.promptDigest,
    provider: candidate.provider,
    model: candidate.model,
    passed,
    at: new Date().toISOString(),
    runs,
    cases: [{ name: "labels", passed, passes: Math.round(s.accuracy * count), ...(!passed && { why: `interested recall ${s.interestedRecall}, accuracy ${s.accuracy}` }) }],
    measures: { interestedRecall: s.interestedRecall, accuracy: s.accuracy, missedHot: s.missedHot.length },
  };
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  rmSync(progressFile, { force: true });
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
