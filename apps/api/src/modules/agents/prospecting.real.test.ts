// SPDX-License-Identifier: AGPL-3.0-only
// The real prospecting evals. Only `bun run eval --purpose names_read|terms_draft --provider claude_code --runs N`
// runs one: the vitest config leaves *.real.test.ts out of every other run. Each case runs N times through
// the real loop, given exactly the text the product gives the agent, and every run must meet its case:
// the names reader keeps who works there now and reports nobody else; the terms drafter's terms name the
// business, and hold no person's data and nothing the text ordered. Only case names and problems are written.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { expect, test } from "vitest";
import { itemsWorld } from "../items/fixtures/items";
import { CHECK_CANDIDATES, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { namesReader, namesText, prospectingDefinitions, termsDrafter, termsText, type NamesOutput } from "../prospecting/index";
import { NAMES_CASES, scoreNamesRun, scoreTermsRun, TERMS_CASES } from "../prospecting/evals";
import { digestOf } from "./adapters/digest";
import { inWorkspace, readRun } from "./adapters/repo";
import { createLoop } from "./application/loop";
import { createProposals } from "./application/proposals";
import { createRuns } from "./application/runs";
import { resultFileOf, RESULTS_DIR, type EvalResult } from "./index";

type Terms = { terms: string[]; objective: string };
const EVALS = {
  names_read: {
    agent: namesReader,
    route: "recipient_read",
    cases: NAMES_CASES.map((c) => ({ name: c.name, text: namesText(c.domain, c.pages), score: (o: unknown) => scoreNamesRun(c, o ? (o as NamesOutput).people : null) })),
    show: (o: unknown) => (o as NamesOutput).people.map((p) => `${p.first} ${p.last}`.trim()).join(", ") || "nobody",
  },
  terms_draft: {
    agent: termsDrafter,
    route: "plan_draft",
    cases: TERMS_CASES.map((c) => ({ name: c.name, text: termsText(c.audience), score: (o: unknown) => scoreTermsRun(c, (o as Terms | undefined) ?? null) })),
    show: (o: unknown) => `${(o as Terms).terms.join(" | ")} || ${(o as Terms).objective}`,
  },
} as const;

const purpose = process.env.DIREX_EVAL_PURPOSE as keyof typeof EVALS | undefined;
const provider = process.env.DIREX_EVAL_PROVIDER;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 5);
const secret = process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN;

test("a prospecting agent meets its cases on every run", { timeout: 6 * 3_600_000 }, async () => {
  if (!purpose || !(purpose in EVALS) || provider !== "claude_code" || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose names_read|terms_draft --provider claude_code --runs N");
  const { agent, route, cases, show } = EVALS[purpose];
  const candidate = { ...CHECK_CANDIDATES.claude_code, ...(process.env.DIREX_EVAL_MODEL && { model: process.env.DIREX_EVAL_MODEL }) };
  const { W } = await itemsWorld({ kinds: {} });
  const now = () => new Date();
  const handed: { body?: unknown } = {};
  const agentRuns = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
  const models = createModels({ deployment: "self_host", routes: { [route]: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider), runGate: agentRuns.runGate, now });
  const accept = createProposals({
    definitions: prospectingDefinitions,
    sinks: {
      draft: async (_ws, p) => {
        handed.body = p.body;
        return { ok: true, itemId: null };
      },
    },
    warnItem: async () => {},
    now,
  });
  const loop = createLoop({ models, runs: agentRuns, fetchPage: async () => ({ ok: false, reason: "http_error", url: "" }), now, definitions: prospectingDefinitions, context: async () => [], accept });

  const scores: { name: string; problems: string[] }[] = [];
  for (let n = 1; n <= runs; n++) {
    for (const c of cases) {
      handed.body = undefined;
      const started = await agentRuns.start(W, { definition: agent, input: { text: c.text }, idempotencyKey: crypto.randomUUID(), trigger: "schedule" });
      await loop.execute((await agentRuns.wake({ workspaceId: W, runId: started.id }))!);
      const body = handed.body;
      const problems = c.score(body);
      if (body === undefined) {
        const ended = await inWorkspace(W, (tx) => readRun(tx, started.id));
        problems.push(`${ended?.status}: ${ended?.statusReason ?? "no reason"}`);
      }
      console.log(`${c.name} run ${n}: ${body === undefined ? "nothing" : show(body)}${problems.length ? `; ${problems.join("; ")}` : ""}`);
      scores.push({ name: c.name, problems });
    }
  }

  const bad = scores.filter((s) => s.problems.length);
  const result: EvalResult = {
    agent: agent.id,
    definitionVersion: agent.version,
    promptDigest: digestOf(agent.prompt),
    provider: candidate.provider,
    model: candidate.model,
    at: new Date().toISOString(),
    runs,
    passed: bad.length === 0,
    ...(bad.length && { why: `${bad.length} of ${scores.length} runs missed the bar: ${[...new Set(bad.flatMap((s) => s.problems))].slice(0, 5).join("; ")}` }),
    cases: cases.map((c) => {
      const mine = scores.filter((s) => s.name === c.name);
      return { name: c.name, passed: mine.every((s) => !s.problems.length), passes: mine.filter((s) => !s.problems.length).length };
    }),
    measures: { problemRuns: bad.length },
  };
  writeFileSync(join(RESULTS_DIR, resultFileOf(agent, candidate.provider, candidate.model)), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
