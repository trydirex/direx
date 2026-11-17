// SPDX-License-Identifier: AGPL-3.0-only
// Strategy and plans over HTTP, with real sessions and each role going through the real flow.
import { expect, test } from "vitest";
import { createFacts, factKinds } from "../facts/index";
import { itemsApp } from "../items/fixtures/items";
import { createPlans, draftRuns, planAskStarts, planKinds, planRoutes, type StartDraft } from "./index";
import { campaignOnPlanCreated } from "../campaigns/index";

const { routes, call, signIn, createOrg, addMember, items } = await itemsApp({ kinds: { ...factKinds(), ...planKinds() } });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
let startReply: Awaited<ReturnType<StartDraft>> = { ok: true, run: { id: crypto.randomUUID() } };
const started: Parameters<StartDraft>[1][] = [];
const startDraft: StartDraft = async (_w, a) => {
  started.push(a);
  return startReply;
};
routes.route("/", planRoutes({ plans: () => plans, startDraft }));

const owner = await signIn();
const W = (await createOrg(owner)).workspace.id;
const roles = {
  marketer: (await addMember(owner, W, "marketer")).cookie,
  contributor: (await addMember(owner, W, "contributor")).cookie,
  viewer: (await addMember(owner, W, "viewer")).cookie,
};
const url = (rest = "") => `/api/w/${W}${rest}`;
const send = (method: string, path: string, cookie: string, body?: unknown) => call(path, cookie, { method, ...(body !== undefined && { body }) });
const strategy = {
  schemaVersion: 1,
  whoFor: "Heads of ecommerce ops",
  personas: [],
  positioning: "The audit that finds the error",
  channels: [{ key: "email", label: "Cold email", timing: "now", reason: "Ops leads read email", basis: { kind: "assumption" } }],
  assumptions: [],
};
const plan = {
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Shopify ops leads",
  startsOn: "2026-11-01",
  endsOn: "2026-11-30",
  steps: [{ key: "first", on: "2026-11-03", title: "First email" }],
  measures: [{ key: "meetings", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [],
  assumptions: [],
};
type Waiting = { id: string; revision: number };
const approve = (w: Waiting, cookie = owner) => send("POST", url(`/items/${w.id}/approve`), cookie, { revision: w.revision });
const newPlan = async (cookie = owner) => ((await (await send("POST", url("/plans"), cookie, { title: "Q4" })).json()) as { id: string }).id;
const getPlan = async (id: string) => (await (await call(url(`/plans/${id}`), owner)).json()) as { waiting: Waiting | null; currentVersion: number | null; tracking: { done: number; measures: { latest: { source: string } | null }[] } | null };

test("a Contributor writes and submits, and can't approve; a Marketer approves", async () => {
  expect((await send("PUT", url("/strategy/draft"), roles.contributor, { revision: 0, body: strategy })).status).toBe(200);
  expect((await send("POST", url("/strategy/submit"), roles.contributor, { revision: 1 })).status).toBe(200);
  const { waiting } = (await (await call(url("/strategy"), roles.contributor)).json()) as { waiting: Waiting };
  expect((await approve(waiting, roles.contributor)).status).toBe(403);
  expect((await approve(waiting, roles.marketer)).status).toBe(200);
  expect((await (await call(url("/strategy"), roles.viewer)).json()) as object).toMatchObject({ currentVersion: 1, waiting: null });
});

test("a Viewer only reads, on every writing route", async () => {
  const id = await newPlan();
  expect((await call(url("/plans"), roles.viewer)).status).toBe(200);
  expect((await call(url(`/plans/${id}`), roles.viewer)).status).toBe(200);
  expect((await call(url(`/plans/${id}/versions`), roles.viewer)).status).toBe(200);
  expect((await call(url("/strategy/versions"), roles.viewer)).status).toBe(200);
  const writes: [string, string, unknown?][] = [
    ["PUT", "/strategy/draft", { revision: 0, body: {} }],
    ["POST", "/strategy/submit", { revision: 0 }],
    ["POST", "/plans", { title: "x" }],
    ["PUT", `/plans/${id}/draft`, { revision: 0, body: {} }],
    ["POST", `/plans/${id}/submit`, { revision: 0 }],
    ["POST", `/plans/${id}/archive`],
    ["POST", `/plans/${id}/steps/first/progress`, { status: "done" }],
    ["POST", `/plans/${id}/measures/meetings/readings`, { value: "1", observedOn: "2026-11-01" }],
  ];
  for (const [method, path, body] of writes) expect((await send(method, url(path), roles.viewer, body)).status, `${method} ${path}`).toBe(403);
});

test("a whole plan by hand: draft, submit, approve, track", async () => {
  const id = await newPlan(roles.contributor);
  expect((await send("PUT", url(`/plans/${id}/draft`), roles.contributor, { revision: 0, body: plan })).status).toBe(200);
  expect((await send("POST", url(`/plans/${id}/submit`), roles.contributor, { revision: 1 })).status).toBe(200);
  expect((await approve((await getPlan(id)).waiting!, roles.marketer)).status).toBe(200);
  expect((await getPlan(id)).currentVersion).toBe(1);

  expect((await send("POST", url(`/plans/${id}/steps/first/progress`), roles.contributor, { status: "done" })).status).toBe(200);
  expect((await send("POST", url(`/plans/${id}/measures/meetings/readings`), roles.contributor, { value: "2", observedOn: "2026-11-10" })).status).toBe(200);
  const { tracking } = await getPlan(id);
  expect(tracking!.done).toBe(1);
  expect(tracking!.measures[0]!.latest!.source).toBe("person");
  expect(((await (await call(url(`/plans/${id}/versions`), owner)).json()) as { versions: unknown[] }).versions.length).toBe(1);
});

test("refusals are named: incomplete says what's missing, the rest get 409 or 404", async () => {
  const id = await newPlan();
  await send("PUT", url(`/plans/${id}/draft`), owner, { revision: 0, body: { goal: "x" } });
  const incomplete = await send("POST", url(`/plans/${id}/submit`), owner, { revision: 1 });
  expect(incomplete.status).toBe(409);
  const { error, missing } = (await incomplete.json()) as { error: string; missing: { path: string }[] };
  expect(error).toBe("incomplete");
  expect(missing.map((m) => m.path)).toContain("audience");

  expect((await send("PUT", url(`/plans/${id}/draft`), owner, { revision: 0, body: {} })).status).toBe(409);
  expect((await send("POST", url(`/plans/${id}/steps/first/progress`), owner, { status: "done" })).status).toBe(409);
  expect((await call(url(`/plans/${crypto.randomUUID()}`), owner)).status).toBe(404);
  expect((await send("POST", url(`/plans/${crypto.randomUUID()}/archive`), owner)).status).toBe(404);
});

test("starting a draft: the plan's own request and the session's person, by role, and refusals in words", async () => {
  const id = ((await (await send("POST", url("/plans"), owner, { title: "Q4", request: "Book 4 demos" })).json()) as { id: string }).id;
  expect((await send("POST", url(`/plans/${id}/draft-run`), roles.viewer)).status).toBe(403);
  expect((await send("POST", url("/strategy/draft-run"), roles.viewer, { request: "x" })).status).toBe(403);
  expect((await send("POST", url(`/plans/${id}/draft-run`), roles.contributor)).status).toBe(200);
  expect(started.at(-1)).toMatchObject({ agent: "plan_drafter", input: { request: "Book 4 demos", target: { id, draftRevision: 0 } } });
  expect(started.at(-1)!.input.brief.map((b) => b.kind)).toEqual(["date", "citable_facts", "strategy"]);

  expect((await send("POST", url("/strategy/draft-run"), owner, { request: "Sell audits" })).status).toBe(200);
  expect(started.at(-1)).toMatchObject({ agent: "strategy_drafter", input: { request: "Sell audits" } });
  expect((await send("POST", url("/strategy/draft-run"), owner, { request: " " })).status).toBe(400);

  const none = await newPlan();
  expect(await (await send("POST", url(`/plans/${none}/draft-run`), owner)).json()).toEqual({ error: "no_request" });
  expect((await send("POST", url(`/plans/${crypto.randomUUID()}/draft-run`), owner)).status).toBe(404);
  startReply = { ok: false, reason: "no_route" };
  const refused = await send("POST", url(`/plans/${id}/draft-run`), owner);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "no_route" });
  startReply = { ok: true, run: { id: crypto.randomUUID() } };
});

