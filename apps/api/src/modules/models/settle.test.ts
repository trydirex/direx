// SPDX-License-Identifier: AGPL-3.0-only
// What happens after a hold: incidents, the sweep of a call whose worker died, late answers.
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient, insertAuthUser } from "../../../../../test/db";
import { createBoss } from "../../jobs/boss";
import { withBudget } from "../ledger/index";
import { sendHoldWatch, workHoldWatch } from "./adapters/queue";
import type { Dispatch, DispatchResult } from "./adapters/sdk";
import type { Price } from "./domain/cost";
import type { Route } from "./domain/routes-check";
import { createModels } from "./index";
import { testKeys } from "./test-provider";


const NOW = new Date("2026-11-15T12:00:00Z");
const price: Price = { input: 3_000_000n, output: 15_000_000n, cacheRead: 0n, cacheWrite: 3_000_000n };
const ROUTES: Record<string, Route> = {
  plain: { candidates: [{ provider: "anthropic", model: "main-20260101", maxOutputTokens: 100, price, evalRef: "e" }] },
};
// 1,000 input and 100 output tokens: 4,500 micro-dollars.
const SUCCESS: DispatchResult = {
  ok: true,
  text: "OK",
  output: undefined,
  toolCalls: [],
  usage: { noCacheTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0 },
  resolvedModel: "m",
};

let c: Awaited<ReturnType<typeof appClient>>;
beforeAll(async () => {
  c = await appClient();
});
afterAll(() => c.end());

