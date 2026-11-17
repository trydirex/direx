// SPDX-License-Identifier: AGPL-3.0-only
// Runs over HTTP, with real sessions and roles and a real pg-boss delivering the wakes. Only the
// provider and the pages are fake.
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createBoss } from "../../jobs/boss";
import { createFacts, factKinds } from "../facts";
import { itemsApp } from "../items/fixtures/items";
import { createModels, routesFor, type Models } from "../models/index";
import { anthropicTool, fakeProvider, testKeys } from "../models/fixtures/provider";
import { inWorkspace, openOffer, readRun, recordProposal } from "./adapters/repo";
import { agentRoutes, createAgents, factContext, factSink, type Agents } from "./index";

const fake = fakeProvider();
const boss = createBoss();
await boss.start();
afterAll(async () => {
  await boss.stop({ graceful: false, close: true });
  await fake.stop();
});

const { routes, call, signIn, createOrg, addMember, items } = await itemsApp({ kinds: factKinds() });
const facts = createFacts({ items: () => items });
let deployment: "self_host" | "cloud" = "self_host";
const build = (dep: "self_host" | "cloud") => {
  let models: Models;
  const agents: Agents = createAgents({
    boss,
    deployment: dep,
    routes: routesFor(dep),
    models: () => models,
    sinks: { fact_proposal: factSink(facts) },
    addWarning: items.addWarning,
    context: factContext(facts),
    notify: async () => {},
    fetchPage: async (_b, url) => (url.endsWith("/gone") ? { ok: false, url, reason: "http_error" } : { ok: true, url, text: "We sell audits.", truncated: false, links: [new URL("gone", url).href] }),
  });
  models = createModels({ deployment: "self_host", keys: testKeys("sk-test"), baseURLs: { anthropic: fake.url }, runGate: agents.runGate });
  return agents;
};
const selfHost = build("self_host");
const cloud = build("cloud");
await selfHost.work();
routes.route("/", agentRoutes({ agents: () => (deployment === "cloud" ? cloud : selfHost) }));

const owner = await signIn();
const W = (await createOrg(owner)).workspace.id;
const marketer = (await addMember(owner, W, "marketer")).cookie;
const otherMarketer = (await addMember(owner, W, "marketer")).cookie;
const viewer = (await addMember(owner, W, "viewer")).cookie;

const url = (rest: string) => `/api/w/${W}/agents${rest}`;
type RunView = { id: string; status: string; statusReason: string | null; costMicros: string; address: string | null; unevaluated: boolean; proposalCount: number };
const start = (cookie: string, body: unknown) => call(url("/brand_reader/runs"), cookie, { method: "POST", body });
const startOk = async (cookie: string, body: unknown) => {
  const r = await start(cookie, body);
  expect(r.status).toBe(200);
  return (await r.json()) as RunView;
};
const detail = async (id: string) => (await (await call(url(`/runs/${id}`), owner)).json()) as RunView & { read: { kind: string; ref: string }[]; failedPages: unknown[]; proposals: { itemId: string | null }[] };
const ended = async (id: string) => {
  await expect.poll(async () => ["queued", "running"].includes((await detail(id)).status), { timeout: 15_000, interval: 100 }).toBe(false);
  return detail(id);
};

test("an address goes through the real queue to a warned Item, and the run says what it read and cost", { timeout: 20_000 }, async () => {
  const site = `https://${crypto.randomUUID()}.test/`;
  let n = 0;
  fake.respondWith(() => {
    n++;
    if (n === 1) return anthropicTool("fetch_page", { url: site });
    if (n === 2) return anthropicTool("fetch_page", { url: `${site}gone` });
    return anthropicTool("propose", { facts: [{ field: "claim", value: `Audits ${site}`, confidence: "high", page: site }] });
  });
  const run = await startOk(marketer, { url: site });
  expect(run).toMatchObject({ address: site, unevaluated: true });
  const d = await ended(run.id);
  expect(d).toMatchObject({ status: "succeeded", proposalCount: 1, failedPages: [{ address: `${site}gone`, reason: "http_error" }] });
  expect(d.read.map((p) => p.ref)).toContain(site);
  expect(BigInt(d.costMicros)).toBeGreaterThan(0n);
  // An API key bills per call; a run whose calls went through a subscription says so.
  expect(d).toMatchObject({ subscription: false });
  const db = await appClient();
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  await db.query("update model_calls set credential_kind = 'cli_subscription' where run_id = $1", [run.id]);
  await db.query("commit");
  await db.end();
  expect(await detail(run.id)).toMatchObject({ subscription: true });
  const item = (await items.view(W, d.proposals[0]!.itemId!))!;
  expect(item.warnings.map((w) => w.text)).toContain("came from content Direx doesn't trust");
  expect(await selfHost.report(W, run.id)).toEqual({ state: "done", itemIds: [d.proposals[0]!.itemId] });
  expect(await selfHost.report(W, crypto.randomUUID())).toBeNull();
  const listed = (await (await call(url("/runs"), viewer)).json()) as { runs: RunView[] };
  expect(listed.runs.map((r) => r.id)).toContain(run.id);
});

