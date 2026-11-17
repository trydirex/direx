// SPDX-License-Identifier: AGPL-3.0-only
// A Mailbox's yes to Placement checks, its stop, and the live checks at claim and dispatch, through
// real sign-ins, roles, the vault and the Dispatcher. A placement Action is approved by binding the
// grant, in its granter's name; anything that stops the grant holds or cancels it.
import { expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { approverFromMember, approverMayApprove, workspaceLive } from "../identity/index";
import { testIdentity } from "../identity/test-auth";
import { fakeEffect, testLedger } from "../ledger/test-effects";
import type { Deployment } from "../models/index";
import { currentGrant, inWorkspace, insertGrant, stopGrant } from "./adapters/repo";
import { createPlacement, isPlacementCapability, PLACEMENT_WORDING_VERSION, placementGranted, placementGrantVersion, placementRoutes, type PlacementState } from "./index";

const SEND = "test/placement.send";
const OTHER = "test/email.send";
const send = fakeEffect("queryable");
const other = fakeEffect("blind");
const deployment: { value: Deployment } = { value: "self_host" };
const permissionFor = (c: string) => (isPlacementCapability(c) ? "rule.grant" : undefined);
const { ledger, clock } = await testLedger({
  effects: { [SEND]: send.capability, [OTHER]: other.capability },
  resolvers: { credential: credentialLabel, placement_grant: placementGrantVersion },
  checks: [workspaceLive(), approverMayApprove(permissionFor), placementGranted(() => deployment.value), credentialReady],
});
const placement = createPlacement({ ledger: () => ledger, deployment: () => deployment.value, now: () => clock.at });

const { routes, call, signIn, createOrg, addMember } = testIdentity();
routes.route("/", placementRoutes({ placement: () => placement, join: () => { throw new Error("joining is tested in join.test.ts"); } }));
const ownerCookie = await signIn();
const W = (await createOrg(ownerCookie)).workspace.id;
const owner = { cookie: ownerCookie, userId: ((await (await call("/api/me", ownerCookie)).json()) as { user: { id: string } }).user.id };
const admin = await addMember(ownerCookie, W, "admin");
const marketer = await addMember(ownerCookie, W, "marketer");
const viewer = await addMember(ownerCookie, W, "viewer");
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });

/** A Mailbox connected by `by`, who is then its connector. */
const mailbox = async (by: string, workspaceId = W) => {
  const address = `${crypto.randomUUID().slice(0, 8)}@acme.test`;
  const r = await vault.create({ workspaceId, actorUserId: by, scope: "workspace", kind: "api_key", key: address, name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!r.ok) throw new Error(r.reason);
  return { id: r.credential.id, address };
};
const url = (m: string, rest = "") => `/api/w/${W}/mailboxes/${m}/placement${rest}`;
const read = async (m: string, cookie = ownerCookie) => (await (await call(url(m), cookie)).json()) as PlacementState;
const answer = (m: string, cookie: string, body: unknown) => call(url(m), cookie, { method: "POST", body });
const yes = (m: { id: string; address: string }, cookie = ownerCookie) => answer(m.id, cookie, { answer: "yes", wordingVersion: PLACEMENT_WORDING_VERSION, confirmAddress: m.address.toUpperCase() });
const stop = (m: string, cookie: string, body: unknown) => call(url(m, "/stop"), cookie, { method: "POST", body });

/** A placement Action on this Mailbox waiting for approval. */
async function pending(credentialId: string, capability = SEND) {
  const actor = { system: "placement" };
  const { action } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability, dedupe: capability === SEND ? "queryable" : "blind", spec: { to: "member@circle.test", n: crypto.randomUUID() }, credentialId, actor });
  await ledger.submitForApproval(W, action.id, actor);
  return action.id;
}
/** The same, approved by binding the Mailbox's live grant. */
async function approved(credentialId: string) {
  const id = await pending(credentialId);
  const b = await placement.binding(W, credentialId);
  if (!b) throw new Error("no live grant to bind");
  const r = await ledger.approve(W, id, { approverId: b.approverId, draftVersion: 1, snapshot: b.snapshot });
  if (!r.ok) throw new Error(`approve: ${r.reason}`);
  return id;
}
const stateOf = async (id: string) => (await ledger.getAction(W, id))!;

