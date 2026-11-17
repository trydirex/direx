// SPDX-License-Identifier: AGPL-3.0-only
// The real campaign_drafter and social_drafter evals. Only `bun run eval --purpose campaign_draft|social_draft
// --provider claude_code --runs N` runs one: the vitest config leaves *.real.test.ts out of every other run.
// Each case runs N times through the real loop, briefed as the campaigns module briefs a step (date, Facts,
// plan), and every run must keep the copy rules code can check. Whether the copy is good is a person's read,
// so every run's copy goes to a file in the temp folder for them; the result holds only names and counts.
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { expect, test } from "vitest";
import { campaignDefinitions, campaignDrafter, socialDrafter } from "../campaigns/index";
import { COPY_CASES, copyFactId, scoreCopyRun, type CopyOutput } from "../campaigns/evals";
import { itemsWorld } from "../items/fixtures/items";
import { CHECK_CANDIDATES, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { digestOf } from "./adapters/digest";
import { inWorkspace, readRun } from "./adapters/repo";
import { createLoop } from "./application/loop";
import { createProposals } from "./application/proposals";
import { createRuns, type DraftInput } from "./application/runs";
import { resultFileOf, RESULTS_DIR, type EvalResult } from "./index";

const AGENTS = { campaign_draft: campaignDrafter, social_draft: socialDrafter } as const;
const purpose = process.env.DIREX_EVAL_PURPOSE as keyof typeof AGENTS | undefined;
const provider = process.env.DIREX_EVAL_PROVIDER;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 5);
const secret = process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN;

test("a campaign drafter keeps the copy rules on every run", { timeout: 6 * 3_600_000 }, async () => {
  if (!purpose || !(purpose in AGENTS) || provider !== "claude_code" || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose campaign_draft|social_draft --provider claude_code --runs N");
  const agent = AGENTS[purpose];
  const cases = COPY_CASES.filter((c) => c.agent === agent.id);
  const candidate = { ...CHECK_CANDIDATES.claude_code, ...(process.env.DIREX_EVAL_MODEL && { model: process.env.DIREX_EVAL_MODEL }) };
  const { W } = await itemsWorld({ kinds: {} });
  const now = () => new Date();
  const handed: { body?: CopyOutput } = {};
  const agentRuns = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
  const models = createModels({ deployment: "self_host", routes: { campaign_draft: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider), runGate: agentRuns.runGate, now });
  const accept = createProposals({
    definitions: campaignDefinitions,
    sinks: {
      draft: async (_ws, p) => {
        handed.body = p.body as CopyOutput;
        return { ok: true, itemId: null };
      },
    },
    warnItem: async () => {},
    now,
  });

  const scores: { name: string; problems: string[] }[] = [];
  const samples: string[] = [];
  for (let n = 1; n <= runs; n++) {
    for (const c of cases) {
      const usable = c.facts.map((f, i) => ({ id: copyFactId(i), version: 1, text: f }));
      const loop = createLoop({ models, runs: agentRuns, fetchPage: async () => ({ ok: false, reason: "http_error", url: "" }), now, definitions: campaignDefinitions, context: async () => usable, accept });
      const input: DraftInput = {
        request: c.request,
        brief: [
          { kind: "date", refId: "today", version: null, text: `Today is ${now().toISOString().slice(0, 10)}.` },
          { kind: "citable_facts", refId: "usable_facts", version: null, text: `Facts you may cite, by id and version:\n${usable.map((f) => `${f.id} version 1: ${f.text}`).join("\n")}` },
          { kind: "plan", refId: crypto.randomUUID(), version: "1", text: `The plan:\n${JSON.stringify(c.plan)}` },
        ],
        target: { id: crypto.randomUUID(), draftRevision: 0 },
      };
      handed.body = undefined;
      const started = await agentRuns.start(W, { definition: agent, input, idempotencyKey: crypto.randomUUID(), trigger: "person" });
      await loop.execute((await agentRuns.wake({ workspaceId: W, runId: started.id }))!);
      // Set by the sink during the run, which the type checker can't see.
      const body = handed.body as CopyOutput | undefined;
      const problems = scoreCopyRun(c, body ?? null);
      if (!body) {
        const ended = await inWorkspace(W, (tx) => readRun(tx, started.id));
        problems.push(`${ended?.status}: ${ended?.statusReason ?? "no reason"}`);
      }
      if (problems.length) console.log(`${c.name} run ${n}: ${problems.join("; ")}`);
      scores.push({ name: c.name, problems });
      if (body) samples.push(`## ${c.name}, run ${n}${problems.length ? ` (problems: ${problems.join("; ")})` : ""}\n\n${body.subject ? `Subject: ${body.subject}\n\n` : ""}${body.text}\n\nCites: ${body.citations.map((x) => x.factId.slice(-2)).join(", ") || "nothing"}`);
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
  const sampleFile = join(tmpdir(), `direx-${agent.id}-samples.md`);
  writeFileSync(sampleFile, `# ${agent.id} on ${candidate.model}, for a person to read\n\n${samples.join("\n\n")}\n`);
  console.log(`samples: ${sampleFile}`);
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});