test("the same input the same day is the same run, but one that failed can be tried again", { timeout: 20_000 }, async () => {
  const text = `About us ${crypto.randomUUID()}`;
  fake.respondWith(() => anthropicTool("propose", { facts: [] }));
  const first = await startOk(marketer, { text });
  expect((await startOk(marketer, { text })).id).toBe(first.id);
  expect((await ended(first.id)).status).toBe("succeeded");
  expect((await startOk(marketer, { text })).id).toBe(first.id);

  const other = `Other ${crypto.randomUUID()}`;
  fake.respondWith(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "no" } }), { status: 400, headers: { "content-type": "application/json" } }));
  const failed = await startOk(marketer, { text: other });
  expect((await ended(failed.id)).status).toBe("failed");
  fake.respondWith(() => anthropicTool("propose", { facts: [] }));
  const again = await startOk(marketer, { text: other });
  expect(again.id).not.toBe(failed.id);
  await ended(again.id);
});

test("settled waits for a run loop this process is running, and is immediate with none", { timeout: 20_000 }, async () => {
  await selfHost.settled();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let reached = false;
  fake.respondWith(async () => {
    reached = true;
    await held;
    return anthropicTool("propose", { facts: [] });
  });
  const run = await startOk(marketer, { text: `Held ${crypto.randomUUID()}` });
  await expect.poll(() => reached, { timeout: 15_000, interval: 50 }).toBe(true);
  let done = false;
  const settled = selfHost.settled().then(() => (done = true));
  await Bun.sleep(200);
  expect(done).toBe(false);
  release();
  await settled;
  expect((await detail(run.id)).status).toBe("succeeded");
});

test("input is checked at the door, and a viewer can't start a run", async () => {
  expect((await start(marketer, { url: "file:///etc/passwd" })).status).toBe(400);
  expect((await start(marketer, { url: "https://a.test", text: "x" })).status).toBe(400);
  expect((await start(marketer, { text: "x".repeat(100_001) })).status).toBe(400);
  expect((await start(viewer, { text: "x" })).status).toBe(403);
});

test("the person who started a run or an Admin may cancel it, and no one else", { timeout: 20_000 }, async () => {
  fake.respondWith(async () => {
    await new Promise((r) => setTimeout(r, 400));
    return anthropicTool("propose", { facts: [] });
  });
  const cancel = (id: string, cookie: string) => call(url(`/runs/${id}/cancel`), cookie, { method: "POST" });
  const a = await startOk(marketer, { text: `Cancel me ${crypto.randomUUID()}` });
  expect((await cancel(a.id, otherMarketer)).status).toBe(403);
  expect((await cancel(a.id, viewer)).status).toBe(403);
  expect((await cancel(a.id, marketer)).status).toBe(200);
  expect((await cancel(a.id, marketer)).status).toBe(409);
  expect((await cancel(crypto.randomUUID(), marketer)).status).toBe(404);
  const b = await startOk(marketer, { text: `Admin cancels ${crypto.randomUUID()}` });
  expect((await cancel(b.id, owner)).status).toBe(200);
  expect((await detail(b.id)).status).toBe("cancelled");
});

test("a disabled agent refuses to start, each change is a revision, and only an Admin changes settings", async () => {
  const settings = url("/brand_reader/settings");
  const patch = (cookie: string, body: unknown) => call(settings, cookie, { method: "PATCH", body });
  expect(await (await call(settings, viewer)).json()).toMatchObject({ enabled: true, maxConcurrentRuns: 2, maxDailyRuns: 100 });
  expect((await patch(marketer, { enabled: false })).status).toBe(403);
  const before = ((await (await call(settings, viewer)).json()) as { revision: number }).revision;
  expect(await (await patch(owner, { enabled: false })).json()).toMatchObject({ enabled: false, revision: before + 1 });
  const refused = await start(marketer, { text: `Refused ${crypto.randomUUID()}` });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "disabled" });
  expect(await (await patch(owner, { enabled: true, maxDailyRuns: 2000 })).json()).toMatchObject({ enabled: true, maxDailyRuns: 2000, revision: before + 2 });
  expect((await patch(owner, { maxDailyRuns: 0 })).status).toBe(400);
  await patch(owner, { maxDailyRuns: 100 });
});

