// SPDX-License-Identifier: AGPL-3.0-only
// Step links through the module's entry point, with real plans: which step may wait on which, and a
// manual step's output recorded as versions that are never changed or removed.
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createFacts, factKinds } from "../facts/index";
import { itemsWorld, person } from "../items/fixtures/items";
import { createPlans, planKinds, type PlanBody, type StrategyBody } from "../plans/index";
import { campaignOnPlanApproved, campaignOnPlanCreated, createCampaigns, type StartDraft } from "./index";

const world = await itemsWorld({ kinds: { ...factKinds(), ...planKinds({ onPlanApproved: campaignOnPlanApproved({ items: () => items }) }) } });
const { W, items, who } = world;
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const noOutreach = () => {
  throw new Error("these tests add no people");
};
const noDraft: StartDraft = async () => ({ ok: false, reason: "not_here" });
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: noOutreach, startDraft: () => noDraft });
const actor = { userId: person.userId };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};

const strategy: StrategyBody = {
  schemaVersion: 1,
  whoFor: "Heads of ecommerce ops",
  personas: [],
  positioning: "The audit that finds the error",
  channels: [{ key: "email", label: "Cold email", timing: "now", reason: "Ops leads read email", basis: { kind: "assumption" } }],
  assumptions: [],
};
const step = (key: string, on: string) => ({ key, on, channelKey: "email", title: key });
const planBody: PlanBody = {
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Shopify ops leads",
  startsOn: "2026-11-01",
  endsOn: "2026-11-30",
  steps: [step("page", "2026-11-02"), step("launch-post", "2026-11-03"), step("email-1", "2026-11-04"), step("email-2", "2026-11-05"), step("dm-1", "2026-11-06")],
  measures: [{ key: "meetings", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [],
  assumptions: [],
};

const email = { type: "email" as const, touchClass: "cold" as const, mailboxCredentialId: null, audience: "everyone" as const };
const post = { type: "post" as const, touchClass: null, mailboxCredentialId: null, audience: "everyone" as const };
const manual = { type: "manual" as const, touchClass: "cold" as const, mailboxCredentialId: null, audience: "everyone" as const };
const dm = { type: "dm" as const, touchClass: "cold" as const, mailboxCredentialId: null, audience: "everyone" as const, dmChannel: "linkedin" as const };

let c: Awaited<ReturnType<typeof appClient>>;
let C: string;
const dependsOn = async (key: string) =>
  (await c.query("select depends_on_step_key from campaign_steps where campaign_id = $1 and step_key = $2", [C, key])).rows[0]?.depends_on_step_key ?? null;

beforeAll(async () => {
  c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  const { draftRevision } = await plans.strategy(W);
  const { revision } = ok(await plans.saveStrategyDraft(W, { revision: draftRevision, body: strategy }));
  const strategyItem = ok(await plans.submitStrategy(W, { revision, actor })).item;
  ok(await items.approve(W, strategyItem.id, strategyItem.revision, who));
  const planId = (await plans.createPlan(W, { title: "Launch", createdBy: person.userId })).id;
  const plan = (await plans.plan(W, planId))!;
  const saved = ok(await plans.savePlanDraft(W, planId, { revision: plan.draftRevision, body: planBody }));
  const planItem = ok(await plans.submitPlan(W, planId, { revision: saved.revision, actor })).item;
  ok(await items.approve(W, planItem.id, planItem.revision, who));
  C = (await campaigns.list(W)).find((x) => x.planId === planId)!.id;
  ok(await campaigns.setupStep(W, C, "dm-1", dm));
  ok(await campaigns.setupStep(W, C, "launch-post", post));
});
afterAll(() => c.end());

test("an email can wait on a manual step, which gets its own row as a manual step", async () => {
  ok(await campaigns.setupStep(W, C, "email-1", { ...email, dependsOnStepKey: "page" }));
  expect(await dependsOn("email-1")).toBe("page");
  const page = await c.query("select type from campaign_steps where campaign_id = $1 and step_key = 'page'", [C]);
  expect(page.rows).toEqual([{ type: "manual" }]);
});

test("an email can wait on a post step", async () => {
  ok(await campaigns.setupStep(W, C, "email-2", { ...email, dependsOnStepKey: "launch-post" }));
  expect(await dependsOn("email-2")).toBe("launch-post");
  ok(await campaigns.setupStep(W, C, "email-2", { ...email, dependsOnStepKey: null }));
  expect(await dependsOn("email-2")).toBeNull();
});

test("a refused dependency names its reason and saves nothing", async () => {
  const cases = [
    ["email-2", "email-2", "dependency_self"],
    ["email-2", "nowhere", "dependency_not_found"],
    ["email-2", "dm-1", "no_output"],
    ["email-2", "email-1", "dependency_depth"],
  ] as const;
  for (const [key, target, reason] of cases) expect(await campaigns.setupStep(W, C, key, { ...email, dependsOnStepKey: target })).toEqual({ ok: false, reason });
  expect(await dependsOn("email-2")).toBeNull();
});

test("a step others wait on can't start waiting itself, or stop producing an output", async () => {
  expect(await campaigns.setupStep(W, C, "page", { ...manual, dependsOnStepKey: "launch-post" })).toEqual({ ok: false, reason: "dependency_depth" });
  expect(await campaigns.setupStep(W, C, "page", email)).toEqual({ ok: false, reason: "has_dependants" });
  expect(await dependsOn("page")).toBeNull();
});

test("only a post step names an output account, and only one of its own", async () => {
  expect(await campaigns.setupStep(W, C, "launch-post", { ...post, outputConnection: "linkedin", outputNetworkId: "nobody" })).toEqual({ ok: false, reason: "output_account_not_on_step" });
  expect(await campaigns.setupStep(W, C, "email-2", { ...email, outputConnection: "linkedin", outputNetworkId: "n1" })).toEqual({ ok: false, reason: "output_account_not_on_step" });
});

test("a manual step's URL is kept as versions, and the same URL again adds nothing", async () => {
  expect(await campaigns.currentOutput(W, C, "page")).toBeNull();
  const first = ok(await campaigns.recordOutput(W, C, "page", " https://acme.co/launch ", actor)).output;
  expect(first).toMatchObject({ stepKey: "page", url: "https://acme.co/launch", version: 1, source: "person" });
  expect(await campaigns.recordOutput(W, C, "page", "https://acme.co/launch", actor)).toEqual({ ok: false, reason: "same_url" });
  ok(await campaigns.recordOutput(W, C, "page", "https://acme.co/launch-v2", actor));
  expect(await campaigns.currentOutput(W, C, "page")).toMatchObject({ url: "https://acme.co/launch-v2", version: 2 });
  const rows = await c.query("select version, url, actor_user_id from campaign_step_outputs where campaign_id = $1 order by version", [C]);
  expect(rows.rows).toEqual([
    { version: 1, url: "https://acme.co/launch", actor_user_id: person.userId },
    { version: 2, url: "https://acme.co/launch-v2", actor_user_id: person.userId },
  ]);
});

test("a bad URL, a step that isn't manual, or one outside the plan is refused", async () => {
  for (const bad of ["http://acme.co", "https://sam:pw@acme.co", "nope"]) expect(await campaigns.recordOutput(W, C, "page", bad, actor)).toEqual({ ok: false, reason: "bad_url" });
  expect(await campaigns.recordOutput(W, C, "email-1", "https://acme.co/x", actor)).toEqual({ ok: false, reason: "not_manual" });
  expect(await campaigns.recordOutput(W, C, "nowhere", "https://acme.co/x", actor)).toEqual({ ok: false, reason: "step_not_in_plan" });
  expect(await campaigns.recordOutput(W, crypto.randomUUID(), "page", "https://acme.co/x", actor)).toEqual({ ok: false, reason: "not_found" });
});

test("a post step's output is the link of its chosen account's post, versioned as it appears and changes", async () => {
  const addPost = async (networkId: string) => {
    const item = await c.query(
      `insert into items (workspace_id, kind, state, title, warnings, created_at, updated_at)
       values ($1, 'social_post', 'needs_approval', 'Launch post', '[]', now(), now()) returning id`,
      [W],
    );
    await c.query("insert into social_posts (workspace_id, campaign_id, step_key, connection, network_id, item_id, created_at) values ($1, $2, 'launch-post', 'linkedin', $3, $4, now())", [W, C, networkId, item.rows[0].id]);
  };
  const posted = (networkId: string, url: string | null) => c.query("update social_posts set posted_url = $1 where campaign_id = $2 and network_id = $3", [url, C, networkId]);
  await addPost("n1");
  await addPost("n2");
  ok(await campaigns.setupStep(W, C, "launch-post", { ...post, outputConnection: "linkedin", outputNetworkId: "n1" }));
  expect(await campaigns.currentOutput(W, C, "launch-post")).toBeNull();

  await posted("n2", "https://linkedin.example/other");
  expect(await campaigns.currentOutput(W, C, "launch-post")).toBeNull();
  await posted("n1", "https://linkedin.example/p/1");
  expect(await campaigns.currentOutput(W, C, "launch-post")).toMatchObject({ url: "https://linkedin.example/p/1", version: 1, source: "system" });
  expect(await campaigns.currentOutput(W, C, "launch-post")).toMatchObject({ version: 1 });

  await posted("n1", "http://linkedin.example/p/1");
  expect(await campaigns.currentOutput(W, C, "launch-post")).toMatchObject({ url: "https://linkedin.example/p/1", version: 1 });
  await posted("n1", "https://linkedin.example/p/1-edited");
  expect(await campaigns.currentOutput(W, C, "launch-post")).toMatchObject({ url: "https://linkedin.example/p/1-edited", version: 2 });
  const rows = await c.query("select actor_system, actor_user_id from campaign_step_outputs where campaign_id = $1 and step_key = 'launch-post'", [C]);
  expect(rows.rows).toEqual([
    { actor_system: "social_post", actor_user_id: null },
    { actor_system: "social_post", actor_user_id: null },
  ]);
  expect(await campaigns.recordOutput(W, C, "launch-post", "https://acme.co/x", actor)).toEqual({ ok: false, reason: "not_manual" });
});

test("an output version can't be changed or removed by the app", async () => {
  await expect(c.query("update campaign_step_outputs set url = 'https://evil.example' where campaign_id = $1", [C])).rejects.toThrow(/permission denied/);
  await expect(c.query("delete from campaign_step_outputs where campaign_id = $1", [C])).rejects.toThrow(/permission denied/);
});
