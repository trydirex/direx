// SPDX-License-Identifier: AGPL-3.0-only
// The real clip_picker eval. Only `bun run eval --purpose clip_pick --provider claude_code --runs N` runs
// it, on a Claude Code subscription token: the vitest config leaves *.real.test.ts out of every other run.
// Each case runs N times through the real loop with the clips module's agent, given exactly the text a
// clip run gives it, and is scored by the cases' own bar.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { expect, test } from "vitest";
import { clipDefinitions, clipPicker, pickText, type Moment } from "../clips/index";
import { CLIP_CASES, scoreClipRun } from "../clips/evals";
import { itemsWorld } from "../items/fixtures/items";
import { createModels, routesFor } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { digestOf } from "./adapters/digest";
import { createLoop } from "./application/loop";
import { createProposals } from "./application/proposals";
import { createRuns } from "./application/runs";
import { inWorkspace, readRun } from "./adapters/repo";
import { resultFileOf, RESULTS_DIR, type EvalResult } from "./index";

const provider = process.env.DIREX_EVAL_PROVIDER;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 5);
const secret = process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN;

test("clip_picker meets its bar on every case", { timeout: 6 * 3_600_000 }, async () => {
  if (provider !== "claude_code" || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose clip_pick --provider claude_code --runs N");
  const candidate = routesFor("self_host").clip_pick!.candidates[0]!;
  const { W } = await itemsWorld({ kinds: {} });
  const now = () => new Date();
  const handed: { moments?: Moment[] } = {};
  const agentRuns = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
  const models = createModels({ deployment: "self_host", routes: { clip_pick: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider), runGate: agentRuns.runGate, now });
  const accept = createProposals({
    definitions: clipDefinitions,
    sinks: {
      draft: async (_ws, p) => {
        handed.moments = (p.body as { moments: Moment[] }).moments;
        return { ok: true, itemId: null };
      },
    },
    warnItem: async () => {},
    now,
  });
  let context: { id: string; version: number; text: string }[] = [];
  const loop = createLoop({ models, runs: agentRuns, fetchPage: async () => ({ ok: false, reason: "http_error", url: "" }), now, definitions: clipDefinitions, context: async () => context, accept });

  const scores: { id: string; problems: string[]; found: string[] }[] = [];
  for (let n = 1; n <= runs; n++) {
    for (const c of CLIP_CASES) {
      // The Workspace's Facts reach every run as context too, as they do in production.
      context = c.facts.map((f) => ({ id: f.id, version: f.version, text: `${f.field}${f.subject ? ` (${f.subject})` : ""}: ${f.value}` }));
      handed.moments = undefined;
      const started = await agentRuns.start(W, { definition: clipPicker, input: { text: pickText(c.words, c.facts, c.measures) }, idempotencyKey: crypto.randomUUID(), trigger: "schedule" });
      await loop.execute((await agentRuns.wake({ workspaceId: W, runId: started.id }))!);
      const score = scoreClipRun(c, handed.moments ?? null);
      if (!handed.moments) {
        const ended = await inWorkspace(W, (tx) => readRun(tx, started.id));
        score.problems.push(`${ended?.status}: ${ended?.statusReason ?? "no reason"}`);
      }
      console.log(`${c.id} run ${n}: found ${score.found.join(", ") || "none"}${score.problems.length ? `; ${score.problems.join("; ")}` : ""}`);
      scores.push({ id: c.id, ...score });
    }
  }

  const evalOf = { id: clipPicker.id, version: clipPicker.version };
  const bad = scores.filter((s) => s.problems.length);
  const result: EvalResult = {
    agent: evalOf.id,
    definitionVersion: evalOf.version,
    promptDigest: digestOf(clipPicker.prompt),
    provider: candidate.provider,
    model: candidate.model,
    at: new Date().toISOString(),
    runs,
    passed: bad.length === 0,
    ...(bad.length && { why: `${bad.length} of ${scores.length} runs missed the bar` }),
    cases: CLIP_CASES.map((c) => {
      const mine = scores.filter((s) => s.id === c.id);
      return { name: c.id, passed: mine.every((s) => !s.problems.length), passes: mine.filter((s) => !s.problems.length).length };
    }),
    measures: { problemRuns: bad.length, plantedFound: scores.reduce((n, s) => n + s.found.length, 0) / scores.length },
  };
  writeFileSync(join(RESULTS_DIR, resultFileOf(evalOf, candidate.provider, candidate.model)), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
