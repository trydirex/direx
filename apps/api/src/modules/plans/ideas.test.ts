// SPDX-License-Identifier: AGPL-3.0-only
// Ideas over HTTP: saved trimmed, read by anyone in the Workspace and by no other, started as a Campaign
// once, dismissed but kept, and open again when the draft started from one is deleted (ADR 0023 rule 005).
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { itemsApp } from "../items/fixtures/items";
import { createOutreach } from "../outreach/index";
import { campaignOnPlanApproved, campaignOnPlanCreated, campaignRoutes, createCampaigns } from "../campaigns/index";
import { createPlans, planKinds, planRoutes } from "./index";

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
const contributor = (await addMember(owner, W, "contributor")).cookie;
const viewer = (await addMember(owner, W, "viewer")).cookie;
const other = await signIn();
const W2 = (await createOrg(other)).workspace.id;

const url = (rest = "", ws = W) => `/api/w/${ws}${rest}`;
const send = (method: string, path: string, cookie: string, body?: unknown) => call(path, cookie, { method, ...(body !== undefined && { body }) });
type Idea = { id: string; text: string; createdBy: string; createdAt: string };
type List = { open: Idea[]; started: (Idea & { planId: string; planTitle: string; startedAt: string })[] };
const list = async (cookie = owner, ws = W) => (await (await call(url("/ideas", ws), cookie)).json()) as List;
const add = async (text: string, cookie = owner, ws = W) => (await (await send("POST", url("/ideas", ws), cookie, { text })).json()) as Idea;
const plan = async (title: string, cookie = owner, ws = W) => (await (await send("POST", url("/plans", ws), cookie, { title, request: title })).json()) as { id: string };

let c: Awaited<ReturnType<typeof appClient>>;
beforeAll(async () => {
  c = await appClient();
});
afterAll(async () => {
  await c.end();
});

test("an Idea is saved trimmed and listed newest first; a viewer reads but can't add; bad text is refused", async () => {
  const first = await add("  Webinar with a customer  ", contributor);
  expect(first.text).toBe("Webinar with a customer");
  await add("Pricing page refresh");
  expect((await list(viewer)).open.map((i) => i.text).slice(0, 2)).toEqual(["Pricing page refresh", "Webinar with a customer"]);
  expect((await send("POST", url("/ideas"), viewer, { text: "Nope" })).status).toBe(403);
  expect((await send("POST", url("/ideas"), owner, { text: "   " })).status).toBe(400);
  expect((await send("POST", url("/ideas"), owner, { text: "x".repeat(501) })).status).toBe(400);
  expect((await list(other, W2)).open).toEqual([]);
});

test("starting an Idea links it once to a plan in this Workspace, and Delete draft opens it again", async () => {
  const i = await add("Partner co-marketing");
  const p = await plan("Partner co-marketing");
  expect((await send("POST", url(`/ideas/${i.id}/started`), contributor, { planId: p.id })).status).toBe(200);
  const after = await list();
  expect(after.open.map((x) => x.id)).not.toContain(i.id);
  expect(after.started.find((x) => x.id === i.id)).toMatchObject({ planId: p.id, planTitle: "Partner co-marketing" });
  expect((await send("POST", url(`/ideas/${i.id}/started`), owner, { planId: p.id })).status).toBe(409);

  const foreign = await plan("Not yours", other, W2);
  const j = await add("Another one");
  expect((await send("POST", url(`/ideas/${j.id}/started`), owner, { planId: foreign.id })).status).toBe(404);

  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  const [row] = (await c.query("select id from campaigns where plan_id = $1", [p.id])).rows;
  expect((await send("DELETE", url(`/campaigns/${row.id}/draft`), owner)).status).toBe(200);
  expect((await list()).open.map((x) => x.id)).toContain(i.id);
});

test("Dismiss hides an Idea but keeps its row; dismissing again or another Workspace's says not found", async () => {
  const i = await add("Podcast tour");
  expect((await send("POST", url(`/ideas/${i.id}/dismiss`), viewer)).status).toBe(403);
  expect((await send("POST", url(`/ideas/${i.id}/dismiss`), owner, undefined)).status).toBe(200);
  expect((await list()).open.map((x) => x.id)).not.toContain(i.id);
  expect((await send("POST", url(`/ideas/${i.id}/dismiss`), owner)).status).toBe(404);
  expect((await send("POST", url(`/ideas/${i.id}/dismiss`, W2), other)).status).toBe(404);
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  expect((await c.query("select dismissed_at from ideas where id = $1", [i.id])).rows[0].dismissed_at).toBeTruthy();
});
