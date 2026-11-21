// SPDX-License-Identifier: AGPL-3.0-only
// Operator holds: whoever runs this Direx holds a Workspace, an Organization or the deployment, and
// the Dispatcher holds their due Actions as operator_hold before any key is fetched or any plugin is
// called. A hold committed after the claim still stops the send at the dispatch check. Lifting it
// resumes what it held through every check, and nothing a member does lifts it.
import { afterAll, expect, test } from "vitest";
import type { EffectCapability } from "@direx/plugin-sdk";
import { appClient, ownerClient } from "../../../../../test/db";
import { oneKey } from "./index";
import { fakeEffect, scheduledAction, testKey, testLedger } from "./test-effects";

const effects: Record<string, EffectCapability> = {};
// Which Workspaces' keys were fetched: a held Action must never fetch them.
const keysFetched: string[] = [];
const keys = oneKey(testKey);
// Test seams, run once the claim commits and as keys are fetched (after a pass's first hold read,
// before its row lock). One test sets a hold there, so only the dispatch check under the lock sees it.
let afterClaim: (() => Promise<void>) | undefined;
let onKeys: (() => Promise<void>) | undefined;
const { ledger } = await testLedger({
  effects,
  signingKeys: async (ws) => {
    keysFetched.push(ws);
    await onKeys?.();
    return keys(ws);
  },
  onStep: async (step) => {
    if (step === "claim") await afterClaim?.();
  },
});

const db = await ownerClient();
afterAll(() => db.end());
const q = async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows;

async function asApp(ws: string, text: string, values: unknown[] = []) {
  const c = await appClient();
  try {
    await c.query("begin");
    await c.query("select set_config('app.workspace_id', $1, true)", [ws]);
    const { rows } = await c.query(text, values);
    await c.query("commit");
    return rows;
  } finally {
    await c.end();
  }
}

async function newWorkspace(org = crypto.randomUUID()) {
  const ws = crypto.randomUUID();
  await asApp(ws, "insert into organizations (id, name, created_at) values ($1, 'O', now()) on conflict do nothing", [org]);
  await asApp(ws, "insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())", [ws, org]);
  return { ws, org };
}

async function due(ws: string, opts: Parameters<typeof fakeEffect>[1] = {}) {
  const cap = `test.${crypto.randomUUID()}`;
  const fake = fakeEffect("blind", opts);
  effects[cap] = fake.capability;
  return { id: await scheduledAction(ledger, ws, cap, "blind"), fake };
}

const hold = async (scope: string, target: string | null) => (await q("select system.set_operator_hold($1, $2, 'spam reports', 'cli:ops') as id", [scope, target]))[0]!.id as string | null;
const lift = async (scope: string, target: string | null) => (await q("select system.lift_operator_hold($1, $2, 'cli:ops') as lifted", [scope, target]))[0]!.lifted as boolean;
const stateOf = async (ws: string, id: string) => (await ledger.getAction(ws, id))!;

test("an Organization hold holds the due Actions of each of its Workspaces before keys are fetched; another Organization still sends", async () => {
  const a = await newWorkspace();
  const b = await newWorkspace(a.org);
  const other = await newWorkspace();
  const [ia, ib, io] = [await due(a.ws), await due(b.ws), await due(other.ws)];
  expect(await hold("organization", a.org)).not.toBeNull();
  keysFetched.length = 0;

  for (const [ws, { id }] of [[a.ws, ia], [b.ws, ib], [other.ws, io]] as const) await ledger.run(ws, id);
  expect(await stateOf(a.ws, ia.id)).toMatchObject({ state: "held", holdReason: "operator_hold", reasonDetail: "organization", nextAttemptAt: null });
  expect(await stateOf(b.ws, ib.id)).toMatchObject({ state: "held", holdReason: "operator_hold" });
  expect(ia.fake.calls).toHaveLength(0);
  expect(ib.fake.calls).toHaveLength(0);
  expect(keysFetched).toEqual([other.ws, other.ws]);
  expect(await stateOf(other.ws, io.id)).toMatchObject({ state: "sent" });
  expect(io.fake.calls).toHaveLength(1);

  // A member's own reads can't see or change the hold: the table has no grant for the app.
  await expect(asApp(a.ws, "select * from system.operator_holds")).rejects.toThrow(/permission denied/);
  await expect(asApp(a.ws, "select system.lift_operator_hold('organization', $1, 'me')", [a.org])).rejects.toThrow(/permission denied/);
  expect(await lift("organization", a.org)).toBe(true);
  expect(await ledger.releaseOperatorHolds()).toBe(2);
});

test("a hold committed after the claim stops the send at the dispatch check, under the row lock", async () => {
  const { ws } = await newWorkspace();
  const { id, fake } = await due(ws);
  afterClaim = async () => {
    afterClaim = undefined;
    onKeys = async () => {
      onKeys = undefined;
      await hold("workspace", ws);
    };
  };
  await ledger.run(ws, id);
  expect(fake.calls).toHaveLength(0);
  expect(await stateOf(ws, id)).toMatchObject({ state: "held", holdReason: "operator_hold", reasonDetail: "workspace" });
  expect(await lift("workspace", ws)).toBe(true);
  expect(await ledger.releaseOperatorHolds()).toBe(1);
});

