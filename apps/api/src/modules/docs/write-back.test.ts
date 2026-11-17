// SPDX-License-Identifier: AGPL-3.0-only
// Status write-back (ADR 0025) through real sign-ins, roles, the vault, the Dispatcher and the real
// Notion plugin on a fake Notion: the mapping by id, the yes and its stop, the sweep's generations,
// and the checks at claim and dispatch. Posts are Items whose visible state the test sets.
import { expect, test } from "vitest";
import { createFakeNotion, createNotionPlugin, type FakeNotionSource } from "@direx/extensions";
import type { EffectCapability } from "@direx/plugin-sdk";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { approverMayApprove, workspaceLive } from "../identity/index";
import { testIdentity } from "../identity/test-auth";
import { createItems } from "../items/index";
import { testLedger } from "../ledger/test-effects";
import { docsProviders, type Query } from "../plugins/index";
import { directQuery } from "../plugins/fixtures/query";
import { inWorkspace, insertRow, rowByKey, rowsWithWrites, saveSource, setWrite } from "./adapters/repo";
import { outcomeOf } from "./domain/plan";
import { createWriteBack, createWriteBackGrants, docsWriteBackRoutes, DOCS_WRITE_WORDING_VERSION, docWriteCurrent, docWriteGrantVersion, HELD_FOR_MS, isDocsWrite, type WriteBackState } from "./index";

const CAL = "33333333-3333-4333-8333-333333333333";
const ROWS = ["44444444-4444-4444-8444-444444444441", "44444444-4444-4444-8444-444444444442"];
const calendar = (): FakeNotionSource => ({
  id: CAL,
  title: "Content calendar",
  columns: { Name: { type: "title" }, Status: { type: "status", options: ["Idea", "Scheduled", "Sent", "Cancelled"] }, Link: { type: "url" } },
  rows: ROWS.map((id, i) => ({ id, editedAt: "2026-11-01T09:00:00.000Z", values: { Name: `Post ${i + 1}`, Status: null, Link: null } })),
});
// A fresh fake Notion per world; the effect and queries reach whichever is current.
let n = createFakeNotion({ sources: [calendar()] });
let plugin = createNotionPlugin({ fetch: n.fetch });
const ctx = (workspaceId: string) => ({ workspaceId, log: () => {}, credential: { key: n.token } });
const provider = docsProviders([plugin.manifest])[0]!;
const CAP = provider.write!;
// The next call's outcome, when a test needs a provider call that dies or a reconcile it names.
const script: { throwNext?: boolean; reconcileAs?: "not_sent" } = {};
const effect: EffectCapability = {
  dedupe: "queryable",
  reachesPerson: false,
  execute: async (spec, c) => {
    if (script.throwNext) {
      script.throwNext = false;
      throw new Error("connection reset");
    }
    return plugin.effects["docs.row.update"]!.execute(spec, { ...ctx("w"), idempotencyKey: c.idempotencyKey });
  },
  reconcile: async (key, c, spec) => {
    if (script.reconcileAs) return { kind: script.reconcileAs };
    return plugin.effects["docs.row.update"]!.reconcile!(key, { ...ctx("w"), idempotencyKey: c.idempotencyKey }, spec);
  },
};

const { ledger, clock } = await testLedger({
  effects: { [CAP]: effect },
  resolvers: { credential: credentialLabel, doc_write_grant: docWriteGrantVersion, capability: async () => "1" },
  checks: [workspaceLive(), approverMayApprove((c) => (isDocsWrite(c) ? "rule.grant" : undefined)), docWriteCurrent, credentialReady],
});
const items = createItems({ ledger, now: () => clock.at, kinds: { "test.import": { permission: "item.approve", apply: async () => ({ ok: true }) } } });
const credentialOf = new Map<string, string>();
// The plugin of the current world, which each world replaces.
const query: Query = (workspaceId, capability, input, credentialId) => directQuery(plugin, (w) => ctx(w).credential)(workspaceId, capability, input, credentialId);
const read = {
  provider: () => provider,
  credentials: async (workspaceId: string) => (credentialOf.has(workspaceId) ? [{ id: credentialOf.get(workspaceId)!, connection: "notion" }] : []),
  query,
};
const granted: string[] = [];
const grants = createWriteBackGrants({ ...read, ledger: () => ledger, onGranted: async (_w, sourceId) => void granted.push(sourceId), now: () => clock.at });
// What the Calendar shows for each post.
const posts = new Map<string, string>();
const sweep = createWriteBack({
  ...read,
  ledger: () => ledger,
  prepare: (workspaceId, _capability, input) => plugin.effects["docs.row.update"]!.prepare(input, ctx(workspaceId)),
  capabilityVersion: () => "1",
  postOf: async (_w, itemId) => (posts.has(itemId) ? { state: posts.get(itemId)! } : undefined),
  now: () => clock.at,
});