test("before any answer the screen shows the disclosure with nothing chosen, and nothing is approvable or sent", async () => {
  const m = await mailbox(owner.userId);
  const s = await read(m.id);
  expect(s).toMatchObject({ status: "unanswered", grant: null, mayAnswer: true, address: m.address, wordingVersion: PLACEMENT_WORDING_VERSION });
  for (const named of ["folder labels", "the day, the sender, the receiver, the message identity and the verdict", "the Circle member who sent that check", "where a person can read it", "reciprocal placement feature", "Not answering means no"]) expect(s.wording).toContain(named);
  expect(await placement.binding(W, m.id)).toBeNull();
  // Approved by someone who may approve anything, but with no grant behind it.
  const id = await pending(m.id);
  expect((await ledger.approve(W, id, { approverId: approverFromMember(owner), draftVersion: 1, snapshot: [] })).ok).toBe(true);
  await ledger.run(W, id);
  expect(await stateOf(id)).toMatchObject({ state: "held", holdReason: "placement_not_granted" });
  expect(send.calls).toHaveLength(0);
});

test("an answer must be given: none, a made-up one or an extra field is refused and records nothing", async () => {
  const m = await mailbox(owner.userId);
  expect((await answer(m.id, ownerCookie, { wordingVersion: PLACEMENT_WORDING_VERSION, confirmAddress: m.address })).status).toBe(400);
  expect((await answer(m.id, ownerCookie, { answer: "maybe", wordingVersion: PLACEMENT_WORDING_VERSION, confirmAddress: m.address })).status).toBe(400);
  expect((await answer(m.id, ownerCookie, { answer: "yes", wordingVersion: PLACEMENT_WORDING_VERSION, confirmAddress: m.address, preselected: true })).status).toBe(400);
  expect(await read(m.id)).toMatchObject({ status: "unanswered", grant: null });
});

test("a yes needs the Mailbox's address typed back, on the words shown now", async () => {
  const m = await mailbox(owner.userId);
  const wrong = await answer(m.id, ownerCookie, { answer: "yes", wordingVersion: PLACEMENT_WORDING_VERSION, confirmAddress: "someone@else.test" });
  expect([wrong.status, await wrong.json()]).toEqual([409, { error: "address_mismatch" }]);
  expect((await (await answer(m.id, ownerCookie, { answer: "yes", wordingVersion: PLACEMENT_WORDING_VERSION })).json())).toEqual({ error: "address_mismatch" });
  const old = await answer(m.id, ownerCookie, { answer: "yes", wordingVersion: "2020-01-01", confirmAddress: m.address });
  expect([old.status, await old.json()]).toEqual([409, { error: "stale_wording" }]);
  expect(await read(m.id)).toMatchObject({ status: "unanswered" });
  // A no needs no typing, and is recorded as a no: nothing can be bound to it.
  expect((await answer(m.id, ownerCookie, { answer: "no", wordingVersion: PLACEMENT_WORDING_VERSION })).status).toBe(200);
  expect(await read(m.id)).toMatchObject({ status: "no", grant: { answer: "no", answeredBy: owner.userId } });
  expect(await placement.binding(W, m.id)).toBeNull();
});

test("only the person who connected the Mailbox answers, and only while they hold rule.grant", async () => {
  const byMarketer = await mailbox(marketer.userId);
  // An Admin may grant rules but did not connect it.
  expect(await read(byMarketer.id, admin.cookie)).toMatchObject({ mayAnswer: false });
  const notConnector = await yes(byMarketer, admin.cookie);
  expect([notConnector.status, await notConnector.json()]).toEqual([403, { error: "not_connector" }]);
  // The Marketer connected it but may not grant rules.
  expect(await read(byMarketer.id, marketer.cookie)).toMatchObject({ mayAnswer: false });
  expect((await yes(byMarketer, marketer.cookie)).status).toBe(403);
  expect(await read(byMarketer.id)).toMatchObject({ status: "unanswered" });
  expect(await placement.answer(W, byMarketer.id, { userId: marketer.userId, role: "marketer" }, { answer: "yes", wordingVersion: PLACEMENT_WORDING_VERSION, confirmAddress: byMarketer.address })).toEqual({ ok: false, reason: "forbidden" });
});