test("Ask's plan starts are the buttons' own calls, carry the key and taint, and refuse as the buttons do", async () => {
  const reports: string[] = [];
  const starts = planAskStarts({ plans: () => plans, runs: draftRuns({ plans: () => plans, startDraft }), report: async (_w, runId) => (reports.push(runId), { state: "done", itemIds: [] }) });
  expect(starts.map((s) => [s.id, s.definition, s.permission, s.area])).toEqual([
    ["draft_strategy", "strategy_drafter", "item.edit", null],
    ["draft_plan", "plan_drafter", "item.edit", null],
  ]);
  const [strategyStart, planStart] = starts as [(typeof starts)[number], (typeof starts)[number]];
  expect(strategyStart.args.safeParse({ request: " " }).success).toBe(false);

  const id = ((await (await send("POST", url("/plans"), owner, { title: "Spring", request: "Book 4 demos" })).json()) as { id: string }).id;
  expect(await planStart.check(W, { planId: crypto.randomUUID() })).toEqual({ ok: false, why: "not_found" });
  expect(await planStart.check(W, { planId: await newPlan() })).toEqual({ ok: false, why: "no_request" });
  const before = await planStart.check(W, { planId: id });
  expect(before).toMatchObject({ ok: true, title: 'Draft the plan "Spring"' });
  expect((await send("PUT", url(`/plans/${id}/draft`), owner, { revision: 0, body: { goal: "x" } })).status).toBe(200);
  const after = await planStart.check(W, { planId: id });
  expect(after.ok && before.ok && after.basis !== before.basis).toBe(true);

  const run = crypto.randomUUID();
  startReply = { ok: true, run: { id: run } };
  expect(await planStart.start(W, { planId: id }, { userId: "u1", key: "item-1", tainted: true })).toEqual({ ok: true, work: { kind: "agent_run", id: run } });
  expect(started.at(-1)).toMatchObject({ agent: "plan_drafter", startedBy: "u1", key: "item-1", tainted: true, input: { request: "Book 4 demos" } });
  expect(await strategyStart.start(W, { request: "Sell audits" }, { userId: "u1", key: "item-2", tainted: false })).toEqual({ ok: true, work: { kind: "agent_run", id: run } });
  expect(started.at(-1)).toMatchObject({ agent: "strategy_drafter", key: "item-2", tainted: false, input: { request: "Sell audits" } });
  expect(await strategyStart.check(W, { request: "Sell audits" })).toMatchObject({ ok: true, title: "Draft the Strategy" });

  startReply = { ok: false, reason: "disabled" };
  expect(await planStart.start(W, { planId: id }, { userId: "u1", key: "item-3", tainted: false })).toEqual({ ok: false, why: "disabled" });
  expect(await planStart.start(W, { planId: crypto.randomUUID() }, { userId: "u1", key: "item-4", tainted: false })).toEqual({ ok: false, why: "not_found" });
  startReply = { ok: true, run: { id: crypto.randomUUID() } };

  expect(await planStart.report(W, { kind: "agent_run", id: run })).toEqual({ state: "done", itemIds: [] });
  expect(await planStart.report(W, { kind: "clip_run", id: run })).toBeNull();
  expect(reports).toEqual([run]);
});

test("an actor, or a body too large, is rejected at the door", async () => {
  const id = await newPlan();
  expect((await send("POST", url(`/plans/${id}/submit`), owner, { revision: 0, actor: "someone" })).status).toBe(400);
  expect((await send("PUT", url(`/plans/${id}/draft`), owner, { revision: 0, body: { goal: "x".repeat(200_001) } })).status).toBe(400);
  expect((await send("POST", url(`/plans/${id}/measures/m/readings`), owner, { value: "1", observedOn: "soon" })).status).toBe(400);
  expect((await send("POST", url("/plans"), owner, { title: "  " })).status).toBe(400);
});