const { routes, call, signIn, createOrg, addMember } = testIdentity();
routes.route("/", docsWriteBackRoutes({ grants: () => grants }));
const ownerCookie = await signIn();
const ownerId = ((await (await call("/api/me", ownerCookie)).json()) as { user: { id: string } }).user.id;
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });
const writeBack = { statusPropertyId: "Status", statusType: "status", options: { scheduled: "opt-Scheduled", sent: "opt-Sent", cancelled: "opt-Cancelled" }, urlPropertyId: "Link" };

/** A Workspace with a Notion key, a mapped source and two imported rows, whose posts are scheduled and waiting. */
async function world() {
  n = createFakeNotion({ sources: [calendar()] });
  plugin = createNotionPlugin({ fetch: n.fetch });
  const W = (await createOrg(ownerCookie)).workspace.id;
  const key = await vault.create({ workspaceId: W, actorUserId: ownerId, scope: "workspace", kind: "api_key", key: "ntn", name: "Notion", meta: {}, value: { key: n.token } });
  if (!key.ok) throw new Error(key.reason);
  credentialOf.set(W, key.credential.id);
  const source = await inWorkspace(W, (tx) => saveSource(tx, { workspaceId: W, externalId: CAL, title: "Content calendar", mapping: { date: "Date", channel: "Channel", text: { page: true }, accounts: {} }, setBy: ownerId, now: clock.at }));
  const itemIds: string[] = [];
  for (const [i, id] of ROWS.entries()) {
    const made = await items.createItem(W, { kind: "test.import", payload: {}, actor: { userId: ownerId }, details: { title: `Post ${i + 1}`, warnings: [] } });
    if (!made.ok) throw new Error(made.reason);
    await inWorkspace(W, (tx) => insertRow(tx, { workspaceId: W, sourceId: source.id, externalId: id, itemId: made.item.id, revision: 1, editedAt: new Date("2026-11-01T09:00:00.000Z"), now: clock.at }));
    posts.set(made.item.id, i === 0 ? "scheduled" : "needs_approval");
    itemIds.push(made.item.id);
  }
  const url = (rest = "") => `/api/w/${W}/docs/sources/${source.id}/write-back${rest}`;
  const put = (body: unknown, cookie = ownerCookie) => call(url(), cookie, { method: "PUT", body });
  const answer = (body: unknown, cookie = ownerCookie) => call(url("/grant"), cookie, { method: "POST", body });
  const yes = async (cookie = ownerCookie) => expect((await answer({ answer: "yes", wordingVersion: DOCS_WRITE_WORDING_VERSION }, cookie)).status).toBe(200);
  const stop = (body: unknown, cookie = ownerCookie) => call(url("/stop"), cookie, { method: "POST", body });
  const state = async (cookie = ownerCookie) => (await (await call(url(), cookie)).json()) as WriteBackState;
  const writes = async () => (await inWorkspace(W, (tx) => rowsWithWrites(tx, source.id))).sort((a, b) => a.row.externalId.localeCompare(b.row.externalId));
  const row = (i: number) => inWorkspace(W, (tx) => rowByKey(tx, source.id, ROWS[i]!));
  const patches = () => n.calls.filter((c) => c.method === "PATCH");
  return { W, sourceId: source.id, itemIds, put, answer, yes, stop, state, writes, row, patches };
}

