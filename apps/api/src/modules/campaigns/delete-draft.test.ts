// SPDX-License-Identifier: AGPL-3.0-only
// ADR 0023: a Campaign's status is derived on each read (rule 003), and Delete draft removes a never-approved
// Campaign with its plan through one database function that refuses anything else (rule 005). Over HTTP.
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { itemsApp } from "../items/fixtures/items";
import { createOutreach } from "../outreach/index";
import { createPlans, planKinds, planRoutes } from "../plans/index";
import { campaignOnPlanApproved, campaignOnPlanCreated, campaignRoutes, createCampaigns } from "./index";

const { routes, call, signIn, createOrg, addMember, items } = await itemsApp({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }) } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const outreach = createOutreach({
  items: () => items,
  send: () => {
    throw new Error("nothing is sent here");
  },
  baseUrl: () => "http://direx.test",
});
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: () => async () => ({ ok: true, run: { id: crypto.randomUUID() } }) });
routes.route("/", planRoutes({ plans: () => plans, startDraft: async () => ({ ok: true, run: { id: crypto.randomUUID() } }) }));
routes.route("/", campaignRoutes({ campaigns: () => campaigns }));

const owner = await signIn();
const W = (await createOrg(owner)).workspace.id;
const admin = (await addMember(owner, W, "admin")).cookie;
const contributor = (await addMember(owner, W, "contributor")).cookie;
const other = await signIn();
const W2 = (await createOrg(other)).workspace.id;

const url = (rest = "", ws = W) => `/api/w/${ws}${rest}`;
const send = (method: string, path: string, cookie: string, body?: unknown) => call(path, cookie, { method, ...(body !== undefined && { body }) });
const read = async <T>(path: string, cookie = owner) => (await (await call(path, cookie)).json()) as T;
type Waiting = { id: string; revision: number };
const approve = (w: Waiting, cookie = owner) => send("POST", url(`/items/${w.id}/approve`), cookie, { revision: w.revision });
const body = (goal = "4 meetings") => ({
  schemaVersion: 1,
  goal,
  audience: "Ops",
  startsOn: "2099-11-01",
  endsOn: "2099-11-30",
  steps: [{ key: "first", on: "2099-11-03", title: "First" }],
  measures: [{ key: "m", label: "M", target: "4", basis: { kind: "assumption" } }],
  budget: [{ label: "Mailbox", amountCents: null, currency: "USD", billedBy: "your_account" }],
  assumptions: [{ text: "A guess" }],
});

let c: Awaited<ReturnType<typeof appClient>>;
const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;

/** A plan and the Campaign made with it, by `cookie`; submitted unless asked not to, never approved. */
async function draft(cookie = owner, submit = true, ws = W) {
  const { id: planId } = (await (await send("POST", url("/plans", ws), cookie, { title: "Q4" })).json()) as { id: string };
  await send("PUT", url(`/plans/${planId}/draft`, ws), cookie, { revision: 0, body: body() });
  if (submit) expect((await send("POST", url(`/plans/${planId}/submit`, ws), cookie, { revision: 1 })).status).toBe(200);
  await c.query("select set_config('app.workspace_id', $1, false)", [ws]);
  const [row] = await q("select id from campaigns where plan_id = $1", [planId]);
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  return { planId, id: row.id as string };
}
const waitingOf = async (planId: string) => (await read<{ waiting: Waiting }>(url(`/plans/${planId}`))).waiting;
const remove = (id: string, cookie = owner, ws = W) => send("DELETE", url(`/campaigns/${id}/draft`, ws), cookie);
const gone = async (d: { planId: string; id: string }) => {
  expect(await q("select id from campaigns where id = $1", [d.id])).toEqual([]);
  expect(await q("select id from marketing_plans where id = $1", [d.planId])).toEqual([]);
  expect(await q("select version from marketing_plan_versions where plan_id = $1", [d.planId])).toEqual([]);
};
const kept = async (d: { planId: string; id: string }) => expect(await q("select id from marketing_plans where id = $1", [d.planId])).toHaveLength(1);

beforeAll(async () => {
  c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  for (const [ws, cookie] of [[W, owner], [W2, other]] as const) {
    const strategy = { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] };
    await send("PUT", url("/strategy/draft", ws), cookie, { revision: 0, body: strategy });
    await send("POST", url("/strategy/submit", ws), cookie, { revision: 1 });
    const w = (await read<{ waiting: Waiting }>(url("/strategy", ws), cookie)).waiting;
    await send("POST", url(`/items/${w.id}/approve`, ws), cookie, { revision: w.revision });
  }
});
afterAll(() => c.end());

