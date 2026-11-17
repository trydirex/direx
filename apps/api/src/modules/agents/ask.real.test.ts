// SPDX-License-Identifier: AGPL-3.0-only
// The real Ask eval. Only `bun run eval --purpose ask --provider claude_code --runs N` runs it, on a
// Claude Code subscription token: the vitest config leaves *.real.test.ts out of every other run. Each
// case runs N times through the real loop with Ask's own definition and read tools, whose results are
// the case's fixed text, and is scored by the cases' own bar.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { expect, test } from "vitest";
import { askAgent, askRequest, nowLine } from "../ask/index";
import { ASK_CASES, scoreAskRun, type AskCase } from "../ask/evals";
import { createCoreReads } from "../core-reads/index";
import { itemsWorld, person } from "../items/fixtures/items";
import { createModels, routesFor } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { digestOf } from "./adapters/digest";
import { createLoop } from "./application/loop";
import { createProposals } from "./application/proposals";
import { createRuns } from "./application/runs";
import { eventsOf, inWorkspace, readRun, saveSettings } from "./adapters/repo";
import { resultFileOf, RESULTS_DIR, type EvalResult } from "./index";

const provider = process.env.DIREX_EVAL_PROVIDER;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 5);
const secret = process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN;

type Reply = Parameters<typeof scoreAskRun>[1];

test("Ask meets its bar on every case", { timeout: 6 * 3_600_000 }, async () => {
  if (provider !== "claude_code" || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose ask --provider claude_code --runs N");
  const candidate = routesFor("self_host").ask!.candidates[0]!;
  const { W, items } = await itemsWorld({ kinds: {} });
  const now = () => new Date();
  // Every case on every run is one Ask run in this one test Workspace, which can be more than the daily cap allows.
  await inWorkspace(W, (tx) => saveSettings(tx, W, askAgent.id, { maxDailyRuns: ASK_CASES.length * runs }, person.userId, now()));
  let current: AskCase = ASK_CASES[0]!;
  let handed: Reply = null;
  // The real tools' names, descriptions and input checks; only what they return is the case's.
  const real = createCoreReads({ items: () => items, campaigns: () => ({ list: async () => [], campaign: async () => undefined, stepsWithoutDrafts: async () => [] }) as never });
  const reads = Object.fromEntries(Object.entries(real).map(([name, r]) => [name, { ...r, read: async () => ({ text: current.reads[name as keyof AskCase["reads"]] ?? "Nothing here.", trust: "untrusted" as const }) }]));
  const definitions = { [askAgent.id]: askAgent as never };
  const agentRuns = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
  const models = createModels({ deployment: "self_host", routes: { ask: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider), runGate: agentRuns.runGate, now });
  const accept = createProposals({
    definitions,
    sinks: {
      ask_reply: async (_ws, p) => {
        handed = p.body as NonNullable<Reply>;
        return { ok: true, itemId: null };
      },
    },
    warnItem: async () => {},
    now,
  });
  // A refusal's reason never reaches the run's record, so the eval keeps it to say why a run failed.
  let refusals: string[] = [];
  const watched: Pick<typeof models, "generate"> = {
    generate: async (req) => {
      const r = await models.generate(req);
      if (!r.ok && "reason" in r && r.reason) refusals.push(r.reason);
      return r;
    },
  };
  const loop = createLoop({
    models: watched,
    runs: agentRuns,
    fetchPage: async () => ({ ok: false, reason: "http_error", url: "" }),
    now,
    definitions,
    // Brand reaches every run as context, as it does in production.
    context: async () => current.facts.map((text, i) => ({ id: `5a0c2f61-8b3d-4e7a-9c1f-2d4e6f8a1c${String(i).padStart(2, "0")}`, version: 1, text })),
    reads,
    accept,
  });

  const scores: { id: string; problems: string[] }[] = [];
  for (let n = 1; n <= runs; n++) {
    for (const c of ASK_CASES) {
      current = c;
      handed = null;
      refusals = [];
      const input = { request: askRequest(c.message, c.agent, c.looking), brief: [nowLine(now(), c.timeZone ?? "UTC")], target: { id: c.attached?.id ?? null, draftRevision: 0 }, ...(c.attached && { attached: c.attached }), ...(c.history && { history: c.history }) };
      const started = await agentRuns.start(W, { definition: askAgent, input, idempotencyKey: crypto.randomUUID(), trigger: "user_request" });
      await loop.execute((await agentRuns.wake({ workspaceId: W, runId: started.id }))!);
      const problems = scoreAskRun(c, handed);
      // Every read a missed run made, and how it came back, so the reason is in the log and not a guess.
      if (problems.length) {
        const reads = (await inWorkspace(W, (tx) => eventsOf(tx, started.id))).filter((e) => e.kind === "tool_call").map((e) => `${e.name}=${e.outcome}`);
        problems.push(`reads: ${reads.join(", ") || "none"}`);
      }
      if (problems.length) {
        const ended = await inWorkspace(W, (tx) => readRun(tx, started.id));
        // What each model call came back with, so a missed run says why, whether or not it handed something over.
        const calls = (await inWorkspace(W, (tx) => eventsOf(tx, started.id))).filter((e) => e.kind === "model_call").map((e) => e.outcome);
        problems.push(`${ended?.status}: ${ended?.statusReason ?? "no reason"}; model calls: ${calls.join(", ") || "none"}${refusals.length ? `; refused because: ${refusals.join(" | ")}` : ""}`);
      }
      // A miss shows what the reply said, so the next prompt change starts from its words.
      const said = problems.length && handed ? ` said: ${JSON.stringify((handed as NonNullable<Reply>).text.slice(0, 300))}` : "";
      console.log(`${c.id} run ${n}: ${(handed as Reply)?.kind ?? "nothing"}${problems.length ? `; ${problems.join("; ")}` : ""}${said}`);
      scores.push({ id: c.id, problems });
    }
  }

  const evalOf = { id: askAgent.id, version: askAgent.version };
  const bad = scores.filter((s) => s.problems.length);
  const result: EvalResult = {
    agent: evalOf.id,
    definitionVersion: evalOf.version,
    promptDigest: digestOf(askAgent.prompt),
    provider: candidate.provider,
    model: candidate.model,
    at: new Date().toISOString(),
    runs,
    passed: bad.length === 0,
    ...(bad.length && { why: `${bad.length} of ${scores.length} runs missed the bar` }),
    cases: ASK_CASES.map((c) => {
      const mine = scores.filter((s) => s.id === c.id);
      return { name: c.id, passed: mine.every((s) => !s.problems.length), passes: mine.filter((s) => !s.problems.length).length };
    }),
    measures: { problemRuns: bad.length },
  };
  writeFileSync(join(RESULTS_DIR, resultFileOf(evalOf, candidate.provider, candidate.model)), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
