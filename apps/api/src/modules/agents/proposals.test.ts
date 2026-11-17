// SPDX-License-Identifier: AGPL-3.0-only
// Recording and handing over proposals, with a fake sink.
import type { PgBoss } from "pg-boss";
import { expect, test } from "vitest";
import { z } from "zod";
import { seedMember } from "../identity/fixtures/member";
import * as repo from "./adapters/repo";
import { createProposals, sinkByOutputKey, type Sink } from "./application/proposals";
import { createRuns } from "./application/runs";
import { defineAgent, type AgentDefinition, type ProposalKind } from "./definitions/define";

const definition = defineAgent({
  id: "reader",
  version: 1,
  promptRevision: "r",
  prompt: "p",
  purposes: ["extract"],
  tools: [],
  deadlineMs: 60_000,
  stepCap: 8,
  output: z.strictObject({ keys: z.array(z.string()) }),
  context: [],
  proposals: (o) => o.keys.map((k) => ({ kind: (k.startsWith("rule") ? "rule_proposal" : "fact_proposal") as ProposalKind, outputKey: k, body: { k } })),
}) as unknown as AgentDefinition<never>;

function harness(sink: Sink) {
  const warned: string[] = [];
  const warnItem = async (_w: string, id: string) => void warned.push(id);
  const now = () => new Date();
  const runs = createRuns({ boss: { send: async () => {} } as unknown as PgBoss, now, notify: async () => {}, warnItem });
  const accept = createProposals({ definitions: { reader: definition }, sinks: { fact_proposal: sink }, warnItem, now });
  const go = async () => {
    const ws = crypto.randomUUID();
    await seedMember(ws, crypto.randomUUID());
    const started = await runs.start(ws, { definition, input: { text: "x" }, idempotencyKey: crypto.randomUUID(), trigger: "person" });
    return { ws, run: (await runs.wake({ workspaceId: ws, runId: started.id }))! };
  };
  return { accept, go, runs, warned };
}

const itemSink = (calls: string[]): Sink => async (_w, p) => {
  calls.push(p.outputKey);
  return { ok: true, itemId: crypto.randomUUID() };
};
const rows = (ws: string, id: string) => repo.inWorkspace(ws, (tx) => repo.proposalsOf(tx, id));
const events = (ws: string, id: string) => repo.inWorkspace(ws, (tx) => repo.eventsOf(tx, id));

test("each proposal is handed over once, with its Item and one event", async () => {
  const calls: string[] = [];
  const h = harness(itemSink(calls));
  const { ws, run } = await h.go();
  await h.accept(run, run.version, { keys: ["a", "b"] }, "route");
  expect(calls).toEqual(["a", "b"]);
  const made = await rows(ws, run.id);
  expect(made.every((p) => p.itemId && p.routeHash === "route" && !p.incomplete)).toBe(true);
  expect((await events(ws, run.id)).map((e) => [e.kind, e.name, e.outcome])).toEqual([
    ["proposal", "fact_proposal", "ok"],
    ["proposal", "fact_proposal", "ok"],
  ]);
});

test("a crash between record and hand-over is finished by the retry, and what was settled isn't handed over again", async () => {
  const calls: string[] = [];
  let crash = true;
  const h = harness(async (_w, p) => {
    if (p.outputKey === "b" && crash) {
      crash = false;
      throw new Error("worker died");
    }
    calls.push(p.outputKey);
    return { ok: true, itemId: crypto.randomUUID() };
  });
  const { ws, run } = await h.go();
  await expect(h.accept(run, run.version, { keys: ["a", "b"] }, "route")).rejects.toThrow("worker died");
  expect((await rows(ws, run.id)).find((p) => p.outputKey === "b")).toMatchObject({ itemId: null, rejectionCode: null });
  await h.accept(run, run.version, { keys: ["a", "b"] }, "route");
  expect(calls).toEqual(["a", "b"]);
  expect((await rows(ws, run.id)).every((p) => p.itemId)).toBe(true);
});