test("lifting resumes only what the hold held, through every check, and releasing again resumes nothing", async () => {
  const { ws } = await newWorkspace();
  const held = await due(ws);
  const rejected = await due(ws, { steps: ["refused_retryable"] });
  await ledger.run(ws, rejected.id);
  expect(await stateOf(ws, rejected.id)).toMatchObject({ state: "held", holdReason: "provider_rejected" });
  await hold("workspace", ws);
  await ledger.run(ws, held.id);
  expect(await stateOf(ws, held.id)).toMatchObject({ state: "held", holdReason: "operator_hold" });
  // Still held: releasing before the lift resumes nothing.
  expect(await ledger.releaseOperatorHolds()).toBe(0);

  expect(await lift("workspace", ws)).toBe(true);
  expect(await lift("workspace", ws)).toBe(false);
  expect(await ledger.releaseOperatorHolds()).toBe(1);
  expect(await stateOf(ws, held.id)).toMatchObject({ state: "scheduled" });
  expect(await stateOf(ws, rejected.id)).toMatchObject({ state: "held", holdReason: "provider_rejected" });
  expect(await ledger.releaseOperatorHolds()).toBe(0);
  expect(await q("select released_at is not null as released, lifted_by from system.operator_holds where target = $1", [ws])).toEqual([{ released: true, lifted_by: "cli:ops" }]);
  await ledger.run(ws, held.id);
  expect(await stateOf(ws, held.id)).toMatchObject({ state: "sent" });
  expect(held.fake.calls).toHaveLength(1);
});

test("a Workspace stopped by two holds stays held until both are lifted", async () => {
  const { ws, org } = await newWorkspace();
  const { id, fake } = await due(ws);
  await hold("workspace", ws);
  await hold("organization", org);
  await ledger.run(ws, id);
  await lift("workspace", ws);
  expect(await ledger.releaseOperatorHolds()).toBe(0);
  expect(await stateOf(ws, id)).toMatchObject({ state: "held", holdReason: "operator_hold", reasonDetail: "workspace" });
  await lift("organization", org);
  expect(await ledger.releaseOperatorHolds()).toBe(1);
  await ledger.run(ws, id);
  expect(fake.calls).toHaveLength(1);
  expect(await q("select count(*)::int as n from system.operator_holds where target in ($1, $2) and released_at is null", [ws, org])).toEqual([{ n: 0 }]);
});

test("a deployment hold stops every Workspace; setting it twice keeps one live hold; a resend after an unknown outcome waits for a person", async () => {
  const { ws } = await newWorkspace();
  const first = await due(ws);
  const unknown = await due(ws, { steps: ["throw"] });
  await ledger.run(ws, unknown.id);
  // A blind effect's unknown outcome waits for a person; one who resends it puts it back to scheduled.
  await q("update actions set state = 'scheduled', hold_reason = null where id = $1", [unknown.id]);
  expect(await hold("deployment", null)).not.toBeNull();
  expect(await hold("deployment", null)).toBeNull();
  await ledger.run(ws, first.id);
  await ledger.run(ws, unknown.id);
  expect(await stateOf(ws, first.id)).toMatchObject({ state: "held", holdReason: "operator_hold", reasonDetail: "deployment" });
  expect(await stateOf(ws, unknown.id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", reasonDetail: "operator_hold" });
  expect(unknown.fake.calls).toHaveLength(1);

  expect(await lift("deployment", null)).toBe(true);
  expect(await ledger.releaseOperatorHolds()).toBe(1);
  expect(await stateOf(ws, unknown.id)).toMatchObject({ state: "held", holdReason: "outcome_unknown" });
  await ledger.run(ws, first.id);
  expect(first.fake.calls).toHaveLength(1);
});

test("a hold on an Organization or Workspace that doesn't exist is refused, and a hold on no live Workspace is released at once", async () => {
  await expect(hold("organization", crypto.randomUUID())).rejects.toMatchObject({ code: "DX404" });
  await expect(hold("workspace", crypto.randomUUID())).rejects.toMatchObject({ code: "DX404" });
  await expect(hold("deployment", crypto.randomUUID())).rejects.toThrow(/check constraint/);
  const { ws, org } = await newWorkspace();
  await q("update workspaces set deleted_at = now() where id = $1", [ws]);
  await hold("organization", org);
  await lift("organization", org);
  expect(await ledger.releaseOperatorHolds()).toBe(0);
  expect(await q("select released_at is not null as released from system.operator_holds where target = $1", [org])).toEqual([{ released: true }]);
});

test("a lift waits for transactions relying on the live hold", async () => {
  const { ws } = await newWorkspace();
  await hold("workspace", ws);
  const reader = await appClient();
  try {
    await reader.query("begin");
    expect((await reader.query("select system.operator_hold_of($1) as scope", [ws])).rows[0].scope).toBe("workspace");
    await q("set lock_timeout = '100ms'");
    await expect(lift("workspace", ws)).rejects.toMatchObject({ code: "55P03" });
  } finally {
    await reader.end();
    await q("reset lock_timeout");
  }
  expect(await lift("workspace", ws)).toBe(true);
});

test("dispatch retries when its initial hold has already been released", async () => {
  const { ws } = await newWorkspace();
  const { id, fake } = await due(ws);
  await hold("workspace", ws);
  const blocker = await ownerClient();
  let running: Promise<void> | undefined;
  try {
    await blocker.query("begin");
    const { rows } = await blocker.query("select pg_backend_pid() as pid from actions where id = $1 for update", [id]);
    running = ledger.run(ws, id);
    await expect.poll(async () => (await q(
      "select exists(select from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as waiting",
      [rows[0].pid],
    ))[0].waiting).toBe(true);
    expect(await lift("workspace", ws)).toBe(true);
    expect(await ledger.releaseOperatorHolds()).toBe(0);
  } finally {
    await blocker.end();
    await running;
  }
  expect(await stateOf(ws, id)).toMatchObject({ state: "sent" });
  expect(fake.calls).toHaveLength(1);
});