test("the mapping is checked by id against the database, and only rule.grant may save it", async () => {
  const w = await world();
  const marketer = await addMember(ownerCookie, w.W, "marketer");
  expect((await w.put(writeBack, marketer.cookie)).status).toBe(403);
  expect(await (await w.put({ ...writeBack, statusPropertyId: "Name" })).json()).toEqual({ error: "status_not_a_choice" });
  expect(await (await w.put({ ...writeBack, statusType: "select" })).json()).toEqual({ error: "status_not_a_choice" });
  expect(await (await w.put({ ...writeBack, options: { scheduled: "opt-Gone" } })).json()).toEqual({ error: "unknown_option" });
  expect(await (await w.put({ ...writeBack, urlPropertyId: "Name" })).json()).toEqual({ error: "url_not_a_link" });
  expect((await w.put({ ...writeBack, options: {} })).status).toBe(400);
  const saved = await w.put(writeBack);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ status: "unanswered", writeBack, grant: null, writes: [] });
});

test("before a yes nothing is written; an answer must be given, by rule.grant, on today's words", async () => {
  const w = await world();
  const viewer = await addMember(ownerCookie, w.W, "viewer");
  // No mapping yet: nothing to say yes to.
  expect(await (await w.answer({ answer: "yes", wordingVersion: DOCS_WRITE_WORDING_VERSION })).json()).toEqual({ error: "no_write_back" });
  await w.put(writeBack);
  const s = await w.state(viewer.cookie);
  expect(s).toMatchObject({ status: "unanswered", mayAnswer: false, wordingVersion: DOCS_WRITE_WORDING_VERSION });
  expect(s.wording).toContain("Writes reach everyone who uses this database.");
  expect(s.wording).toContain("Not answering means no.");
  expect((await w.answer({ wordingVersion: DOCS_WRITE_WORDING_VERSION })).status).toBe(400);
  expect((await w.answer({ answer: "yes", wordingVersion: DOCS_WRITE_WORDING_VERSION, preselected: true })).status).toBe(400);
  expect((await w.answer({ answer: "yes", wordingVersion: DOCS_WRITE_WORDING_VERSION }, viewer.cookie)).status).toBe(403);
  expect(await (await w.answer({ answer: "yes", wordingVersion: "2020-01-01" })).json()).toEqual({ error: "stale_wording" });
  expect(await sweep.source(w.W, w.sourceId)).toEqual({ written: 0 });
  // A no is recorded as a no: still nothing is written.
  expect(await (await w.answer({ answer: "no", wordingVersion: DOCS_WRITE_WORDING_VERSION })).json()).toMatchObject({ status: "no", grant: { answer: "no", answeredBy: ownerId } });
  expect(await sweep.source(w.W, w.sourceId)).toEqual({ written: 0 });
  expect(granted).not.toContain(w.sourceId);
});

test("a yes writes each row's mapped state once, in the granter's name, and the next state over Direx's own", async () => {
  const w = await world();
  await w.put(writeBack);
  await w.yes();
  expect(granted).toContain(w.sourceId);
  expect(await (await w.answer({ answer: "yes", wordingVersion: DOCS_WRITE_WORDING_VERSION })).json()).toEqual({ error: "already_on" });
  // Only the scheduled post has a mapped state; the one waiting for approval isn't written.
  expect(await sweep.source(w.W, w.sourceId)).toEqual({ written: 1 });
  const [first, second] = await w.writes();
  expect(second!.action).toBeNull();
  const a = first!.action!;
  expect(a).toMatchObject({ state: "scheduled", spec: { pageId: ROWS[0], statusPropertyId: "Status", statusType: "status", optionId: "opt-Scheduled", lastOptionId: null } });
  expect(await ledger.getAction(w.W, a.id)).toMatchObject({ idempotencyKey: `docs_write:${w.sourceId}:${ROWS[0]}:1`, credentialId: credentialOf.get(w.W) });
  await ledger.run(w.W, a.id);
  expect(await ledger.getAction(w.W, a.id)).toMatchObject({ state: "sent", providerRef: "2026-11-20T00:01:00.000Z" });
  expect(n.sources[0]!.rows[0]!.values.Status).toBe("Scheduled");
  // Settled on the next pass, which then has nothing new to write.
  expect(await sweep.source(w.W, w.sourceId)).toEqual({ written: 0 });
  expect(await w.row(0)).toMatchObject({ writtenState: "scheduled", writtenOptionId: "opt-Scheduled", writtenEditedAt: new Date("2026-11-20T00:01:00.000Z"), generation: 1 });

  // Sent: a new generation, over the option Direx wrote.
  posts.set(w.itemIds[0]!, "sent");
  expect(await sweep.source(w.W, w.sourceId)).toEqual({ written: 1 });
  const next = (await w.writes())[0]!.action!;
  expect(next.spec).toMatchObject({ optionId: "opt-Sent", lastOptionId: "opt-Scheduled" });
  await ledger.run(w.W, next.id);
  expect(n.sources[0]!.rows[0]!.values.Status).toBe("Sent");
  await sweep.source(w.W, w.sourceId);
  expect(await w.row(0)).toMatchObject({ writtenOptionId: "opt-Sent", generation: 2 });
});

