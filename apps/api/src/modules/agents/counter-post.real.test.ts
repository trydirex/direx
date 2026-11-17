// SPDX-License-Identifier: AGPL-3.0-only
// The real counter-post eval. Only `bun run eval --purpose competitor_post --provider claude_code
// --runs N` runs it, on a Claude Code subscription token: the vitest config leaves *.real.test.ts out of
// every other run. Each case runs N times through the real loop with the competitors module's definition
// and Contoso's Facts, and is scored against POST_BAR; a draft Direx's checks refuse counts as refused.
// The result file it writes is what the competitor_post route's evalRef points at once it passes.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { expect, test } from "vitest";
import { counterPost } from "../competitors/index";
import { missesPostBar, POST_CASES, POST_FACTS, postCaseInput, scorePostRun, type CounterPost, type PostScore } from "../competitors/evals";
import { itemsWorld } from "../items/fixtures/items";
import { CHECK_CANDIDATES, createModels } from "../models/index";
import { testKeys } from "../models/fixtures/provider";
import { norm } from "../seo/index";
import { digestOf } from "./adapters/digest";
import { createLoop } from "./application/loop";
import { createProposals } from "./application/proposals";
import { createRuns } from "./application/runs";
import { eventsOf, inWorkspace, readRun } from "./adapters/repo";
import { POST_BAR, resultFileOf, RESULTS_DIR, type EvalResult } from "./index";

const provider = process.env.DIREX_EVAL_PROVIDER;
const runs = Number(process.env.DIREX_EVAL_RUNS ?? 5);
const secret = process.env.DIREX_EVAL_CLAUDE_CODE_TOKEN;

test("the counter-post meets POST_BAR on every case", { timeout: 6 * 3_600_000 }, async () => {
  if (provider !== "claude_code" || !secret || !(runs >= 1)) throw new Error("run through bun run eval --purpose competitor_post --provider claude_code --runs N");
  const candidate = { ...CHECK_CANDIDATES.claude_code, model: process.env.DIREX_EVAL_MODEL ?? CHECK_CANDIDATES.claude_code.model };
  const now = () => new Date();
  const definitions = { [counterPost.id]: counterPost as never };
  let handed: CounterPost | null = null;
  const agentRuns = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {} });
  const models = createModels({ deployment: "self_host", routes: { competitor_post: { candidates: [candidate] } }, keys: testKeys(secret, candidate.provider), runGate: agentRuns.runGate, now });
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
        handed = p.body as CounterPost;
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
    context: async () => POST_FACTS,
    accept,
  });

  const scores: PostScore[] = [];
  for (let n = 1; n <= runs; n++) {
    // A Workspace a pass: one Workspace's agent runs stop at DEFAULT_CAPS.agentDaily (100) a day.
    const { W } = await itemsWorld({ kinds: {} });
    for (const c of POST_CASES) {
      handed = null;
      lastReason = "";
      const started = await agentRuns.start(W, { definition: counterPost, input: { text: postCaseInput(c) }, idempotencyKey: crypto.randomUUID(), trigger: "schedule" });
      await loop.execute((await agentRuns.wake({ workspaceId: W, runId: started.id }))!);
      const got = handed as CounterPost | null;
      const score = scorePostRun(c, got, norm);
      scores.push(score);
      const why = !got ? `${await whyNothing(W, started.id)}${lastReason ? ` ${lastReason}` : ""}` : score.refused ? ` (refused: ${score.problems.join("; ")})` : "";
      console.log(`${c.id} run ${n}: ${score.hit ? "hit" : "miss"}${score.refused ? " refused" : ""} ${got?.text ?? ""} <${got?.theirs.join(" | ") ?? ""}> [${got?.citations.length ?? 0} Facts]${got?.cantTell ? `; cantTell: ${got.cantTell}` : ""}${got?.steered.length ? `; steered: ${got.steered.join(" | ")}` : ""}${why}`);
    }
  }

  const why = missesPostBar(scores, POST_BAR);
  const passed = why === null && POST_BAR.signedBy !== null;
  const result: EvalResult = {
    agent: counterPost.id,
    definitionVersion: counterPost.version,
    promptDigest: digestOf(counterPost.prompt),
    provider: candidate.provider,
    model: candidate.model,
    at: new Date().toISOString(),
    runs,
    passed,
    ...(!passed && { why: why ?? "POST_BAR is not signed" }),
    cases: POST_CASES.map((c) => {
      const mine = scores.filter((s) => s.id === c.id);
      const ok = (s: PostScore) => s.hit && !s.refused && !s.steeredMissed;
      return { name: c.id, passed: mine.every(ok), passes: mine.filter(ok).length };
    }),
    measures: { refusedRuns: scores.filter((s) => s.refused).length, steeredMissed: scores.filter((s) => s.steeredMissed).length },
  };
  writeFileSync(join(RESULTS_DIR, resultFileOf(counterPost, candidate.provider, candidate.model)), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  expect(result.passed).toBe(true);
});

/** How a run that handed nothing over ended, so a refused run says why in the log. */
async function whyNothing(W: string, runId: string): Promise<string> {
  const ended = await inWorkspace(W, (tx) => readRun(tx, runId));
  const calls = (await inWorkspace(W, (tx) => eventsOf(tx, runId))).filter((e) => e.kind === "model_call").map((e) => e.outcome);
  return ` (${ended?.status}: ${ended?.statusReason ?? "no reason"}; model calls: ${calls.join(", ") || "none"})`;
}
