// SPDX-License-Identifier: AGPL-3.0-only
// ADR 0030 rule 007: once an Owner deletes a Workspace, the dispatcher holds its due Actions and
// calls no plugin, not even to ask about an unknown outcome. Deleting it cancels, in the same
// transaction, its Actions that cannot have reached anyone, so its purge can run.
import { afterAll, expect, test } from "vitest";
import type { EffectCapability } from "@direx/plugin-sdk";
import { appClient, insertAuthUser, ownerClient } from "../../../../../test/db";
import { testIdentity } from "../identity/test-auth";
import { withWorkspace } from "../retention/fixtures/purge";
import { purgeRefusal } from "../retention/index";
import { fakeEffect, scheduledAction, testLedger } from "./test-effects";

const effects: Record<string, EffectCapability> = {};
const { clock, ledger } = await testLedger({ effects, executeTimeoutMs: 100 });
const owner = crypto.randomUUID();
await insertAuthUser(owner);

async function asApp(ws: string, text: string, values: unknown[]) {
  const c = await appClient();
  try {
    await c.query("begin");
    await c.query("select set_config('app.workspace_id', $1, true)", [ws]);
    await c.query(text, values);
    await c.query("commit");
  } finally {
    await c.end();
  }
}

async function newWorkspace() {
  const ws = crypto.randomUUID();
  const org = crypto.randomUUID();
  await asApp(ws, "insert into organizations (id, name, created_at) values ($1, 'O', now())", [org]);
  await asApp(ws, "insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())", [ws, org]);
  return ws;
}

const softDelete = (ws: string) => asApp(ws, "select system.soft_delete_workspace($1, $2)", [ws, owner]);

async function setup(ws: string, dedupe: "blind" | "queryable", opts: Parameters<typeof fakeEffect>[1] = {}) {
  const cap = `test.${crypto.randomUUID()}`;
  const fake = fakeEffect(dedupe, opts);
  effects[cap] = fake.capability;
  return { id: await scheduledAction(ledger, ws, cap, dedupe), fake };
}

test("a due Action of a deleted Workspace is blocked as workspace_deleted, with no plugin call and no retry", async () => {
  const ws = await newWorkspace();
  const { id, fake } = await setup(ws, "blind");
  await softDelete(ws);
  await ledger.run(ws, id);
  const blocked = (await ledger.getAction(ws, id))!;
  expect(blocked).toMatchObject({ state: "blocked", blockReason: "workspace_deleted", nextAttemptAt: null });
  // Run again, as a stray wake would: nothing more happens.
  await ledger.run(ws, id);
  expect(fake.calls).toHaveLength(0);
  expect((await ledger.getAction(ws, id))!.version).toBe(blocked.version);
});