test("a status a person set in Notion is never overwritten: the write is Blocked and shown on the source", async () => {
  const w = await world();
  n.sources[0]!.rows[0]!.values.Status = "Idea";
  await w.put(writeBack);
  await w.yes();
  await sweep.source(w.W, w.sourceId);
  const a = (await w.writes())[0]!.action!;
  await ledger.run(w.W, a.id);
  expect(await ledger.getAction(w.W, a.id)).toMatchObject({ state: "blocked", reasonDetail: "changed_in_source" });
  expect(w.patches()).toHaveLength(0);
  expect((await w.state()).writes).toEqual([{ rowId: ROWS[0], itemId: w.itemIds[0], state: "blocked", reason: "provider_refused_permanently", detail: "changed_in_source" }]);
  // Not tried again for the same state.
  expect(await sweep.source(w.W, w.sourceId)).toEqual({ written: 0 });
});

test("any member stops it in one action with a reason, which cancels the writes not yet out", async () => {
  const w = await world();
  const viewer = await addMember(ownerCookie, w.W, "viewer");
  await w.put(writeBack);
  await w.yes();
  await sweep.source(w.W, w.sourceId);
  const a = (await w.writes())[0]!.action!;
  expect((await w.stop({}, viewer.cookie)).status).toBe(400);
  const r = await w.stop({ reason: "Our calendar moved" }, viewer.cookie);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ cancelled: 1, state: { status: "stopped", grant: { stoppedBy: viewer.userId, stopReason: "Our calendar moved" } } });
  expect(await ledger.getAction(w.W, a.id)).toMatchObject({ state: "cancelled" });
  await ledger.run(w.W, a.id);
  expect(w.patches()).toHaveLength(0);
  expect(await sweep.source(w.W, w.sourceId)).toEqual({ written: 0 });
  expect(await (await w.stop({ reason: "again" })).json()).toEqual({ error: "not_on" });
  // A new yes writes the row's state again.
  await w.yes();
  expect(await sweep.source(w.W, w.sourceId)).toEqual({ written: 1 });
});

test("a viewer lists the sources from the database alone and stops a yes from there, with a reason", async () => {
  const w = await world();
  const viewer = await addMember(ownerCookie, w.W, "viewer");
  await w.put(writeBack);
  await w.yes();
  const before = n.calls.length;
  const list = async (W: string, cookie: string) => call(`/api/w/${W}/docs/sources`, cookie);
  const r = await list(w.W, viewer.cookie);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ sources: [{ id: w.sourceId, title: "Content calendar", state: { status: "on", mayAnswer: false, writeBack } }] });
  expect(n.calls.length).toBe(before);
  expect((await w.stop({ reason: " " }, viewer.cookie)).status).toBe(400);
  expect((await w.stop({ reason: "Paused for the launch" }, viewer.cookie)).status).toBe(200);
  expect(await (await list(w.W, viewer.cookie)).json()).toMatchObject({ sources: [{ state: { status: "stopped", grant: { stoppedBy: viewer.userId, stopReason: "Paused for the launch" } } }] });
  // Another Workspace's list holds only its own source, and none of this one's.
  const other = await world();
  const theirs = (await (await list(other.W, ownerCookie)).json()) as { sources: { id: string }[] };
  expect(theirs.sources.map((s) => s.id)).toEqual([other.sourceId]);
  expect((await list(w.W, await signIn())).status).toBe(404);
});

