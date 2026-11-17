// SPDX-License-Identifier: AGPL-3.0-only
// A run's life, against real Postgres as the app role, with a clock the test moves. The queue is
// recorded rather than run: a job is only a wakeup, and each test delivers the ones it means to.
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { seedMember } from "../identity/fixtures/member";
import * as repo from "./adapters/repo";
import type { RunRow } from "./adapters/repo";
import { createRuns } from "./application/runs";
import { EXPIRE_AFTER_MS, LEASE_MS } from "./domain/caps";

const DEF = { id: "reader", version: 1, promptRevision: "r", prompt: "p", tools: ["fetch_page"], deadlineMs: 600_000, stepCap: 30 };
const START = new Date("2026-10-30T12:00:00Z");

let c: Awaited<ReturnType<typeof appClient>>;
let clock = START;
const sent: { payload: unknown; startAfter: Date }[] = [];
const told: string[] = [];
const boss = { send: async (_q: string, payload: unknown, o: { startAfter: Date }) => void sent.push({ payload, startAfter: o.startAfter }) } as unknown as PgBoss;
const runs = createRuns({ boss, now: () => clock, notify: async (run, what) => void told.push(`${run.id}:${what}`), warnItem: async () => {} });

beforeAll(async () => {
  c = await appClient();
});
afterAll(() => c.end());

async function workspace(userId: string = crypto.randomUUID()): Promise<string> {
  const id = crypto.randomUUID();
  await seedMember(id, userId);
  return id;
}

async function asApp(ws: string, text: string, params: unknown[] = []) {
  await c.query("begin");
  try {
    await c.query("select set_config('app.workspace_id', $1, true)", [ws]);
    const r = await c.query(text, params);
    await c.query("commit");
    return r.rows;
  } catch (e) {
    await c.query("rollback");
    throw e;
  }
}

const fresh = (ws: string, key: string = crypto.randomUUID(), def = DEF) => runs.start(ws, { definition: def, input: { url: "https://site.test" }, idempotencyKey: key, trigger: "person" });
const read = (ws: string, id: string) => repo.inWorkspace(ws, async (tx) => (await repo.readRun(tx, id))!);
const wake = (r: Pick<RunRow, "workspaceId" | "id">) => runs.wake({ workspaceId: r.workspaceId, runId: r.id });
const later = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const reset = () => {
  clock = START;
};

test("starting twice with one key is one run, and its job carries only the two ids", async () => {
  reset();
  sent.length = 0;
  const ws = await workspace();
  const a = await fresh(ws, "same");
  const b = await fresh(ws, "same");
  expect(b.id).toBe(a.id);
  expect(sent[0]!.payload).toEqual({ workspaceId: ws, runId: a.id });
});

test("a run started tainted is tainted before it reads anything, and the default is untainted", async () => {
  reset();
  const ws = await workspace();
  const asked = await runs.start(ws, { definition: DEF, input: { url: "https://site.test" }, idempotencyKey: crypto.randomUUID(), trigger: "person", tainted: true });
  expect(asked.tainted).toBe(true);
  const claimed = (await wake(asked))!;
  expect(await runs.runGate(ws, claimed.id, String(claimed.version))).toEqual({ live: true, tainted: true });
  expect((await fresh(ws)).tainted).toBe(false);
});

test("a job naming another Workspace's run does nothing", async () => {
  reset();
  const [ws, other] = [await workspace(), await workspace()];
  const run = await fresh(ws);
  expect(await runs.wake({ workspaceId: other, runId: run.id })).toBeNull();
  expect((await read(ws, run.id)).status).toBe("queued");
});

test("a claim sets the lease and deadline, and every change bumps the token", async () => {
  reset();
  const ws = await workspace();
  const run = await fresh(ws);
  const claimed = (await wake(run))!;
  expect(claimed.status).toBe("running");
  expect(claimed.version).toBe(run.version + 1);
  expect(claimed.leaseExpiresAt).toEqual(new Date(START.getTime() + LEASE_MS));
  expect(claimed.deadlineAt).toEqual(new Date(START.getTime() + DEF.deadlineMs));
});

test("two workers race for one run and one wins", async () => {
  reset();
  const ws = await workspace();
  const run = await fresh(ws);
  const results = await Promise.all([wake(run), wake(run), wake(run)]);
  expect(results.filter(Boolean)).toHaveLength(1);
});

