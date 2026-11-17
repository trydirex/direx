// SPDX-License-Identifier: AGPL-3.0-only
// The real change classifier eval. Only `bun run eval --purpose competitor_change --provider claude_code
// --runs N` runs it, on a Claude Code subscription token: the vitest config leaves *.real.test.ts out of
// every other run. Each case's week of Changes runs N times through the real loop with the competitors
// module's definition and Contoso's Facts, and is scored against CHANGE_BAR. The result file it writes
// is what the competitor_change route's evalRef points at once it passes.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { expect, test } from "vitest";
import { changeClassifier } from "../competitors/index";
import { CHANGE_CASES, CONTOSO_FACTS, labelInput, labelsProblem, missesChangeBar, scoreChangeRun, type ChangeCase, type ChangeScore, type LabelOut } from "../competitors/evals";
import { itemsWorld } from "../items/fixtures/items";
import { CHECK_CANDIDATES, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { digestOf } from "./adapters/digest";
import { createLoop } from "./application/loop";
import { createProposals } from "./application/proposals";
import { createRuns } from "./application/runs";
import { eventsOf, inWorkspace, readRun } from "./adapters/repo";
import { CHANGE_BAR, resultFileOf, RESULTS_DIR, type EvalResult } from "./index";

const provider = process.env.DIREX_EVAL_PROVIDER;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 5);
const secret = process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN;
type Handed = { labels: LabelOut[]; steered: string[] };

test("the change classifier meets CHANGE_BAR on every settled case", { timeout: 6 * 3_600_000 }, async () => {
  if (provider !== "claude_code" || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose competitor_change --provider claude_code --runs N");
  // --model tries another Claude Code model; the result file names the model it ran on.
  const candidate = { ...CHECK_CANDIDATES.claude_code, model: process.env.DIREX_EVAL_MODEL ?? CHECK_CANDIDATES.claude_code.model };
  const now = () => new Date();
  const definitions = { [changeClassifier.id]: changeClassifier as never };
  let handed: Handed | null = null;
  const agentRuns = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
  const models = createModels({ deployment: "self_host", routes: { competitor_change: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider), runGate: agentRuns.runGate, now });
  // The loop records only the error family; the reason (which field missed the schema, never the
  // model's words) is what says what to fix, so the eval keeps the last one.
  let lastReason = "";
  const generate: typeof models.generate = async (req) => {
    const r = await models.generate(req);
    if (!r.ok) lastReason = "reason" in r && r.reason ? r.reason : "";
    return r;
  };
  const accept = createProposals({
    definitions,
    sinks: {
      draft: async (_ws, p) => {
        handed = p.body as Handed;
        return { ok: true, itemId: null };
      },
    },
    warnItem: async () => {},
    now,
  });
  const loop = createLoop({
    models: { ...models, generate },
    runs: agentRuns,
    fetchPage: async () => ({ ok: false, reason: "http_error", url: "" }),
    now,
    definitions,
    context: async () => CONTOSO_FACTS.map((text, i) => ({ id: `7c1e4b20-3a5d-4f6e-8b9c-0d1e2f3a4b${String(i).padStart(2, "0")}`, version: 1, text })),
    accept,
  });

  const scores: ChangeScore[] = [];
  for (let n = 1; n <= runs; n++) {
    // A Workspace a pass: one Workspace's agent runs stop at DEFAULT_CAPS.agentDaily (100) a day.
    const { W } = await itemsWorld({ kinds: {} });
    for (const c of CHANGE_CASES as ChangeCase[]) {
      handed = null;
      lastReason = "";
      const input = { text: labelInput(c.week, c.earlier), asOf: now().toISOString() };
      const started = await agentRuns.start(W, { definition: changeClassifier, input, idempotencyKey: crypto.randomUUID(), trigger: "schedule" });
      await loop.execute((await agentRuns.wake({ workspaceId: W, runId: started.id }))!);
      const got = handed as Handed | null;
      // What Direx's sink would refuse counts as refused, the same as no output.
      const problem = got ? labelsProblem(got.labels, c.week, c.earlier) : "no output";
      const score = scoreChangeRun(c, problem ? null : got!.labels, got?.steered ?? []);
      scores.push(score);
      const why = problem && !got ? `${await whyNothing(W, started.id)}${lastReason ? ` ${lastReason}` : ""}` : "";
      const labels = got?.labels.map((l) => `${l.changeId}=${l.label}${l.kind ? `/${l.kind}` : ""}${l.sameAs ? `>${l.sameAs}` : ""}`).join(" ") ?? "";
      console.log(`${c.id} run ${n}: ${labels}${problem ? `; refused: ${problem}${why}` : ""}${got?.steered.length ? `; steered: ${got.steered.join(" | ")}` : ""}`);
    }
  }

  const why = missesChangeBar(scores, CHANGE_BAR);
  const passed = why === null && CHANGE_BAR.signedBy !== null;
  const noise = scores.reduce((n, s) => n + s.noise, 0);
  const result: EvalResult = {
    agent: changeClassifier.id,
    definitionVersion: changeClassifier.version,
    promptDigest: digestOf(changeClassifier.prompt),
    provider: candidate.provider,
    model: candidate.model,
    at: new Date().toISOString(),
    runs,
    passed,
    ...(!passed && { why: why ?? "CHANGE_BAR is not signed" }),
    cases: CHANGE_CASES.map((c) => {
      const mine = scores.filter((s) => s.id === c.id);
      const ok = (s: ChangeScore) => !s.refused && !s.steeredMissed && s.falseAnswers === 0 && s.answers.every((a) => a.hit && a.kindHit) && s.mergeHit !== false;
      return { name: c.id, passed: mine.every(ok), passes: mine.filter(ok).length };
    }),
    measures: { falseAnswerRate: noise ? scores.reduce((n, s) => n + s.falseAnswers, 0) / noise : 0, refusedRuns: scores.filter((s) => s.refused).length, steeredMissed: scores.filter((s) => s.steeredMissed).length },
  };
  writeFileSync(join(RESULTS_DIR, resultFileOf(changeClassifier, candidate.provider, candidate.model)), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});

/** How a run that handed nothing over ended, so a refused run says why in the log. */
async function whyNothing(W: string, runId: string): Promise<string> {
  const ended = await inWorkspace(W, (tx) => readRun(tx, runId));
  const calls = (await inWorkspace(W, (tx) => eventsOf(tx, runId))).filter((e) => e.kind === "model_call").map((e) => e.outcome);
  return ` (${ended?.status}: ${ended?.statusReason ?? "no reason"}; model calls: ${calls.join(", ") || "none"})`;
}