test("a run that has ended accepts no more, and what it made is marked and warned", async () => {
  const calls: string[] = [];
  const h = harness(itemSink(calls));
  const { ws, run } = await h.go();
  await h.accept(run, run.version, { keys: ["a"] }, "route");
  const ended = (await h.runs.end(run, run.version, "step_capped"))!;
  const [made] = await rows(ws, run.id);
  expect(made!.incomplete).toBe(true);
  expect(h.warned).toEqual([made!.itemId]);

  await h.accept(ended, ended.version, { keys: ["b"] }, "route");
  await h.accept(run, run.version, { keys: ["c"] }, "route");
  expect(calls).toEqual(["a"]);
  expect(await rows(ws, run.id)).toHaveLength(1);
});

test("a run that succeeds warns nothing", async () => {
  const h = harness(itemSink([]));
  const { run } = await h.go();
  await h.accept(run, run.version, { keys: ["a"] }, "route");
  await h.runs.end(run, run.version, "succeeded");
  expect(h.warned).toEqual([]);
});

test("a run cancelled during a hand-over still warns the Item that hand-over made", async () => {
  const item = crypto.randomUUID();
  let ws = "";
  let runId = "";
  const h: ReturnType<typeof harness> = harness(async () => {
    await h.runs.cancel(ws, runId, { source: "shutdown" });
    return { ok: true, itemId: item };
  });
  const got = await h.go();
  ws = got.ws;
  runId = got.run.id;
  await h.accept(got.run, got.run.version, { keys: ["a", "b"] }, "route");
  expect(h.warned).toEqual([item]);
  expect((await rows(ws, runId)).map((p) => [p.outputKey, p.itemId, p.incomplete])).toEqual([["a", item, true]]);
});

test("a kind with no sink, and a sink's refusal, record a code and make no Item", async () => {
  const h = harness(async () => ({ ok: false, code: "blank_value" }));
  const { ws, run } = await h.go();
  await h.accept(run, run.version, { keys: ["rule-1", "a"] }, "route");
  const made = await rows(ws, run.id);
  expect(made.map((p) => [p.outputKey, p.itemId, p.rejectionCode]).sort()).toEqual([
    ["a", null, "blank_value"],
    ["rule-1", null, "no_sink"],
  ]);
  expect((await events(ws, run.id)).map((e) => [e.kind, e.outcome])).toEqual([
    ["rejection", "no_sink"],
    ["rejection", "blank_value"],
  ]);
});

test("a key that comes twice in one output counts once and is recorded", async () => {
  const calls: string[] = [];
  const h = harness(itemSink(calls));
  const { ws, run } = await h.go();
  await h.accept(run, run.version, { keys: ["a", "a"] }, "route");
  expect(calls).toEqual(["a"]);
  expect((await events(ws, run.id)).map((e) => e.outcome)).toEqual(["ok", "duplicate_key"]);
});

test("draft sinks by output key: each key reaches its own module, an unknown key is refused, and two owners of one key fail at startup", async () => {
  const seen: string[] = [];
  const to = (name: string): Sink => async () => (seen.push(name), { ok: true, itemId: null });
  const draft = sinkByOutputKey({ names_read: to("prospecting") }, { template: to("campaigns") });
  const proposal = (outputKey: string) => ({ kind: "draft" as const, outputKey, body: {} });
  const context = {} as Parameters<Sink>[2];
  expect(await draft("w", proposal("template"), context)).toEqual({ ok: true, itemId: null });
  expect(await draft("w", proposal("names_read"), context)).toEqual({ ok: true, itemId: null });
  expect(seen).toEqual(["campaigns", "prospecting"]);
  expect(await draft("w", proposal("something_new"), context)).toEqual({ ok: false, code: "no_sink" });
  expect(() => sinkByOutputKey({ template: to("a") }, { template: to("b") })).toThrow("two sinks for the output key template");
});