async function q(ws: string, text: string, params: unknown[] = []) {
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

async function newWorkspace(budget?: bigint) {
  const org = crypto.randomUUID();
  const ws = crypto.randomUUID();
  await q(ws, "insert into organizations (id, name, created_at) values ($1, 'O', now())", [org]);
  await q(ws, "insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())", [ws, org]);
  if (budget !== undefined) {
    const user = crypto.randomUUID();
    await insertAuthUser(user);
    await q(ws, "insert into model_settings_revisions (workspace_id, monthly_budget_micros, allow_unpriced, changed_by, created_at) values ($1, $2, false, $3, now())", [ws, budget.toString(), user]);
  }
  return ws;
}

const models = (dispatch: Dispatch, notify: { month: string; threshold: number }[] = [], over: Partial<Parameters<typeof createModels>[0]> = {}) =>
  createModels({
    deployment: "cloud",
    routes: ROUTES,
    keys: testKeys("k"),
    now: () => NOW,
    dispatch,
    notifyAdmins: async (_w, i) => void notify.push(i),
    ...over,
  });
const request = (ws: string) => ({
  workspaceId: ws,
  purpose: "plain",
  idempotencyKey: crypto.randomUUID(),
  parts: [{ role: "user" as const, kind: "definition", text: "hello" }],
});
const settledNow = (ws: string) => withBudget(ws, (b) => b.settled("model", NOW));

test("settled spend crossing 80% and then 100% opens one incident each and notifies once", async () => {
  const ws = await newWorkspace(10_000n);
  const notified: { month: string; threshold: number }[] = [];
  const m = models(async () => SUCCESS, notified);
  await m.generate(request(ws)); // 4,500
  expect(notified).toEqual([]);
  await m.generate(request(ws)); // 9,000, past 80%
  expect(notified).toEqual([{ month: "2026-11", threshold: 80 }]);
  expect(await q(ws, "select threshold from model_budget_incidents")).toEqual([{ threshold: 80 }]);
  // Staying past 80% opens nothing new; reaching the budget does.
  const spendSettled = (micros: bigint) => withBudget(ws, async (b) => b.settle(await b.hold("model", micros, NOW), micros, NOW));
  await spendSettled(500n);
  await m.generate(request(ws)).catch(() => {});
  expect(notified).toEqual([{ month: "2026-11", threshold: 80 }]);
});

test("reaching the budget opens the 100% incident", async () => {
  const ws = await newWorkspace(9_000n);
  const notified: { month: string; threshold: number }[] = [];
  const m = models(async () => SUCCESS, notified);
  await m.generate(request(ws)); // 4,500, past no threshold
  await m.generate(request(ws)); // 9,000, past both
  expect(notified.map((n) => n.threshold)).toEqual([80, 100]);
});

test("one settlement can cross both thresholds, and concurrent settlements notify once", async () => {
  const ws = await newWorkspace(4_000n);
  const notified: { month: string; threshold: number }[] = [];
  const wide = await newWorkspace(100_000n);
  const m = models(async () => SUCCESS, notified);
  await Promise.all(Array.from({ length: 22 }, () => m.generate(request(wide))));
  expect(notified.filter((n) => n.threshold === 80)).toHaveLength(1);
  expect(notified.filter((n) => n.threshold === 100)).toHaveLength(0);
  expect(await settledNow(wide)).toBe(99_000n);

  const one: { month: string; threshold: number }[] = [];
  await models(async () => SUCCESS, one).generate(request(ws));
  expect(one.map((n) => n.threshold)).toEqual([80, 100]);
});

test("a hold alone opens no incident", async () => {
  const ws = await newWorkspace(1_000n);
  await withBudget(ws, (b) => b.hold("model", 999n, NOW));
  expect(await q(ws, "select 1 from model_budget_incidents")).toEqual([]);
});

test("a failed notice does not lose the call's result", async () => {
  const ws = await newWorkspace(4_000n);
  const m = models(async () => SUCCESS, [], { notifyAdmins: async () => { throw new Error("smtp down"); } });
  expect(await m.generate(request(ws))).toMatchObject({ ok: true });
});

/** A dispatch that waits until the test lets it answer. */
function gated(answer: DispatchResult) {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const dispatch: Dispatch = async () => {
    started.resolve();
    await release.promise;
    return answer;
  };
  return { dispatch, started: started.promise, release: () => release.resolve() };
}

const onlyCall = async (ws: string) => (await q(ws, "select * from model_calls"))[0];

test("a call whose worker never came back is charged in full as unknown", async () => {
  const ws = await newWorkspace();
  const g = gated(SUCCESS);
  const m = models(g.dispatch);
  const pending = m.generate(request(ws));
  await g.started;
  const row = await onlyCall(ws);
  await m.settleAbandoned(ws, row.id);
  expect(await onlyCall(ws)).toMatchObject({ status: "failed", error_family: "no_receipt", cost_status: "unknown", cost_micros: "1512" });
  expect(await settledNow(ws)).toBe(1_512n);

  // The worker was only slow: its real receipt corrects the charge.
  g.release();
  expect(await pending).toMatchObject({ ok: true });
  expect(await onlyCall(ws)).toMatchObject({ status: "completed", error_family: null, cost_status: "estimated", cost_micros: "4500" });
  expect(await settledNow(ws)).toBe(4_500n);
});

test("a definite provider error arriving after the sweep undoes the charge", async () => {
  const ws = await newWorkspace();
  const g = gated({ ok: false, family: "transient_upstream", definite: true });
  const m = models(g.dispatch);
  const pending = m.generate(request(ws));
  await g.started;
  await m.settleAbandoned(ws, (await onlyCall(ws)).id);
  g.release();
  await pending;
  expect(await settledNow(ws)).toBe(0n);
  expect(await q(ws, "select status from budget_reservations")).toEqual([{ status: "released" }]);
});

test("the sweep changes nothing on a call that already has its outcome", async () => {
  const ws = await newWorkspace();
  const m = models(async () => SUCCESS);
  const r = await m.generate(request(ws));
  await m.settleAbandoned(ws, r.callId!);
  expect(await onlyCall(ws)).toMatchObject({ status: "completed", cost_micros: "4500" });
});

test("every dispatched call arranges its watch in the hold's transaction; a refusal arranges none", async () => {
  const ws = await newWorkspace(1n);
  const watched: { callId: string; at: Date }[] = [];
  const m = models(async () => SUCCESS, [], { watchHold: async (_tx, _w, callId, at) => void watched.push({ callId, at }) });
  expect(await m.generate(request(ws))).toMatchObject({ refusal: "budget_stop" });
  expect(watched).toEqual([]);
  const open = await newWorkspace();
  const r = await m.generate(request(open));
  expect(watched).toEqual([{ callId: r.callId, at: new Date(NOW.getTime() + 3_600_000) }]);
});

test("a watch job runs the sweep through the real queue, and only commits with its hold", async () => {
  const ws = await newWorkspace();
  const boss = createBoss();
  boss.on("error", () => {});
  await boss.start();
  try {
    const swept: string[] = [];
    await workHoldWatch(boss, async (_w, id) => void swept.push(id));
    const committed = crypto.randomUUID();
    const rolledBack = crypto.randomUUID();
    await withBudget(ws, (b) => sendHoldWatch(boss, b.tx, { workspaceId: ws, callId: committed }, new Date()));
    await withBudget(ws, async (b) => {
      await sendHoldWatch(boss, b.tx, { workspaceId: ws, callId: rolledBack }, new Date());
      throw new Error("roll back");
    }).catch(() => {});
    await expect.poll(() => swept, { timeout: 15_000, interval: 200 }).toContain(committed);
    expect(swept).not.toContain(rolledBack);
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
}, 30_000);