test("a Campaign's status follows its plan: Draft, Awaiting sign-off, Scheduled, then changes waiting is a marker", async () => {
  const d = await draft(owner, false);
  const status = async () => {
    const r = await read<{ status: string; changesWaiting: boolean; createdBy: string | null }>(url(`/campaigns/${d.id}`));
    return { status: r.status, changesWaiting: r.changesWaiting };
  };
  expect(await status()).toEqual({ status: "draft", changesWaiting: false });
  // A Draft is on the list with its status (ADR 0023).
  expect((await read<{ campaigns: { id: string; status: string }[] }>(url("/campaigns"))).campaigns.find((x) => x.id === d.id)?.status).toBe("draft");
  await send("POST", url(`/plans/${d.planId}/submit`), owner, { revision: 1 });
  expect(await status()).toEqual({ status: "awaiting_signoff", changesWaiting: false });
  expect((await approve(await waitingOf(d.planId))).status).toBe(200);
  expect(await status()).toEqual({ status: "scheduled", changesWaiting: false });
  await send("PUT", url(`/plans/${d.planId}/draft`), owner, { revision: 1, body: body("5 meetings") });
  await send("POST", url(`/plans/${d.planId}/submit`), owner, { revision: 2 });
  expect(await status()).toEqual({ status: "scheduled", changesWaiting: true });
  const listed = (await read<{ campaigns: { id: string; status: string; changesWaiting: boolean }[] }>(url("/campaigns"))).campaigns.find((x) => x.id === d.id);
  expect(listed).toMatchObject({ status: "scheduled", changesWaiting: true });
});

test("its creator deletes a Draft: the Campaign, plan and versions go, and its waiting Item is dismissed but kept", async () => {
  const d = await draft(contributor);
  const waiting = await waitingOf(d.planId);
  expect((await read<{ createdBy: string | null }>(url(`/campaigns/${d.id}`))).createdBy).toEqual(expect.any(String));
  expect((await remove(d.id, contributor)).status).toBe(200);
  await gone(d);
  expect(await q("select state from items where id = $1", [waiting.id])).toEqual([{ state: "cancelled" }]);
  expect((await call(url(`/campaigns/${d.id}`), owner)).status).toBe(404);
  expect((await remove(d.id, contributor)).status).toBe(404);
});

test("an Owner or Admin deletes anyone's Draft; a Contributor who didn't start it may not", async () => {
  const d = await draft(owner);
  expect(await (await remove(d.id, contributor)).json()).toEqual({ error: "forbidden" });
  expect((await remove(d.id, contributor)).status).toBe(403);
  await kept(d);
  expect((await remove(d.id, admin)).status).toBe(200);
  await gone(d);
  const mine = await draft(contributor);
  expect((await remove(mine.id, owner)).status).toBe(200);
  await gone(mine);
});

test("another Workspace's Draft is not found, through the route and through the function itself", async () => {
  const theirs = await draft(other, true, W2);
  expect((await remove(theirs.id, owner)).status).toBe(404);
  expect((await remove(theirs.id, owner, W2)).status).toBe(404);
  // The function checks the Workspace it is given against the session's before anything else.
  await expect(c.query("select system.delete_draft_campaign($1, $2)", [W2, theirs.planId])).rejects.toMatchObject({ code: "DX404" });
  await expect(c.query("select system.delete_draft_campaign($1, $2)", [W, theirs.planId])).rejects.toMatchObject({ code: "DX404" });
  // And the app role still deletes nothing on its own.
  await expect(c.query("delete from campaigns where id = $1", [theirs.id])).rejects.toMatchObject({ code: "42501" });
  await c.query("select set_config('app.workspace_id', $1, false)", [W2]);
  expect(await q("select id from marketing_plans where id = $1", [theirs.planId])).toHaveLength(1);
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
});

test("a plan approved once is no Draft, and can't be deleted", async () => {
  const d = await draft();
  expect((await approve(await waitingOf(d.planId))).status).toBe(200);
  expect(await (await remove(d.id)).json()).toEqual({ error: "plan_approved" });
  await kept(d);
});