test("a mapping change stops the yes and cancels its writes; the next yes writes the new option", async () => {
  const w = await world();
  await w.put(writeBack);
  await w.yes();
  await sweep.source(w.W, w.sourceId);
  const a = (await w.writes())[0]!.action!;
  // Saving the same mapping again changes nothing.
  expect(await (await w.put(writeBack)).json()).toMatchObject({ status: "on" });
  const grantId = (await w.state()).grant!.id;
  const remapped = { ...writeBack, options: { ...writeBack.options, scheduled: "opt-Idea" } };
  expect(await (await w.put(remapped)).json()).toMatchObject({ status: "stopped", grant: { stoppedBy: null, stopReason: "mapping_changed" } });
  expect(await ledger.getAction(w.W, a.id)).toMatchObject({ state: "cancelled" });
  // The old grant no longer resolves, so nothing approved under it can go out.
  expect(await inWorkspace(w.W, (tx) => docWriteGrantVersion(tx, grantId))).toBeNull();
  await w.yes();
  await sweep.source(w.W, w.sourceId);
  const b = (await w.writes())[0]!.action!;
  expect(b.spec).toMatchObject({ optionId: "opt-Idea" });
  await ledger.run(w.W, b.id);
  expect(n.sources[0]!.rows[0]!.values.Status).toBe("Idea");
});

test("another key on the connection, or an option gone from the database, stops the yes", async () => {
  const w = await world();
  await w.put(writeBack);
  await w.yes();
  const own = credentialOf.get(w.W)!;
  credentialOf.set(w.W, crypto.randomUUID());
  expect(await sweep.source(w.W, w.sourceId)).toEqual({ written: 0, stopped: "credential_changed" });
  expect(await w.state()).toMatchObject({ status: "stopped", grant: { stopReason: "credential_changed" } });
  credentialOf.set(w.W, own);
  await w.yes();
  n.sources[0]!.columns.Status = { type: "status", options: ["Idea", "Sent", "Cancelled"] };
  expect(await sweep.source(w.W, w.sourceId)).toEqual({ written: 0, stopped: "mapping_no_longer_fits" });
});

test("a superseded generation is Blocked at claim, and nothing is written", async () => {
  const w = await world();
  await w.put(writeBack);
  await w.yes();
  await sweep.source(w.W, w.sourceId);
  const a = (await w.writes())[0]!.action!;
  await inWorkspace(w.W, (tx) => setWrite(tx, w.sourceId, ROWS[0]!, { generation: 2, writeActionId: crypto.randomUUID(), now: clock.at }));
  await ledger.run(w.W, a.id);
  expect(await ledger.getAction(w.W, a.id)).toMatchObject({ state: "blocked", blockReason: "superseded" });
  expect(w.patches()).toHaveLength(0);
});

test("out of order: a Scheduled write retried after the Sent one went out is Blocked, never resent", async () => {
  const w = await world();
  await w.put(writeBack);
  await w.yes();
  await sweep.source(w.W, w.sourceId);
  const scheduled = (await w.writes())[0]!.action!;
  // The call dies after dispatch began: an unknown outcome, which can't be cancelled.
  script.throwNext = true;
  await ledger.run(w.W, scheduled.id);
  expect(await ledger.getAction(w.W, scheduled.id)).toMatchObject({ state: "held", holdReason: "outcome_unknown" });
  posts.set(w.itemIds[0]!, "sent");
  expect(await sweep.source(w.W, w.sourceId)).toEqual({ written: 1 });
  const sent = (await w.writes())[0]!.action!;
  await ledger.run(w.W, sent.id);
  expect(n.sources[0]!.rows[0]!.values.Status).toBe("Sent");
  const before = w.patches().length;
  // Reconcile says the Scheduled write never happened, so it is claimed again: and Blocked as superseded.
  script.reconcileAs = "not_sent";
  clock.at = new Date(clock.at.getTime() + 60 * 60_000);
  for (let i = 0; i < 3; i++) await ledger.run(w.W, scheduled.id);
  delete script.reconcileAs;
  expect(await ledger.getAction(w.W, scheduled.id)).toMatchObject({ state: "blocked", blockReason: "superseded" });
  expect(w.patches()).toHaveLength(before);
  expect(n.sources[0]!.rows[0]!.values.Status).toBe("Sent");
});