test("an unknown outcome due for a reconcile is not asked about once its Workspace is deleted, and stays unknown", async () => {
  const ws = await newWorkspace();
  const { id, fake } = await setup(ws, "queryable", { steps: ["throw"], reconcile: ["sent"] });
  await ledger.run(ws, id);
  const held = (await ledger.getAction(ws, id))!;
  expect(held).toMatchObject({ state: "held", holdReason: "outcome_unknown" });
  await softDelete(ws);
  clock.at = held.nextAttemptAt!;
  await ledger.run(ws, id);
  expect(fake.reconciles).toEqual([]);
  expect(fake.calls).toHaveLength(1);
  expect(await ledger.getAction(ws, id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", reasonDetail: "workspace_deleted", nextAttemptAt: null });
});

test("an Action of a live Workspace still goes out", async () => {
  const ws = await newWorkspace();
  const { id, fake } = await setup(ws, "blind");
  await ledger.run(ws, id);
  expect((await ledger.getAction(ws, id))!.state).toBe("sent");
  expect(fake.calls).toHaveLength(1);
});

const db = await ownerClient();
afterAll(() => db.end());
const { signIn, createOrg, call } = testIdentity({ onDelete: (tx) => ledger.cancelForDeletionIn(tx) });

/** An Action put straight into a state, as the dispatcher or a person would have left it. */
async function seeded(ws: string, state: string, o: { hold?: string; block?: string; unknownOutcome?: boolean } = {}) {
  const { rows } = await db.query(
    `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, hold_reason, block_reason, outcome_unknown_at, spec, spec_hash, created_at, updated_at)
     values ($1, gen_random_uuid(), 'test.deleted', 'blind', $2, $3, $4, $5, '{}'::jsonb, 'h', now(), now()) returning id`,
    [ws, state, o.hold ?? null, o.block ?? null, o.unknownOutcome ? new Date() : null],
  );
  return rows[0]!.id as string;
}

const CANCELLED = {
  draft: ["draft"],
  needs_approval: ["needs_approval"],
  scheduled: ["scheduled"],
  claimed: ["claimed"],
  held_rejected: ["held", { hold: "provider_rejected" }],
  held_late: ["held", { hold: "late" }],
  held_expired: ["held", { hold: "approval_expired" }],
} as const;
const FINAL = {
  sent: ["sent"],
  blocked: ["blocked", { block: "provider_refused_permanently" }],
  cancelled: ["cancelled"],
} as const;
const MAY_HAVE_GONE_OUT = {
  dispatching: ["dispatching"],
  unknown: ["held", { hold: "outcome_unknown", unknownOutcome: true }],
  resend_claimed: ["claimed", { unknownOutcome: true }],
  resend_scheduled: ["scheduled", { unknownOutcome: true }],
} as const;

async function workspaceWith(cases: Record<string, readonly [string, ({ hold?: string; block?: string; unknownOutcome?: boolean } | undefined)?]>) {
  const cookie = await signIn();
  const ws = (await createOrg(cookie)).workspace.id;
  const ids: Record<string, string> = {};
  for (const [name, [state, o]] of Object.entries(cases)) ids[name] = await seeded(ws, state, o);
  return { ws, cookie, ids };
}
const snapshot = async (ws: string, ids: Record<string, string>) => {
  const out: Record<string, { state: string; version: number; events: number }> = {};
  for (const [name, id] of Object.entries(ids)) {
    const a = (await ledger.getAction(ws, id))!;
    out[name] = { state: a.state, version: a.version, events: (await ledger.getEvents(ws, id)).length };
  }
  return out;
};

test("deleting a Workspace cancels each Action that cannot have reached anyone, as the system, and leaves the rest", async () => {
  const { ws, cookie, ids } = await workspaceWith({ ...CANCELLED, ...FINAL, ...MAY_HAVE_GONE_OUT });
  const before = await snapshot(ws, ids);
  expect((await call(`/api/w/${ws}`, cookie, { method: "DELETE" })).status).toBe(200);
  const after = await snapshot(ws, ids);

  for (const [name, [state]] of Object.entries(CANCELLED)) {
    expect(after[name]).toEqual({ state: "cancelled", version: before[name]!.version + 1, events: 1 });
    expect(await ledger.getEvents(ws, ids[name]!)).toEqual([
      expect.objectContaining({ fromState: state, toState: "cancelled", reason: "workspace_deleted", actorSystem: "ledger", actorUserId: null, actorAgentRunId: null }),
    ]);
  }
  for (const name of [...Object.keys(FINAL), ...Object.keys(MAY_HAVE_GONE_OUT)]) expect(after[name]).toEqual(before[name]);
  expect(await ledger.getAction(ws, ids.unknown!)).toMatchObject({ state: "held", holdReason: "outcome_unknown" });

  // Again, as a second delete or a straggler would: nothing more changes.
  expect((await call(`/api/w/${ws}`, cookie, { method: "DELETE" })).status).toBe(404);
  expect(await withWorkspace(ws, (tx) => ledger.cancelForDeletionIn(tx))).toBe(0);
  expect(await snapshot(ws, ids)).toEqual(after);

  // What may have gone out still keeps the purge waiting for a person, 30 days on.
  await db.query(`update workspaces set deleted_at = now() - interval '31 days' where id = $1`, [ws]);
  expect(await purgeRefusal(db, ws)).toBe("in_flight");
});

test("once its open Actions are cancelled and 30 days have passed, nothing in flight refuses the purge", async () => {
  const { ws, cookie } = await workspaceWith({ ...CANCELLED, ...FINAL });
  expect(await purgeRefusal(db, ws)).toBe("live");
  expect((await call(`/api/w/${ws}`, cookie, { method: "DELETE" })).status).toBe(200);
  expect(await purgeRefusal(db, ws)).toBe("recent");
  await db.query(`update workspaces set deleted_at = now() - interval '31 days' where id = $1`, [ws]);
  expect(await purgeRefusal(db, ws)).toBeNull();
});

test("without the delete hook, a deleted Workspace's draft is left, and keeps the purge waiting", async () => {
  const plain = testIdentity();
  const cookie = await plain.signIn();
  const ws = (await plain.createOrg(cookie)).workspace.id;
  const id = await seeded(ws, "draft");
  expect((await plain.call(`/api/w/${ws}`, cookie, { method: "DELETE" })).status).toBe(200);
  expect((await ledger.getAction(ws, id))!.state).toBe("draft");
  await db.query(`update workspaces set deleted_at = now() - interval '31 days' where id = $1`, [ws]);
  expect(await purgeRefusal(db, ws)).toBe("in_flight");
});