test("cloud has no route until an eval is recorded, and holds caps to its limits", async () => {
  deployment = "cloud";
  try {
    const refused = await start(marketer, { text: `Cloud ${crypto.randomUUID()}` });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "no_route" });
    const patch = (body: unknown) => call(url("/brand_reader/settings"), owner, { method: "PATCH", body });
    expect((await patch({ maxConcurrentRuns: 11 })).status).toBe(400);
    expect((await patch({ maxDailyRuns: 1001 })).status).toBe(400);
    expect((await patch({ maxConcurrentRuns: 10 })).status).toBe(200);
    await patch({ maxConcurrentRuns: 2 });
  } finally {
    deployment = "self_host";
  }
});

test("a scheduled run has no person behind it: no starter, trigger schedule", { timeout: 20_000 }, async () => {
  fake.respondWith(() => anthropicTool("propose", { facts: [] }));
  const started = await selfHost.start(W, { agent: "brand_reader", input: { text: `Scheduled ${crypto.randomUUID()}` }, schedule: true });
  expect(started.ok).toBe(true);
  const run = await inWorkspace(W, (tx) => readRun(tx, (started as { run: { id: string } }).run.id));
  expect(run).toMatchObject({ trigger: "schedule", startedBy: null });
  await ended(run!.id);
});

test("what an agent may still start today follows its daily cap and its Workspace's", async () => {
  const fresh = (await createOrg(owner)).workspace.id;
  expect(await selfHost.capsLeft(fresh, "brand_reader")).toEqual({ agentLeftToday: 100, agentPerDay: 100, workspaceLeftToday: 300, workspacePerDay: 300 });
  const patch = (body: unknown) => call(`/api/w/${fresh}/agents/brand_reader/settings`, owner, { method: "PATCH", body });
  expect((await patch({ maxDailyRuns: 7 })).status).toBe(200);
  expect(await selfHost.capsLeft(fresh, "brand_reader")).toMatchObject({ agentLeftToday: 7, agentPerDay: 7 });
});

test("a kept draft: anyone may read it, only who may save uses or dismisses it, and once", { timeout: 20_000 }, async () => {
  fake.respondWith(() => anthropicTool("propose", { facts: [] }));
  const r = await startOk(marketer, { url: "https://offer.example" });
  const planId = crypto.randomUUID();
  await inWorkspace(W, async (tx) => {
    await recordProposal(tx, { workspaceId: W, runId: r.id, outputKey: "plan", kind: "plan_proposal", routeHash: "r", at: new Date() });
    await openOffer(tx, r.id, "plan", { targetKind: "plan", targetId: planId, targetStepKey: null, body: { goal: "Kept" }, at: new Date() });
  });
  const offerUrl = `/api/w/${W}/drafts/offer`;
  const read = (q: string) => call(`${offerUrl}?${q}`, viewer);
  expect(await (await read(`target=plan&id=${planId}`)).json()).toMatchObject({ runId: r.id, outputKey: "plan", body: { goal: "Kept" }, costMicros: expect.any(String) });
  expect((await read("target=plan")).status).toBe(400);
  expect((await read(`target=step&id=${planId}`)).status).toBe(400);

  const act = (cookie: string, what: string, body?: unknown) => call(`${offerUrl}/${r.id}/plan/${what}`, cookie, { method: "POST", ...(body !== undefined && { body }) });
  expect((await act(viewer, "dismiss")).status).toBe(403);
  expect((await act(viewer, "use", { revision: 1 })).status).toBe(403);
  // This test app wires no plan sink, so a use is refused without changing anything.
  expect(await (await act(marketer, "use", { revision: 1 })).json()).toEqual({ error: "no_sink" });
  expect((await act(marketer, "dismiss")).status).toBe(200);
  expect(await (await act(marketer, "dismiss")).json()).toEqual({ error: "offer_closed" });
  expect((await read(`target=plan&id=${planId}`)).status).toBe(404);
});