test("the granter losing rule.grant holds the write, shown on the source, and cancelled after a day", async () => {
  const w = await world();
  const admin = await addMember(ownerCookie, w.W, "admin");
  await w.put(writeBack);
  await w.yes(admin.cookie);
  await sweep.source(w.W, w.sourceId);
  const a = (await w.writes())[0]!.action!;
  expect((await call(`/api/w/${w.W}/members/${admin.userId}`, ownerCookie, { method: "PATCH", body: { role: "marketer" } })).status).toBe(200);
  expect(await w.state()).toMatchObject({ status: "granter_lost" });
  await ledger.run(w.W, a.id);
  expect(await ledger.getAction(w.W, a.id)).toMatchObject({ state: "held" });
  expect(w.patches()).toHaveLength(0);
  expect((await w.state()).writes).toMatchObject([{ rowId: ROWS[0], state: "held" }]);
  // Back to Admin: the grant lives again, and the sweep cancels what was held a day, writing nothing new for that state.
  expect((await call(`/api/w/${w.W}/members/${admin.userId}`, ownerCookie, { method: "PATCH", body: { role: "admin" } })).status).toBe(200);
  clock.at = new Date(clock.at.getTime() + HELD_FOR_MS);
  expect(await sweep.source(w.W, w.sourceId)).toEqual({ written: 0 });
  expect(await ledger.getAction(w.W, a.id)).toMatchObject({ state: "cancelled" });
  expect((await w.state()).writes).toEqual([]);
});

test("the import counts an edit at or before Direx's own write-back as seen", () => {
  const mapping = { date: "Date", channel: "Channel", text: { page: true as const }, accounts: {} };
  const imported = { itemId: crypto.randomUUID(), importedRevision: 1, editedAt: new Date("2026-11-01T09:00:00.000Z"), writtenEditedAt: new Date("2026-11-20T00:01:00.000Z") };
  const at = (editedAt: string) => outcomeOf({ id: ROWS[0]!, editedAt, values: {} }, mapping, { timeZone: "UTC", now: clock.at, imported, post: { state: "scheduled", revision: 1 } });
  expect(at("2026-11-20T00:01:00.000Z")).toEqual({ kind: "same" });
  expect(at("2026-11-20T00:02:00.000Z")).toMatchObject({ kind: "changed" });
});

test("another Workspace's sweep or routes reach nothing of this source", async () => {
  const w = await world();
  await w.put(writeBack);
  await w.yes();
  const other = await world();
  expect(await sweep.source(other.W, w.sourceId)).toEqual({ written: 0 });
  expect(await sweep.workspace(other.W)).toBe(0);
  expect((await w.writes()).every((r) => r.action === null)).toBe(true);
  expect((await grants.state(other.W, w.sourceId, { userId: ownerId, role: "owner" })).ok).toBe(false);
  expect(await grants.stop(other.W, w.sourceId, { userId: ownerId, role: "owner" }, "no")).toEqual({ ok: false, reason: "not_found" });
  expect(await w.state()).toMatchObject({ status: "on" });
});

test("a stop leaves a write that may have gone out for reconcile, never cancelling or resending it", async () => {
  const w = await world();
  await w.put(writeBack);
  await w.yes();
  await sweep.source(w.W, w.sourceId);
  const a = (await w.writes())[0]!.action!;
  script.throwNext = true;
  await ledger.run(w.W, a.id);
  expect(await (await w.stop({ reason: "Pause it" })).json()).toMatchObject({ cancelled: 0, state: { status: "stopped" } });
  expect(await ledger.getAction(w.W, a.id)).toMatchObject({ state: "held", holdReason: "outcome_unknown" });
  // Still its row's write, so reconcile can still record it.
  expect((await w.row(0))!.writeActionId).toBe(a.id);
});