test("a live yes binds the grant in the granter's name, and its placement Action is sent", async () => {
  const m = await mailbox(owner.userId);
  const r = await yes(m);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ status: "on", grant: { answer: "yes", answeredBy: owner.userId, wordingVersion: PLACEMENT_WORDING_VERSION, stoppedAt: null } });
  expect((await yes(m)).status).toBe(409);
  const b = await placement.binding(W, m.id);
  expect(b?.snapshot).toEqual([{ kind: "placement_grant", id: expect.any(String), version: `${owner.userId}:${PLACEMENT_WORDING_VERSION}` }]);
  const id = await approved(m.id);
  const before = send.calls.length;
  await ledger.run(W, id);
  expect(await stateOf(id)).toMatchObject({ state: "sent" });
  expect(send.calls).toHaveLength(before + 1);
});

test("a grant stopped after approval holds the Action at dispatch, even one the stop didn't reach", async () => {
  const m = await mailbox(owner.userId);
  await yes(m);
  const id = await approved(m.id);
  // Stopped without the cancel, as for an Action the stop's transaction couldn't cancel.
  await inWorkspace(W, async (tx) => stopGrant(tx, (await currentGrant(tx, m.id))!.id, { stoppedBy: viewer.userId, stoppedAt: clock.at, stopReason: "test" }));
  await ledger.run(W, id);
  expect(await stateOf(id)).toMatchObject({ state: "held", holdReason: "snapshot_changed" });
  expect(await placement.binding(W, m.id)).toBeNull();
});

test("a granter demoted below rule.grant holds what they approved, and placement pauses", async () => {
  const adminCookie = admin.cookie;
  const m = await mailbox(admin.userId);
  expect((await yes(m, adminCookie)).status).toBe(200);
  const id = await approved(m.id);
  expect((await call(`/api/w/${W}/members/${admin.userId}`, ownerCookie, { method: "PATCH", body: { role: "marketer" } })).status).toBe(200);
  await ledger.run(W, id);
  expect(await stateOf(id)).toMatchObject({ state: "held", holdReason: "snapshot_changed" });
  expect(await read(m.id)).toMatchObject({ status: "granter_lost" });
  expect(await placement.binding(W, m.id)).toBeNull();
  expect((await call(`/api/w/${W}/members/${admin.userId}`, ownerCookie, { method: "PATCH", body: { role: "admin" } })).status).toBe(200);
});

test("new words pause placement: an Action approved on the old ones is held until the Mailbox is answered again", async () => {
  const m = await mailbox(owner.userId);
  await yes(m);
  const id = await approved(m.id);
  // As if this release shipped new words: the yes on record is now on older ones.
  const c = await ownerClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  await c.query("update placement_grants set wording_version = '2026-01-01' where credential_id = $1", [m.id]);
  await c.end();
  expect(await read(m.id)).toMatchObject({ status: "wording_changed" });
  expect(await placement.binding(W, m.id)).toBeNull();
  await ledger.run(W, id);
  expect(await stateOf(id)).toMatchObject({ state: "held", holdReason: "snapshot_changed" });
  expect(await (await yes(m)).json()).toMatchObject({ status: "on" });
  // The new yes is another grant: the old approval still doesn't stand.
  await ledger.resume(W, id, { userId: owner.userId });
  expect(await stateOf(id)).toMatchObject({ state: "needs_approval" });
});