test("a Draft whose plan drafter is still running can't be deleted until the run ends", async () => {
  const d = await draft();
  const [run] = await q(
    `insert into agent_runs (workspace_id, idempotency_key, agent, definition_version, prompt_revision, prompt_digest, tool_set_digest, trigger, status, deadline_ms, step_cap, cost_cap_micros, input, created_at, updated_at)
     values ($1, gen_random_uuid()::text, 'plan_drafter', 1, 'r', 'd', 'd', 'person', 'running', 1000, 1, 1, $2, now(), now()) returning id`,
    [W, JSON.stringify({ request: "Q4", brief: [], target: { id: d.planId, draftRevision: 0 } })],
  );
  const r = await remove(d.id);
  expect([r.status, await r.json()]).toEqual([409, { error: "drafter_running" }]);
  await kept(d);
  await q("update agent_runs set status = 'succeeded', ended_at = now() where id = $1", [run.id]);
  expect((await remove(d.id)).status).toBe(200);
  await gone(d);
});

test("a Draft something else points at can't be deleted: a plan reading, or another Campaign's People", async () => {
  const d = await draft();
  await q("insert into plan_measure_readings (workspace_id, plan_id, measure_key, value, observed_on, source, actor_user_id, at) select $1, $2, 'm', '1', '2099-11-02', 'person', created_by, now() from marketing_plans where id = $2", [W, d.planId]);
  expect(await (await remove(d.id)).json()).toEqual({ error: "draft_in_use" });
  await kept(d);
  const after = await draft();
  const live = await draft();
  expect((await approve(await waitingOf(live.planId))).status).toBe(200);
  const p = await outreach.ensurePerson(W, `${crypto.randomUUID()}@acme.test`);
  if (!p.ok) throw new Error("no person");
  await q("insert into campaign_people (workspace_id, campaign_id, person_id, added_by, after_campaign_id, at) select $1, $2, $3, created_by, $4, now() from marketing_plans where id = $5", [W, live.id, p.id, after.id, live.planId]);
  expect(await (await remove(after.id)).json()).toEqual({ error: "draft_in_use" });
  await kept(after);
});

test("approving and deleting one Draft at once: exactly one wins", async () => {
  for (let n = 0; n < 5; n++) {
    const d = await draft();
    const [approved, deleted] = await Promise.all([approve(await waitingOf(d.planId)), remove(d.id)]);
    expect([approved.status, deleted.status].filter((s) => s === 200)).toHaveLength(1);
    const left = await q("select current_version from marketing_plans where id = $1", [d.planId]);
    if (deleted.status === 200) await gone(d);
    else expect(left).toEqual([{ current_version: 1 }]);
  }
});

test("a Draft takes notes from a contributor, a stale save or a viewer is refused, and Delete draft removes them", async () => {
  const viewer = (await addMember(owner, W, "viewer")).cookie;
  const d = await draft(contributor);
  const saved = await send("PUT", url(`/campaigns/${d.id}/notes`), contributor, { notes: "  Launch call with Sam on Tuesday.\nKeep it short.  ", revision: 0 });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ revision: 1 });
  const read1 = await read<{ notes: string; notesRevision: number; notesUpdatedBy: string | null; notesUpdatedAt: string | null }>(url(`/campaigns/${d.id}`));
  expect(read1).toMatchObject({ notes: "Launch call with Sam on Tuesday.\nKeep it short.", notesRevision: 1 });
  expect(read1.notesUpdatedBy).toBeTruthy();
  expect(read1.notesUpdatedAt).toBeTruthy();

  const stale = await send("PUT", url(`/campaigns/${d.id}/notes`), owner, { notes: "Mine", revision: 0 });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "revision_moved" });
  expect((await send("PUT", url(`/campaigns/${d.id}/notes`), viewer, { notes: "No", revision: 1 })).status).toBe(403);
  expect((await send("PUT", url(`/campaigns/${d.id}/notes`), owner, { notes: "x".repeat(10001), revision: 1 })).status).toBe(400);
  expect((await send("PUT", url(`/campaigns/${crypto.randomUUID()}/notes`), owner, { notes: "None", revision: 0 })).status).toBe(404);
  expect((await read<{ notes: string }>(url(`/campaigns/${d.id}`))).notes).toBe("Launch call with Sam on Tuesday.\nKeep it short.");

  expect((await remove(d.id, contributor)).status).toBe(200);
  await gone(d);
});
