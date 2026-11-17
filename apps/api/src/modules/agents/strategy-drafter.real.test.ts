// SPDX-License-Identifier: AGPL-3.0-only
// The real strategy_drafter eval. Only `bun run eval --purpose strategy_draft --provider claude_code --runs N`
// runs it: the vitest config leaves *.real.test.ts out of every other run. Each case runs N times through
// the real loop, briefed as the plans module briefs it (today's date and the Facts it may cite), and every
// run must cite only what it was given, present no guess as a Fact, promise nothing and obey no Fact.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { expect, test } from "vitest";
import { itemsWorld } from "../items/fixtures/items";
import { CHECK_CANDIDATES, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { planDefinitions, strategyDrafter, type StrategyBody } from "../plans/index";
import { scoreStrategyRun, STRATEGY_CASES, strategyFactId } from "../plans/evals";
import { digestOf } from "./adapters/digest";
import { inWorkspace, readRun } from "./adapters/repo";
import { createLoop } from "./application/loop";
import { createProposals } from "./application/proposals";
import { createRuns, type DraftInput } from "./application/runs";
import { resultFileOf, RESULTS_DIR, type EvalResult } from "./index";

const provider = process.env.DIREX_EVAL_PROVIDER;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 5);
const secret = process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN;

test("strategy_drafter cites only what it was given, and promises and obeys nothing", { timeout: 6 * 3_600_000 }, async () => {
  if (provider !== "claude_code" || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose strategy_draft --provider claude_code --runs N");
  const candidate = { ...CHECK_CANDIDATES.claude_code, maxOutputTokens: 8192, ...(process.env.DIREX_EVAL_MODEL && { model: process.env.DIREX_EVAL_MODEL }) };
  const { W } = await itemsWorld({ kinds: {} });
  const now = () => new Date();
  const handed: { body?: StrategyBody } = {};
  const agentRuns = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
  const models = createModels({ deployment: "self_host", routes: { plan_draft: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider), runGate: agentRuns.runGate, now });
  const accept = createProposals({
    definitions: planDefinitions,
    sinks: {
      strategy_proposal: async (_ws, p) => {
        handed.body = p.body as StrategyBody;
        return { ok: true, itemId: null };
      },
    },
    warnItem: async () => {},
    now,
  });

  const scores: { name: string; problems: string[] }[] = [];
  for (let n = 1; n <= runs; n++) {
    for (const c of STRATEGY_CASES) {
      const usable = c.facts.map((f, i) => ({ id: strategyFactId(i), version: 1, text: f }));
      const loop = createLoop({ models, runs: agentRuns, fetchPage: async () => ({ ok: false, reason: "http_error", url: "" }), now, definitions: planDefinitions, context: async () => usable, accept });
      const list = usable.map((f) => `${f.id} version 1: ${f.text}`).join("\n");
      const input: DraftInput = {
        request: c.request,
        brief: [
          { kind: "date", refId: "today", version: null, text: `Today is ${now().toISOString().slice(0, 10)}.` },
          { kind: "citable_facts", refId: "usable_facts", version: null, text: usable.length ? `Facts you may cite, by id and version:\n${list}` : "There are no Facts to cite yet." },
        ],
        target: { id: null, draftRevision: 0 },
      };
      handed.body = undefined;
      const started = await agentRuns.start(W, { definition: strategyDrafter, input, idempotencyKey: crypto.randomUUID(), trigger: "person" });
      await loop.execute((await agentRuns.wake({ workspaceId: W, runId: started.id }))!);
      // Set by the sink during the run, which the type checker can't see.
      const body = handed.body as StrategyBody | undefined;
      const problems = scoreStrategyRun(c, body ?? null);
      if (!body) {
        const ended = await inWorkspace(W, (tx) => readRun(tx, started.id));
        problems.push(`${ended?.status}: ${ended?.statusReason ?? "no reason"}`);
      }
      console.log(`${c.name} run ${n}: ${body ? `${body.positioning} | now: ${body.channels.filter((ch) => ch.timing === "now").map((ch) => `${ch.label} (${ch.basis.kind})`).join(", ")}` : "nothing"}${problems.length ? `; ${problems.join("; ")}` : ""}`);
      scores.push({ name: c.name, problems });
    }
  }

  const bad = scores.filter((s) => s.problems.length);
  const result: EvalResult = {
    agent: strategyDrafter.id,
    definitionVersion: strategyDrafter.version,
    promptDigest: digestOf(strategyDrafter.prompt),
    provider: candidate.provider,
    model: candidate.model,
    at: new Date().toISOString(),
    runs,
    passed: bad.length === 0,
    ...(bad.length && { why: `${bad.length} of ${scores.length} runs missed the bar: ${[...new Set(bad.flatMap((s) => s.problems))].slice(0, 5).join("; ")}` }),
    cases: STRATEGY_CASES.map((c) => {
      const mine = scores.filter((s) => s.name === c.name);
      return { name: c.name, passed: mine.every((s) => !s.problems.length), passes: mine.filter((s) => !s.problems.length).length };
    }),
    measures: { problemRuns: bad.length },
  };
  writeFileSync(join(RESULTS_DIR, resultFileOf(strategyDrafter, candidate.provider, candidate.model)), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
