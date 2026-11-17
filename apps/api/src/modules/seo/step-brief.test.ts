// SPDX-License-Identifier: AGPL-3.0-only
// An SEO brief step from end to end, over real campaigns, plans, Items and seo, with the brief agent
// stood in for: Make brief, the Brief in the queue, approval, and the draft link as the step's output.
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import { createPlans, planKinds, type PlanBody, type StrategyBody } from "../plans/index";
import { campaignOnPlanApproved, campaignOnPlanCreated, createCampaigns, type StartDraft } from "../campaigns/index";
import { approvedBriefs } from "./adapters/briefs-repo";
import { briefSink, createBriefs, seoKinds, type StartBrief } from "./index";
import type { BriefInput } from "./application/briefs";
import type { PageRead } from "./application/read-page";

const world = await itemsWorld({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }), ...seoKinds() } });
const { W, items, who } = world;
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const actor = { userId: person.userId };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const window = { startDate: "2026-10-08", endDate: "2026-11-04" };
const PAGE_TEXT = "Acme pricing\nPlans start at 40 dollars a month.";
const read = (url: string): PageRead => ({ ok: true, url, finalUrl: url, title: "Acme pricing", metaDescription: null, html: "", text: PAGE_TEXT, truncated: false, readAt: new Date("2026-11-08T09:00:00Z") });

// The agent is stood in for: a start is recorded with its status, and the test hands over its Brief.
const runs = new Map<string, { input: BriefInput; status: string }>();
const start: StartBrief = async (_ws, a) => {
  const id = crypto.randomUUID();
  runs.set(id, { input: a.input, status: "running" });
  return { ok: true, run: { id } };
};
const briefs = createBriefs({
  seo: () => ({ pageNumbers: async () => ({ current: window, previous: window, numbers: {} }), candidates: async () => ({ ok: false, reason: "not_connected" }), briefsRun: async () => null, saveBriefsRun: async () => true, clicksOver: async () => null }),
  readPage: async (url) => (url.endsWith("/private") ? { ok: false, reason: "robots_disallowed" } : read(url)),
  start: () => start,
  workspaces: async () => [],
  runOf: () => async (_ws, runId) => {
    const r = runs.get(runId);
    return r && { status: r.status, statusReason: null, rejections: [] };
  },
});
const sink = briefSink({ items: () => items });
const handOver = async (runId: string, quote: string) => {
  const r = runs.get(runId)!;
  const gap = { label: "title", problem: "No price in the title.", where: "Title", quote, fix: "Add the price.", newText: ["Acme pricing from 40 dollars"], live: "The new title is in the source." };
  const made = await sink(W, { kind: "draft", outputKey: "seo_brief", body: { schemaVersion: 1, gaps: [gap], cantTell: null, steered: [] } }, { runId, input: r.input, tainted: true, pagesRead: [], pages: [], producer: {} as never });
  r.status = "succeeded";
  return made;
};

const noOutreach = () => {
  throw new Error("these tests add no people");
};
const noDraft: StartDraft = async () => ({ ok: false, reason: "not_here" });
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: noOutreach, startDraft: () => noDraft, briefs: () => ({ start: briefs.startForStep, get: briefs.stepBrief }) });
const onCloud = createCampaigns({ plans, facts, items: () => items, outreach: noOutreach, startDraft: () => noDraft, briefs: () => undefined });