test("a stale writer changes nothing, a forbidden move throws, and an ended run stays ended", async () => {
  reset();
  const ws = await workspace();
  const claimed = (await wake(await fresh(ws)))!;
  expect(await runs.end(claimed, claimed.version - 1, "succeeded")).toBeNull();
  expect((await read(ws, claimed.id)).status).toBe("running");
  await expect(repo.inWorkspace(ws, (tx) => repo.transition(tx, claimed.id, claimed.version, "expired", {}, clock))).rejects.toThrow(/can't move/);
  const ended = (await runs.end(claimed, claimed.version, "succeeded"))!;
  await expect(repo.inWorkspace(ws, (tx) => repo.transition(tx, ended.id, ended.version, "failed", { statusReason: "x" }, clock))).rejects.toThrow(/can't move/);
  expect(await wake(ended)).toBeNull();
});

test("a lapsed lease allows one reclaim on the same row, and a second lapse fails the run", async () => {
  reset();
  const ws = await workspace();
  const claimed = (await wake(await fresh(ws)))!;
  expect(await wake(claimed)).toBeNull();
  later(LEASE_MS);
  const again = (await wake(claimed))!;
  expect(again.id).toBe(claimed.id);
  expect(again).toMatchObject({ status: "running", attempt: 1, reclaims: 1 });
  expect(again.deadlineAt).toEqual(claimed.deadlineAt);
  later(LEASE_MS);
  expect(await wake(claimed)).toBeNull();
  expect(await read(ws, claimed.id)).toMatchObject({ status: "failed", statusReason: "lease_lapsed" });
});

test("a renewed lease keeps the run from being reclaimed", async () => {
  reset();
  const ws = await workspace();
  const claimed = (await wake(await fresh(ws)))!;
  later(LEASE_MS - 1);
  await repo.inWorkspace(ws, (tx) => repo.patchClaim(tx, claimed.id, claimed.version, { leaseExpiresAt: new Date(clock.getTime() + LEASE_MS) }));
  later(1);
  expect(await wake(claimed)).toBeNull();
  expect((await read(ws, claimed.id)).status).toBe("running");
});

test("a run past its deadline times out and tells who started it", async () => {
  reset();
  told.length = 0;
  const ws = await workspace();
  const claimed = (await wake(await fresh(ws)))!;
  later(DEF.deadlineMs);
  expect(await wake(claimed)).toBeNull();
  expect((await read(ws, claimed.id)).status).toBe("timed_out");
  await new Promise((r) => setTimeout(r, 0));
  expect(told).toContain(`${claimed.id}:capped`);
});

test("a run left queued for 7 days expires", async () => {
  reset();
  const ws = await workspace();
  await wake(await fresh(ws));
  await wake(await fresh(ws));
  const run = await fresh(ws);
  expect(await wake(run)).toBeNull();
  later(EXPIRE_AFTER_MS);
  expect(await wake(run)).toBeNull();
  expect((await read(ws, run.id)).status).toBe("expired");
});

test("a re-enqueued run waits for its start time, and past its deadline it times out", async () => {
  reset();
  const ws = await workspace();
  const claimed = (await wake(await fresh(ws)))!;
  await runs.requeue(claimed, claimed.version, new Date(clock.getTime() + 30_000), 1, 1);
  expect(await wake(claimed)).toBeNull();
  later(30_000);
  const back = (await wake(claimed))!;
  expect(back).toMatchObject({ status: "running", reclaims: 0, retries: 1, attempt: 1 });
  expect(back.deadlineAt).toEqual(claimed.deadlineAt);
  await runs.requeue(back, back.version, new Date(clock.getTime() + 30_000), 2, 2);
  later(DEF.deadlineMs);
  expect(await wake(back)).toBeNull();
  expect((await read(ws, back.id)).status).toBe("timed_out");
});

test("concurrency over the cap stays queued and starts when a slot frees", async () => {
  reset();
  const ws = await workspace();
  const a = (await wake(await fresh(ws)))!;
  await wake(await fresh(ws));
  const third = await fresh(ws);
  expect(await wake(third)).toBeNull();
  expect((await read(ws, third.id)).status).toBe("queued");
  sent.length = 0;
  await runs.end(a, a.version, "succeeded");
  expect(sent.map((s) => s.payload)).toContainEqual({ workspaceId: ws, runId: third.id });
  expect((await wake(third))!.status).toBe("running");
});

test("concurrent starts can't pass the cap", async () => {
  reset();
  const ws = await workspace();
  const made = await Promise.all(Array.from({ length: 6 }, () => fresh(ws)));
  const claimed = await Promise.all(made.map(wake));
  expect(claimed.filter(Boolean)).toHaveLength(2);
});

test("a spent daily cap waits on the same row, and resumes at the UTC reset with a fresh deadline", async () => {
  reset();
  told.length = 0;
  const ws = await workspace();
  await asApp(ws, `insert into agent_settings (workspace_id, agent, max_daily_runs, updated_at) values ($1, 'reader', 1, now())`, [ws]);
  const first = (await wake(await fresh(ws)))!;
  await runs.end(first, first.version, "succeeded");
  const second = await fresh(ws);
  expect(await wake(second)).toBeNull();
  expect(await read(ws, second.id)).toMatchObject({ status: "waiting", statusReason: "daily_cap" });
  await new Promise((r) => setTimeout(r, 0));
  expect(told).toContain(`${second.id}:waiting`);
  expect(await wake(second)).toBeNull();
  clock = new Date("2026-10-31T00:00:00Z");
  const resumed = (await wake(second))!;
  expect(resumed).toMatchObject({ id: second.id, status: "running" });
  expect(resumed.deadlineAt).toEqual(new Date(clock.getTime() + DEF.deadlineMs));
});

test("a reclaimed run doesn't count against the day twice", async () => {
  reset();
  const ws = await workspace();
  await asApp(ws, `insert into agent_settings (workspace_id, agent, max_daily_runs, updated_at) values ($1, 'reader', 1, now())`, [ws]);
  const claimed = (await wake(await fresh(ws)))!;
  later(LEASE_MS);
  expect((await wake(claimed))!.status).toBe("running");
});

test("a budget stop waits for the month to turn", async () => {
  reset();
  const ws = await workspace();
  const claimed = (await wake(await fresh(ws)))!;
  await runs.waitForBudget(claimed, claimed.version);
  expect(await read(ws, claimed.id)).toMatchObject({ status: "waiting", statusReason: "budget_stop" });
  clock = new Date("2026-10-31T00:00:00Z");
  expect(await wake(claimed)).toBeNull();
  expect((await read(ws, claimed.id)).status).toBe("waiting");
  clock = new Date("2026-11-01T00:00:00Z");
  expect((await wake(claimed))!.status).toBe("running");
});

test("only who started it or an Admin may cancel, and it writes its record in the same transaction", async () => {
  reset();
  const [starter, stranger, admin] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const ws = await workspace(starter);
  await workspace(admin);
  const run = await runs.start(ws, { definition: DEF, input: { url: "https://site.test" }, idempotencyKey: crypto.randomUUID(), startedBy: starter, trigger: "person" });
  expect(await runs.cancel(ws, run.id, { userId: stranger, admin: false })).toEqual({ ok: false, reason: "not_allowed" });
  expect((await read(ws, run.id)).status).toBe("queued");
  expect(await runs.cancel(ws, run.id, { userId: admin, admin: true }, "changed my mind")).toEqual({ ok: true });
  expect((await read(ws, run.id)).status).toBe("cancelled");
  const rows = await asApp(ws, "select source, who, reason from agent_cancellations where run_id = $1", [run.id]);
  expect(rows).toEqual([{ source: "admin", who: admin, reason: "changed my mind" }]);
  expect(await runs.cancel(ws, run.id, { userId: starter, admin: false })).toEqual({ ok: false, reason: "already_ended" });
  expect(await runs.cancel(ws, crypto.randomUUID(), { userId: admin, admin: true })).toEqual({ ok: false, reason: "not_found" });
});

test("the system can cancel with a closed source", async () => {
  reset();
  const ws = await workspace();
  const run = await fresh(ws);
  expect(await runs.cancel(ws, run.id, { source: "shutdown" })).toEqual({ ok: true });
});

test("the gate is live only for the current token of a running run", async () => {
  reset();
  const ws = await workspace();
  const claimed = (await wake(await fresh(ws)))!;
  expect(await runs.runGate(ws, claimed.id, String(claimed.version))).toEqual({ live: true, tainted: false });
  expect((await runs.runGate(ws, claimed.id, String(claimed.version - 1))).live).toBe(false);
  await runs.end(claimed, claimed.version, "succeeded");
  expect((await runs.runGate(ws, claimed.id, String(claimed.version))).live).toBe(false);
  expect(await runs.runGate(ws, crypto.randomUUID(), "1")).toEqual({ live: false, tainted: true });
});

test("pasted text is gone from the row once the run ends, and proposals from an unfinished run are marked", async () => {
  reset();
  const ws = await workspace();
  const run = await runs.start(ws, { definition: DEF, input: { text: "PLANTED-WORDS" }, idempotencyKey: crypto.randomUUID(), trigger: "person" });
  const claimed = (await wake(run))!;
  await asApp(ws, `insert into agent_proposals (workspace_id, run_id, output_key, kind, at) values ($1, $2, 'k', 'fact_proposal', now())`, [ws, run.id]);
  expect(JSON.stringify((await read(ws, run.id)).input)).toContain("PLANTED-WORDS");
  await runs.end(claimed, claimed.version, "step_capped");
  const ended = await read(ws, run.id);
  expect(JSON.stringify(ended.input)).not.toContain("PLANTED-WORDS");
  expect(ended.aggregateDigest).toBeTruthy();
  const proposals = await repo.inWorkspace(ws, (tx) => repo.proposalsOf(tx, run.id));
  expect(proposals[0]!.incomplete).toBe(true);
});
