// SPDX-License-Identifier: AGPL-3.0-only
// A real worker process, reached through the real queue, killed mid-run. And the real startWorker,
// to prove its wiring: without a live gate into models, a run would never leave running.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { createBoss } from "../../jobs/boss";
import { testWorker } from "../../compose/fixtures/worker";
import { vaultFromEnv } from "../credentials/index";
import { createFacts, factKinds } from "../facts";
import { seedMember } from "../identity/fixtures/member";
import { itemsWorld } from "../items/fixtures/items";
import { createModels } from "../models/index";
import { anthropicTool, fakeProvider, testKeys } from "../models/fixtures/provider";
import * as repo from "./adapters/repo";
import { createLoop } from "./application/loop";
import { createProposals, INCOMPLETE_WARNING } from "./application/proposals";
import { createRuns } from "./application/runs";
import type { AgentDefinition } from "./definitions/define";
import { brandReader } from "./definitions/brand-reader";
import { LEASE_MS } from "./domain/caps";
import { factSink } from "./index";

const fake = fakeProvider();
const boss = createBoss();
await boss.start();
await boss.createQueue("agents.run");
afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await fake.stop();
});

const { W, items } = await itemsWorld({ kinds: factKinds() });
const facts = createFacts({ items: () => items });
const definitions = { brand_reader: brandReader as unknown as AgentDefinition<never> };
const warnItem = (ws: string, id: string) => items.addWarning(ws, id, { code: "run_incomplete", text: INCOMPLETE_WARNING });
let shift = 0;
const now = () => new Date(Date.now() + shift);
const runs = createRuns({ boss, now, notify: async () => {}, warnItem });
const models = createModels({ deployment: "self_host", keys: testKeys("sk-test"), baseURLs: { anthropic: fake.url }, runGate: runs.runGate, now });
const loop = createLoop({
  models,
  runs,
  now,
  definitions,
  context: async () => [],
  fetchPage: async (_b, url) => ({ ok: true, url, text: "We sell audits.", truncated: false }),
  accept: createProposals({ definitions, sinks: { fact_proposal: factSink(facts) }, warnItem, now }),
});

test("SIGKILL after the first hand-over: the run is reclaimed once, loses nothing and repeats no Item", { timeout: 40_000 }, async () => {
  const SITE = "https://shop.test/";
  const list = [
    { field: "claim", value: `First ${crypto.randomUUID()}`, confidence: "high", page: SITE },
    { field: "claim", value: `Second ${crypto.randomUUID()}`, confidence: "high", page: SITE },
  ];
  let n = 0;
  fake.respondWith(() => (n++ % 2 === 0 ? anthropicTool("fetch_page", { url: SITE }) : anthropicTool("propose", { facts: list })));

  const marker = join(mkdtempSync(join(tmpdir(), "direx-agent-kill-")), "item");
  const started = await runs.start(W, { definition: brandReader, input: { url: SITE }, idempotencyKey: crypto.randomUUID(), trigger: "person" });
  const worker = Bun.spawn([process.execPath, join(import.meta.dirname, "fixtures", "kill-worker.ts")], {
    env: { ...process.env, MARKER: marker, PROVIDER_URL: fake.url },
    stdout: "ignore",
    stderr: "inherit",
  });
  await expect.poll(() => existsSync(marker), { timeout: 25_000, interval: 100 }).toBe(true);
  worker.kill("SIGKILL");
  await worker.exited;

  const firstItem = readFileSync(marker, "utf8");
  const row = () => repo.inWorkspace(W, async (tx) => (await repo.readRun(tx, started.id))!);
  expect(await row()).toMatchObject({ status: "running", reclaims: 0, tainted: true });
  expect((await repo.inWorkspace(W, (tx) => repo.proposalsOf(tx, started.id))).map((p) => p.itemId)).toEqual([null]);

  // A restarted worker, after the lease lapses.
  shift = LEASE_MS + 1_000;
  const reclaimed = (await runs.wake({ workspaceId: W, runId: started.id }))!;
  expect(reclaimed).toMatchObject({ id: started.id, status: "running", reclaims: 1 });
  await loop.execute(reclaimed);

  expect((await row()).status).toBe("succeeded");
  const made = await repo.inWorkspace(W, (tx) => repo.proposalsOf(tx, started.id));
  expect(made).toHaveLength(2);
  expect(made.map((p) => p.itemId)).toContain(firstItem);
  expect(new Set(made.map((p) => p.itemId)).size).toBe(2);
});

test("the real worker's wiring takes a run through the queue to a result", { timeout: 30_000 }, async () => {
  const ws = crypto.randomUUID();
  const userId = crypto.randomUUID();
  await seedMember(ws, userId);
  process.env.DIREX_MASTER_KEY = "11".repeat(32);
  const w = await testWorker({ vault: vaultFromEnv({ baseURL: "http://localhost:3000" }), mailer: async () => {} });
  try {
    const r = await w.agents!.start(ws, { input: { text: "About us" }, startedBy: userId });
    if (!r.ok) throw new Error(r.reason);
    // No key is connected, so a live claim reaches models and fails for that reason.
    const row = () => repo.inWorkspace(ws, async (tx) => (await repo.readRun(tx, r.run.id))!);
    await expect.poll(async () => (await row()).status, { timeout: 20_000, interval: 200 }).toBe("failed");
    expect((await row()).statusReason).not.toBe("stale_claim");
  } finally {
    await w.stop();
  }
});
