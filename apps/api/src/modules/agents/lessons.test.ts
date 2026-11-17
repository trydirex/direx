// SPDX-License-Identifier: AGPL-3.0-only
// What a run carries from the lessons module: its own Agent's accepted lessons as trusted parts, fixed
// at the first claim, and a paused run stopped when one of them is withdrawn.
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { appClient } from "../../../../../test/db";
import { factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import type { Items } from "../items/index";
import { createLessons } from "../lessons/index";
import type { Models } from "../models/index";
import * as runRepo from "./adapters/repo";
import { createLoop } from "./application/loop";
import { createRuns } from "./application/runs";
import { defineAgent, type AgentDefinition } from "./definitions/define";

const generate = (async () => ({ ok: true, callId: crypto.randomUUID(), routeHash: "r", output: { schemaVersion: 1, verdict: "clean", reasons: [] } })) as unknown as Models["generate"];
const warned: string[][] = [];
const late: { items?: Items } = {};
const now = () => new Date();
const lessons = createLessons({
  items: () => late.items!,
  generate: () => generate,
  checkOpen: () => true,
  suspendRules: async () => 0,
  warnDrafts: async (_ws, runIds) => void warned.push([...runIds]),
  applyFact: factKinds(now).fact_proposal!.apply,
  liveFacts: async () => [],
  now,
});
const w = await itemsWorld({ kinds: lessons.kinds() });
late.items = w.items;
const { W, items } = w;
const who = { ...w.who, steppedUp: true };
const userId = person.userId;

let c: Awaited<ReturnType<typeof appClient>>;
beforeAll(async () => {
  c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});
afterAll(async () => {
  await c.end();
});

const accepted = async (text: string, agent: string) => {
  const r = await lessons.propose(W, { agent, text, sourceRef: null, definitionVersion: null, userId });
  if (!r.ok) throw new Error(r.reason);
  const a = await items.approve(W, r.item.id, r.item.revision, who);
  if (!a.ok) throw new Error(a.reason);
  return (await lessons.list(W, agent)).find((l) => l.text === text)!;
};

const definition = defineAgent({ id: "lesson_reader", version: 1, promptRevision: "r", prompt: "You draft.", purposes: ["extract"], tools: [], deadlineMs: 60_000, stepCap: 4, output: z.strictObject({}), context: [], proposals: () => [] }) as unknown as AgentDefinition<never>;

test("a run carries its own Agent's lessons as trusted parts, fixed at the first claim, and a paused run stops if one is withdrawn", async () => {
  const mine = await accepted("Lesson readers keep it short.", definition.id);
  await accepted("Someone else's lesson.", "recipient_writer");
  const boss = { send: async () => {} } as unknown as PgBoss;
  const port = { fix: lessons.fix, carried: lessons.carried, withdrawn: lessons.withdrawn };
  const runs = createRuns({ boss, now, notify: async () => {}, warnItem: async () => {}, lessons: port });
  // The model asks for a budget pause, so the run is recorded and then waits.
  const models = { generate: async () => ({ ok: false, callId: null, refusal: "budget_stop" }) } as unknown as Pick<Models, "generate">;
  const loop = createLoop({ models, runs, fetchPage: async () => ({ ok: false, reason: "http_error", url: "" }), now, definitions: { [definition.id]: definition }, context: async () => [], lessons: port, accept: async () => {}, sleep: async () => {} });

  const started = await runs.start(W, { definition, input: { text: "x" }, idempotencyKey: crypto.randomUUID(), trigger: "person" });
  const claimed = (await runs.wake({ workspaceId: W, runId: started.id }))!;
  // Accepted after the first claim, so this run never carries it.
  await accepted("Lesson readers sign with a first name.", definition.id);
  await loop.execute(claimed);

  const { rows: parts } = await c.query("select kind, ref_id, version, trust from agent_run_parts where run_id = $1 and kind = 'agent_lesson'", [started.id]);
  expect(parts).toEqual([{ kind: "agent_lesson", ref_id: mine.id, version: "1", trust: "trusted" }]);
  const run = await runRepo.inWorkspace(W, async (tx) => (await runRepo.readRun(tx, started.id))!);
  expect(run.status).toBe("waiting");
  expect(run.lessonDigest).toMatch(/^[0-9a-f]{64}$/);

  // Retired during the wait: the run doesn't carry on with it.
  expect(await lessons.retire(W, { lessonId: mine.id, version: 1, userId })).toEqual({ ok: true });
  expect(warned.at(-1)).toEqual([started.id]);
  await c.query("update agent_runs set resume_at = null where id = $1", [started.id]);
  expect(await runs.wake({ workspaceId: W, runId: started.id })).toBeNull();
  const ended = await runRepo.inWorkspace(W, async (tx) => (await runRepo.readRun(tx, started.id))!);
  expect([ended.status, ended.statusReason]).toEqual(["refused", "lesson_withdrawn"]);
  expect(await runRepo.inWorkspace(W, (tx) => lessons.withdrawn(tx, started.id))).toBe(true);
});

test("a run with no lessons carries none and records the empty digest", async () => {
  const lonely = { ...definition, id: "lonely_reader" } as AgentDefinition<never>;
  const runs = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem: async () => {}, lessons: { fix: lessons.fix, carried: lessons.carried, withdrawn: lessons.withdrawn } });
  const started = await runs.start(W, { definition: lonely, input: { text: "x" }, idempotencyKey: crypto.randomUUID(), trigger: "person" });
  await runs.wake({ workspaceId: W, runId: started.id });
  const run = await runRepo.inWorkspace(W, async (tx) => (await runRepo.readRun(tx, started.id))!);
  expect(run.lessonDigest).toBe("");
  expect(await lessons.carried(W, started.id)).toEqual([]);
});