test("any member stops a yes with a reason, which cancels every pending placement Action of that Mailbox and nothing else", async () => {
  const m = await mailbox(owner.userId);
  const elsewhere = await mailbox(owner.userId);
  await yes(m);
  await yes(elsewhere);
  const waiting = await pending(m.id);
  const scheduled = await approved(m.id);
  const draft = (await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: SEND, dedupe: "queryable", spec: { n: 1 }, credentialId: m.id, actor: { system: "placement" } })).action.id;
  const email = await pending(m.id, OTHER);
  const otherMailbox = await approved(elsewhere.id);

  expect((await stop(m.id, viewer.cookie, {})).status).toBe(400);
  expect((await stop(m.id, viewer.cookie, { reason: "   " })).status).toBe(400);
  const r = await stop(m.id, viewer.cookie, { reason: "We are moving this Mailbox" });
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ cancelled: 3, state: { status: "stopped", grant: { stoppedBy: viewer.userId, stopReason: "We are moving this Mailbox" } } });
  for (const id of [waiting, scheduled, draft]) expect(await stateOf(id)).toMatchObject({ state: "cancelled" });
  expect(await stateOf(email)).toMatchObject({ state: "needs_approval" });
  expect(await stateOf(otherMailbox)).toMatchObject({ state: "scheduled" });
  const again = await stop(m.id, viewer.cookie, { reason: "again" });
  expect([again.status, await again.json()]).toEqual([409, { error: "not_on" }]);
  // Stopped is not answered: the connector may say yes again, as a new grant.
  expect(await (await yes(m)).json()).toMatchObject({ status: "on" });
});

test("on Direx's cloud every placement route is not available, no grant binds and nothing is sent", async () => {
  const m = await mailbox(owner.userId);
  await yes(m);
  const id = await approved(m.id);
  deployment.value = "cloud";
  try {
    for (const r of [await call(url(m.id), ownerCookie), await yes(m), await stop(m.id, ownerCookie, { reason: "x" })]) expect([r.status, await r.json()]).toEqual([404, { error: "not_available" }]);
    expect(await placement.binding(W, m.id)).toBeNull();
    await ledger.run(W, id);
    expect(await stateOf(id)).toMatchObject({ state: "blocked", blockReason: "placement_not_available" });
  } finally {
    deployment.value = "self_host";
  }
});

test("approving a placement Action takes rule.grant; other capabilities keep item.approve", async () => {
  const check = approverMayApprove(permissionFor);
  const as = (capability: string, approverId: string) => inWorkspace(W, (tx) => check(tx, { capability } as never, { approverId } as never));
  expect(await as(SEND, marketer.userId)).toMatchObject({ kind: "hold", reason: "approver_permission_lost" });
  expect(await as(SEND, admin.userId)).toEqual({ kind: "ok" });
  expect(await as(OTHER, marketer.userId)).toEqual({ kind: "ok" });
  expect(await as(OTHER, viewer.userId)).toMatchObject({ kind: "hold" });
  expect(isPlacementCapability("com.trydirex.gmail/placement.report")).toBe(true);
  expect(isPlacementCapability("com.trydirex.gmail/mailbox.probe")).toBe(false);
});

test("another Workspace sees no grant and can't write one into this Workspace", async () => {
  const m = await mailbox(owner.userId);
  await yes(m);
  const otherCookie = await signIn();
  const B = (await createOrg(otherCookie, "Other")).workspace.id;
  expect(await inWorkspace(B, (tx) => currentGrant(tx, m.id))).toBeUndefined();
  expect((await call(`/api/w/${B}/mailboxes/${m.id}/placement`, otherCookie)).status).toBe(404);
  expect((await call(`/api/w/${B}/mailboxes/${m.id}/placement/stop`, otherCookie, { method: "POST", body: { reason: "x" } })).status).toBe(404);
  await expect(inWorkspace(B, (tx) => insertGrant(tx, { workspaceId: W, credentialId: m.id, answer: "yes", wordingVersion: PLACEMENT_WORDING_VERSION, answeredBy: owner.userId, answeredAt: clock.at }))).rejects.toThrow();
  expect(await read(m.id)).toMatchObject({ status: "on", grant: { answeredBy: owner.userId } });
});