const strategy: StrategyBody = {
  schemaVersion: 1,
  whoFor: "Heads of ecommerce ops",
  personas: [],
  positioning: "The audit that finds the error",
  channels: [{ key: "email", label: "Cold email", timing: "now", reason: "Ops leads read email", basis: { kind: "assumption" } }],
  assumptions: [],
};
const step = (key: string, on: string, title = key) => ({ key, on, channelKey: "email", title });
const planBody: PlanBody = {
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Shopify ops leads",
  startsOn: "2026-11-01",
  endsOn: "2026-11-30",
  steps: [step("page", "2026-11-02"), step("rank", "2026-11-03", "Rank the pricing page"), step("rank-new", "2026-11-04"), step("email-1", "2026-11-05")],
  measures: [{ key: "meetings", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [],
  assumptions: [],
};
const brief = { type: "seo_brief" as const, touchClass: null, mailboxCredentialId: null, audience: "everyone" as const };
const email = { type: "email" as const, touchClass: "cold" as const, mailboxCredentialId: null, audience: "everyone" as const };

let c: Awaited<ReturnType<typeof appClient>>;
let C: string;

beforeAll(async () => {
  c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  const { draftRevision } = await plans.strategy(W);
  const { revision } = ok(await plans.saveStrategyDraft(W, { revision: draftRevision, body: strategy }));
  const strategyItem = ok(await plans.submitStrategy(W, { revision, actor })).item;
  ok(await items.approve(W, strategyItem.id, strategyItem.revision, who));
  const planId = (await plans.createPlan(W, { title: "Autumn offer", createdBy: person.userId })).id;
  const plan = (await plans.plan(W, planId))!;
  const saved = ok(await plans.savePlanDraft(W, planId, { revision: plan.draftRevision, body: planBody }));
  const planItem = ok(await plans.submitPlan(W, planId, { revision: saved.revision, actor })).item;
  ok(await items.approve(W, planItem.id, planItem.revision, who));
  C = (await campaigns.list(W)).find((x) => x.planId === planId)!.id;
  ok(await campaigns.setupStep(W, C, "rank", brief));
  ok(await campaigns.setupStep(W, C, "rank-new", { ...brief, dependsOnStepKey: "page" }));
  ok(await campaigns.setupStep(W, C, "email-1", { ...email, dependsOnStepKey: "rank" }));
});
afterAll(() => c.end());

test("an SEO brief step has no touch class, and only a seo_brief step takes a Brief", async () => {
  expect(await campaigns.setupStep(W, C, "rank", { ...brief, touchClass: "cold" })).toEqual({ ok: false, reason: "touch_class_mismatch" });
  expect(await campaigns.makeBrief(W, C, "page", { page: "https://acme.test/pricing", query: "acme pricing" }, actor.userId)).toEqual({ ok: false, reason: "not_a_brief_step" });
  expect(await onCloud.makeBrief(W, C, "rank", { page: "https://acme.test/pricing", query: "acme pricing" }, actor.userId)).toEqual({ ok: false, reason: "cloud_unavailable" });
  expect(await onCloud.briefStep(W, C, "rank")).toMatchObject({ ok: true, available: false });
});

test("a bad page or search is refused and starts nothing", async () => {
  const before = runs.size;
  expect(await campaigns.makeBrief(W, C, "rank", { page: "http://acme.test/pricing", query: "acme pricing" }, actor.userId)).toEqual({ ok: false, reason: "bad_url" });
  expect(await campaigns.makeBrief(W, C, "rank", { page: null, query: "acme pricing" }, actor.userId)).toEqual({ ok: false, reason: "bad_url" });
  expect(await campaigns.makeBrief(W, C, "rank", { page: "https://acme.test/pricing", query: " a " }, actor.userId)).toEqual({ ok: false, reason: "bad_query" });
  expect(await campaigns.makeBrief(W, C, "rank", { page: "https://acme.test/private", query: "acme pricing" }, actor.userId)).toEqual({ ok: false, reason: "robots_disallowed" });
  expect(runs.size).toBe(before);
});

test("Make brief, the Brief in the queue, approval, then the draft link as the step's output", async () => {
  const { runId } = ok(await campaigns.makeBrief(W, C, "rank", { page: "https://acme.test/pricing", query: "acme pricing" }, actor.userId));
  expect(runs.get(runId)!.input).toMatchObject({ step: { campaignId: C, stepKey: "rank", campaign: "Autumn offer", step: "Rank the pricing page" }, candidate: { selector: "step", query: "acme pricing" } });
  expect(await campaigns.briefStep(W, C, "rank")).toEqual({ ok: true, setup: { page: "https://acme.test/pricing", query: "acme pricing" }, brief: { state: "running" }, available: true });
  expect(await campaigns.makeBrief(W, C, "rank", { page: "https://acme.test/pricing", query: "acme pricing" }, actor.userId)).toEqual({ ok: false, reason: "brief_running" });

  // A made-up quote makes no Brief, and the step can be tried again.
  expect(await handOver(runId, "The cheapest audit")).toMatchObject({ ok: false, code: expect.stringContaining("quote not on the page") });
  expect(await campaigns.briefStep(W, C, "rank")).toMatchObject({ brief: { state: "no_brief" } });

  const again = ok(await campaigns.makeBrief(W, C, "rank", { page: "https://acme.test/pricing", query: "acme pricing" }, actor.userId)).runId;
  const made = (await handOver(again, "Acme pricing")) as { itemId: string };
  expect(await campaigns.briefStep(W, C, "rank")).toMatchObject({ brief: { state: "waiting", itemId: made.itemId } });
  expect(await campaigns.makeBrief(W, C, "rank", { page: "https://acme.test/pricing", query: "acme pricing" }, actor.userId)).toEqual({ ok: false, reason: "brief_waiting" });
  expect((await items.detail(W, made.itemId))!.content).toMatchObject({ selector: "step", step: { campaignId: C, stepKey: "rank" } });

  expect(await campaigns.recordOutput(W, C, "rank", "https://acme.test/wp-admin/post.php?post=12", actor)).toEqual({ ok: false, reason: "brief_not_approved" });
  ok(await items.approve(W, made.itemId, (await items.view(W, made.itemId))!.revision, who));
  expect(await campaigns.briefStep(W, C, "rank")).toMatchObject({ brief: { state: "approved", itemId: made.itemId } });
  expect(await campaigns.makeBrief(W, C, "rank", { page: "https://acme.test/other", query: "acme pricing" }, actor.userId)).toEqual({ ok: false, reason: "brief_approved" });
  expect((await approvedBriefs(W)).at(-1)).toMatchObject({ itemId: made.itemId, selector: "step", pageUrl: "https://acme.test/pricing" });

  expect(ok(await campaigns.recordOutput(W, C, "rank", "https://acme.test/wp-admin/post.php?post=12", actor)).output).toMatchObject({ version: 1, source: "person" });
  const view = (await campaigns.campaign(W, C))!;
  expect(view.steps.find((s) => s.key === "email-1")).toMatchObject({ dependsOnStepKey: "rank", waitingOn: null });
  expect(view.steps.find((s) => s.key === "rank")).toMatchObject({ output: { url: "https://acme.test/wp-admin/post.php?post=12" } });
});

test("a step waiting on a page step briefs that step's output once it exists", async () => {
  expect(await campaigns.makeBrief(W, C, "rank-new", { page: "https://acme.test/pricing", query: "acme pricing" }, actor.userId)).toEqual({ ok: false, reason: "page_and_dependency" });
  const before = runs.size;
  expect(await campaigns.makeBrief(W, C, "rank-new", { page: null, query: "acme pricing" }, actor.userId)).toEqual({ ok: false, reason: "waiting_on_step", waitingOn: "page" });
  expect(runs.size).toBe(before);
  ok(await campaigns.recordOutput(W, C, "page", "https://acme.test/launch", actor));
  const { runId } = ok(await campaigns.makeBrief(W, C, "rank-new", { page: null, query: "acme pricing" }, actor.userId));
  expect(runs.get(runId)!.input.page.url).toBe("https://acme.test/launch");
  expect(await campaigns.briefStep(W, C, "rank-new")).toMatchObject({ setup: { page: null, query: "acme pricing" } });
});

test("a step that stops being an SEO brief step drops its page, search and run", async () => {
  ok(await campaigns.setupStep(W, C, "rank-new", { type: "manual", touchClass: "cold", mailboxCredentialId: null, audience: "everyone", dependsOnStepKey: "page" }));
  const { rows } = await c.query("select seo_setup, brief_run_id from campaign_steps where campaign_id = $1 and step_key = 'rank-new'", [C]);
  expect(rows).toEqual([{ seo_setup: null, brief_run_id: null }]);
});
