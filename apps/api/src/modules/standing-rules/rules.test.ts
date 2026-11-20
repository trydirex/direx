// SPDX-License-Identifier: AGPL-3.0-only
// The whole flow on the real ledger, floors and Gmail plugin against a fake Gmail: grant, match, send,
// and everything that stops a rule, at claim and at dispatch.
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, expect, test, vi } from "vitest";
import { appClient } from "../../../../../test/db";
import { campaignCheck, campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, campaignRulePort, createCampaigns, templateVersion } from "../campaigns/index";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { createFacts, describeFactChange, factKinds, factVersion } from "../facts/index";
import { approverMayApprove, mayGrantRules, workspaceLive } from "../identity/index";
import { createItems, itemRoutes } from "../items/index";
import { TEST_SECRET, testIdentity, testLedger } from "../outreach/fixtures/support";
import { createOutreach, outreachFloors } from "../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../plans/index";
import { loadPlugins } from "../plugins/index";
import { touchCheck } from "../schedule/index";
import { createStandingRules, OFFER_KIND, ruleStillCovers, standingRuleKinds, standingRuleRoutes, suspendForAgent, suspendOnProviderLimit, suspendOnStale } from "./index";
import { inWorkspace } from "./adapters/repo";
import { passMailboxCheck } from "../outreach/fixtures/support";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;

const SEND = "com.trydirex.gmail/email.send";
const fake = startFakeGmail();
afterAll(() => fake.stop());
const plugins = loadPlugins({
  sources: [{ mode: "in_process", plugin: createGmailPlugin({ baseUrl: fake.url, timeoutMs: 1000 }) }],
  credentials: async () => ({ accessToken: fake.token, expiresAt: "" }),
  confinement: "none",
  log: () => {},
});
const CAPABILITY = plugins.capabilityVersion(SEND)!;
let capabilityNow = CAPABILITY;
let afterClaim: (() => Promise<void>) | null = null;
const { clock, ledger } = await testLedger({
  effects: plugins.effects,
  resolvers: { credential: credentialLabel, fact: factVersion, template: templateVersion, capability: async () => capabilityNow },
  checks: [workspaceLive(), outreachFloors(async () => true), campaignCheck(), ruleStillCovers({ port: campaignRulePort, now: () => clock.at, mayGrant: mayGrantRules }), approverMayApprove(), touchCheck({ effects: plugins.effects, now: () => clock.at }), credentialReady],
  now: () => clock.at,
  onRuleStale: suspendOnStale({ now: () => clock.at }),
  onProviderLimit: suspendOnProviderLimit({ now: () => clock.at }),
  onStep: async (step) => {
    if (step === "claim" && afterClaim) await afterClaim();
  },
});
const now = () => clock.at;
const rules = createStandingRules({ ledger, port: campaignRulePort, now, mayGrant: mayGrantRules, items: () => items });
const items = createItems({ ledger, now, kinds: { ...standingRuleKinds(), ...factKinds(), ...planKinds({ now, onPlanApproved: campaignOnPlanApproved({ now, items: () => items }) }), ...campaignKinds({ now }) }, describeChange: describeFactChange, onSubmitted: rules.onSubmitted, onApproved: rules.onApproved, ruleApprovalBy: rules.ruleApprovalBy });
const outreach = createOutreach({
  items: () => items,
  send: () => ({ id: SEND, dedupe: "queryable", version: capabilityNow, prepare: (ws, input) => plugins.prepare(ws, SEND, input) }),
  baseUrl: () => "http://direx.test",
  now,
});
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: () => async () => ({ ok: false, reason: "not_here" }), now });

const { routes, signIn, createOrg, call, addMember } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", itemRoutes({ items: () => items }));
(routes as unknown as OpenAPIHono).route("/", standingRuleRoutes({ rules: () => rules }));
const cookie = await signIn();
const W = (await createOrg(cookie, "Acme")).workspace.id;
const db = await appClient();
afterAll(() => db.end());
async function q(text: string, params: unknown[] = []) {
  await db.query("begin");
  try {
    await db.query("select set_config('app.workspace_id', $1, true)", [W]);
    const r = await db.query(text, params);
    await db.query("commit");
    return r.rows;
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}
const owner = (await q("select user_id from workspace_members"))[0].user_id as string;
const actor = { userId: owner };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now });
const made = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: "me@acme.test", name: "me", meta: {}, value: { key: "x" } });
if (!made.ok) throw new Error(made.reason);
const mailbox = made.credential.id;
await q("update credentials set kind = 'oauth2', scope = 'user', owner_user_id = $1, connection = 'google' where id = $2", [owner, mailbox]);
await passMailboxCheck(W, mailbox);
await outreach.saveIdentity(W, { senderName: "Sam at Acme", postalAddress: "1 Main St" });

async function approve(id: string) {
  const { item } = (await (await call(`/api/w/${W}/items/${id}`, cookie)).json()) as { item: { revision: number } };
  return call(`/api/w/${W}/items/${id}/approve`, cookie, { method: "POST", body: { revision: item.revision } });
}
const strategy = ok(
  await plans.saveStrategyDraft(W, { revision: 0, body: { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] } }),
);
expect((await approve(ok(await plans.submitStrategy(W, { revision: strategy.revision, actor })).item.id)).status).toBe(200);
const body: PlanBody = {
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Ops",
  startsOn: "2026-11-02",
  endsOn: "2026-11-30",
  steps: [{ key: "first", on: "2026-11-03", title: "First" }],
  measures: [{ key: "m", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [],
  assumptions: [],
};
const source = { kind: "person", label: "Sam" } as const;
const person = () => `${crypto.randomUUID()}@acme.test,Kim,Acme,US,published_address,Their contact page`;
const addPeople = async (id: string, n: number) =>
  ok(await campaigns.addPeople(W, id, { csv: `email,first_name,company,country,basis,evidence\n${Array.from({ length: n }, person).join("\n")}`, userId: owner }));
const seen = new Set<string>();
/** Only the drafts this call made: making again also lists the ones already there. */
const make = async (id: string) => {
  const all = ok(await campaigns.makeDrafts(W, id, "first", { timeZone: "UTC", userId: owner })).results.map((r) => r.itemId!).filter(Boolean);
  const fresh = all.filter((i) => !seen.has(i));
  fresh.forEach((i) => seen.add(i));
  return fresh;
};

/** A campaign whose first email a person approved, citing one fact. */
async function step() {
  const subject = `s-${crypto.randomUUID()}`;
  const fact = ok(await facts.set(W, { field: "price", subject, value: "$100", source, confidence: "high", actor }));
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: owner });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  expect((await approve(ok(await plans.submitPlan(W, plan.id, { revision, actor })).item.id)).status).toBe(200);
  const id = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
  ok(await campaigns.setDraftingMode(W, id, "template"));
  ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
  ok(await campaigns.saveTemplate(W, id, "first", { revision: 0, subject: "Hi {{firstName}}", text: "Hello {{firstName}}.", userId: owner }));
  const factId = fact.id;
  await q("update campaign_steps set template = jsonb_set(template, '{citations}', $1::jsonb) where campaign_id = $2", [JSON.stringify([{ factId, version: 1 }]), id]);
  await addPeople(id, 1);
  const [first] = await make(id);
  expect((await approve(first!)).status).toBe(200);
  return { id, first: first!, factId, subject };
}
const grant = async (id: string, dailyCap = 50) => ok(await rules.grant(W, { campaignId: id, stepKey: "first", dailyCap }, actor)).rule;
const actionOf = async (itemId: string) => (await q("select action_id from items where id = $1", [itemId]))[0].action_id as string;
const stateOf = async (itemId: string) => (await items.view(W, itemId))!.state;
async function runAtSlot(action: string) {
  const start = clock.at;
  const before = fake.sent.length;
  clock.at = (await q("select due_at from actions where id = $1", [action]))[0].due_at as Date;
  await ledger.run(W, action);
  clock.at = start;
  return fake.sent.length - before;
}

test("a grant needs permission and an approved, clean email of this revision", async () => {
  const { id } = await step();
  const nobody = crypto.randomUUID();
  expect(await rules.grant(W, { campaignId: id, stepKey: "first", dailyCap: 5 }, { userId: nobody })).toEqual({ ok: false, reason: "forbidden" });
  expect(await rules.grant(W, { campaignId: crypto.randomUUID(), stepKey: "first", dailyCap: 5 }, actor)).toEqual({ ok: false, reason: "not_found" });
  expect(await rules.grant(W, { campaignId: id, stepKey: "first", dailyCap: 5, expiresAt: new Date(clock.at.getTime() + 100 * 86_400_000) }, actor)).toEqual({ ok: false, reason: "bad_expiry" });

  await q("update campaign_steps set template_revision = template_revision + 1 where campaign_id = $1", [id]);
  expect(await rules.grant(W, { campaignId: id, stepKey: "first", dailyCap: 5 }, actor)).toEqual({ ok: false, reason: "no_approved_email" });
  await q("update campaign_steps set template_revision = template_revision - 1 where campaign_id = $1", [id]);

  const before = await q("select i.id from items i join campaign_actions c on c.action_id = i.action_id where c.campaign_id = $1", [id]);
  await q("update items set warnings = '[{\"code\":\"unspecified\",\"text\":\"careful\"}]' where id = $1", [before[0].id]);
  expect(await rules.grant(W, { campaignId: id, stepKey: "first", dailyCap: 5 }, actor)).toEqual({ ok: false, reason: "warned_item" });
  await q("update items set warnings = '[]' where id = $1", [before[0].id]);

  const action = await actionOf(before[0].id);
  await q("update actions set dedupe_class = 'blind' where id = $1", [action]);
  expect(await rules.grant(W, { campaignId: id, stepKey: "first", dailyCap: 5 }, actor)).toEqual({ ok: false, reason: "blind_capability" });
  await q("update actions set dedupe_class = 'queryable' where id = $1", [action]);

  const rule = await grant(id);
  expect(rule).toMatchObject({ grantedBy: owner, status: "active", templateRevision: 1, capabilityHash: CAPABILITY });
  expect(rule.facts).toHaveLength(1);
});

test("with a rule, waiting and new Items are scheduled with no person, history names it, and it sends", async () => {
  const { id } = await step();
  await addPeople(id, 2);
  const [waiting, next] = await make(id);
  expect(await stateOf(waiting!)).toBe("needs_approval");
  void next;
  await grant(id);
  expect(await stateOf(waiting!)).toBe("scheduled");
  const action = await actionOf(waiting!);
  expect((await q("select approver_id, standing_rule_id from approvals where action_id = $1", [action]))[0]).toMatchObject({ approver_id: owner });
  expect((await ledger.getEvents(W, action)).at(-1)).toMatchObject({ actorSystem: "standing_rule" });
  expect(await runAtSlot(action)).toBe(1);
  expect(await stateOf(waiting!)).toBe("sent");
});

test("a daily cap approves exactly that many; the rest wait with the reason, and a person can still approve", async () => {
  const { id } = await step();
  await addPeople(id, 5);
  const waiting = await make(id);
  expect(waiting).toHaveLength(5);
  await grant(id, 3);
  const views = await Promise.all(waiting.map((i) => items.view(W, i)));
  expect(views.filter((v) => v!.state === "scheduled")).toHaveLength(3);
  const left = views.filter((v) => v!.state === "needs_approval");
  expect(left).toHaveLength(2);
  expect(left[0]!.reason).toContain("daily cap");
  expect(left[0]!.clean).toBe(true);
  expect((await approve(left[0]!.id)).status).toBe(200);
});

test("a warned Item and a Person added after the grant wait; re-confirming covers the second and leaves Held alone", async () => {
  const { id } = await step();
  await addPeople(id, 2);
  const [warned, held] = await make(id);
  await q("update items set warnings = '[{\"code\":\"unspecified\",\"text\":\"careful\"}]' where id = $1", [warned]);
  const rule = await grant(id);
  expect(await stateOf(warned!)).toBe("needs_approval");
  expect(await stateOf(held!)).toBe("scheduled");

  clock.at = new Date(clock.at.getTime() + 1000);
  await addPeople(id, 1);
  const [later] = await make(id);
  expect(await stateOf(later!)).toBe("needs_approval");

  // Held for its own reason before the re-confirm.
  await q("update items set warnings = '[{\"code\":\"unspecified\",\"text\":\"new\"}]' where id = $1", [held]);
  await runAtSlot(await actionOf(held!));
  expect(await stateOf(held!)).toBe("held");
  await q("update items set warnings = '[]' where id = $1", [held]);

  const again = ok(await rules.reconfirm(W, rule.id, actor)).rule;
  expect(again.revision).toBe(2);
  expect(await stateOf(later!)).toBe("scheduled");
  expect(await stateOf(held!)).toBe("held");
});

test("a suspended or revoked rule matches nothing new", async () => {
  const { id } = await step();
  const rule = await grant(id);
  ok(await rules.revoke(W, rule.id, actor, "Wrong list"));
  await addPeople(id, 1);
  clock.at = new Date(clock.at.getTime() + 1000);
  const [item] = await make(id);
  expect(await stateOf(item!)).toBe("needs_approval");
  expect(await rules.reconfirm(W, rule.id, actor)).toEqual({ ok: false, reason: "wrong_state" });
  const history = await q("select change from standing_rule_revisions where rule_id = $1 order by at", [rule.id]);
  expect(history.map((r) => r.change)).toEqual(["grant", "revoke"]);
  const listed = (await rules.list(W)).find((r) => r.id === rule.id)!;
  expect(listed).toMatchObject({ status: "revoked", stopReason: "Wrong list", stoppedByEmail: expect.stringContaining("@") });
});

type Row = { id: string; factId: string; subject: string; ruleId: string };
const CHANGES: [string, (r: Row) => Promise<unknown>, (() => Promise<unknown>) | null][] = [
  ["template changed", (r) => q("update campaign_steps set template_revision = template_revision + 1 where campaign_id = $1", [r.id]), null],
  ["cited fact changed", (r) => facts.set(W, { field: "price", subject: r.subject, value: "$120", source, confidence: "high", actor }), null],
  ["capability changed", async () => void (capabilityNow = "other"), async () => void (capabilityNow = CAPABILITY)],
  ["rule revoked", (r) => q("update standing_rules set status = 'revoked' where id = $1", [r.ruleId]), null],
  ["rule expired", (r) => q("update standing_rules set expires_at = granted_at where id = $1", [r.ruleId]), null],
  ["granter demoted", () => q("update workspace_members set role = 'marketer' where user_id = $1", [owner]), () => q("update workspace_members set role = 'owner' where user_id = $1", [owner])],
];

for (const phase of ["claim", "dispatch"] as const) {
  test.each(CHANGES)(`at ${phase}: %s holds it for review, sends nothing, and resuming asks a person`, async (_name, change, undo) => {
    const s = await step();
    await addPeople(s.id, 1);
    const [item] = await make(s.id);
    const rule = await grant(s.id);
    expect(await stateOf(item!)).toBe("scheduled");
    const action = await actionOf(item!);
    const row = { ...s, ruleId: rule.id };
    if (phase === "claim") await change(row);
    else
      afterClaim = async () => {
        afterClaim = null;
        await change(row);
      };
    try {
      expect(await runAtSlot(action)).toBe(0);
      expect((await q("select state, hold_reason from actions where id = $1", [action]))[0]).toEqual({ state: "held", hold_reason: "rule_needs_review" });
    } finally {
      afterClaim = null;
      await undo?.();
    }
    const resumed = ok(await items.resume(W, item!, actor));
    expect(resumed.item.state).toBe("needs_approval");
    expect((await q("select count(*)::int as n from approvals where action_id = $1 and voided_at is null", [action]))[0].n).toBe(0);
  });
}

test("a corrected fact suspends the rule, and a brand fact nobody cited doesn't", async () => {
  const s = await step();
  const rule = await grant(s.id);
  ok(await facts.set(W, { field: "price", subject: `other-${crypto.randomUUID()}`, value: "$1", source, confidence: "high", actor }));
  await addPeople(s.id, 1);
  clock.at = new Date(clock.at.getTime() + 1000);
  ok(await rules.reconfirm(W, rule.id, actor));
  const [covered] = await make(s.id);
  expect(await stateOf(covered!)).toBe("scheduled");

  await facts.set(W, { field: "price", subject: s.subject, value: "$120", source, confidence: "high", actor });
  await runAtSlot(await actionOf(covered!));
  expect((await q("select status, suspended_reason from standing_rules where id = $1", [rule.id]))[0]).toMatchObject({ status: "suspended" });
});

test("the daily sweep moves what a cap left waiting onto today once its time has gone, up to the cap", async () => {
  const { id } = await step();
  await addPeople(id, 3);
  const waiting = await make(id);
  await grant(id, 1);
  const left = (await Promise.all(waiting.map((i) => items.view(W, i)))).filter((v) => v!.state === "needs_approval");
  expect(left).toHaveLength(2);

  // Still before its time: nothing moves.
  await rules.sweepOverCap();
  expect((await Promise.all(left.map((v) => stateOf(v!.id)))).every((s) => s === "needs_approval")).toBe(true);

  const start = clock.at;
  clock.at = new Date(left[0]!.at!.getTime() + 86_400_000);
  try {
    await rules.sweepOverCap();
    const after = await Promise.all(left.map((v) => items.view(W, v!.id)));
    expect(after.filter((v) => v!.state === "scheduled")).toHaveLength(1);
    const moved = after.find((v) => v!.state === "scheduled")!;
    expect(moved.at!.toISOString().slice(0, 10)).toBe(clock.at.toISOString().slice(0, 10));
    expect(after.find((v) => v!.state === "needs_approval")!.reason).toContain("daily cap");
  } finally {
    clock.at = start;
  }
});

test("twenty unedited approvals make one offer; it opens the form, and dismissing it stops more", async () => {
  const { id } = await step();
  await addPeople(id, 20);
  const waiting = await make(id);
  const offersNow = () => q("select id, state, payload from items where kind = $1 and payload->>'campaignId' = $2", [OFFER_KIND, id]);
  // The first approval counts, so the twentieth is the nineteenth here.
  for (const i of waiting.slice(0, 18)) expect((await approve(i)).status).toBe(200);
  expect(await offersNow()).toHaveLength(0);
  expect((await approve(waiting[18]!)).status).toBe(200);
  const [offer] = await offersNow();
  expect(offer.payload).toMatchObject({ campaignId: id, stepKey: "first", templateRevision: 1 });

  const refused = await call(`/api/w/${W}/items/${offer.id}/approve`, cookie, { method: "POST", body: { revision: 1 } });
  expect((await refused.json()) as object).toMatchObject({ error: "grant_form_required" });
  ok(await items.cancel(W, offer.id, actor));
  expect((await approve(waiting[19]!)).status).toBe(200);
  expect(await offersNow()).toHaveLength(1);
});

test("a choice with no passing eval suspends rules over that agent's drafts only", async () => {
  const drafted = await step();
  const own = await step();
  const drafted2 = await grant(drafted.id);
  const mine = await grant(own.id);
  await q("update standing_rules set drafting_agent = 'campaign_drafter' where id = $1", [drafted2.id]);
  const statusOf = async (ruleId: string) => (await q("select status from standing_rules where id = $1", [ruleId]))[0].status;
  await inWorkspace(W, (tx) => suspendForAgent(tx, "some_other_agent", "x", clock.at));
  expect(await statusOf(drafted2.id)).toBe("active");
  // A template the agent drafted and a person read isn't what lessons change.
  expect(await inWorkspace(W, (tx) => suspendForAgent(tx, "campaign_drafter", "this agent's lessons changed", clock.at, true))).toBe(0);
  expect(await statusOf(drafted2.id)).toBe("active");
  expect(await inWorkspace(W, (tx) => suspendForAgent(tx, "all", "an AI choice with no passing eval", clock.at))).toBeGreaterThan(0);
  expect(await statusOf(drafted2.id)).toBe("suspended");
  expect(await statusOf(mine.id)).toBe("active");
  await q("update standing_rules set status = 'revoked', suspended_reason = null where id = $1", [drafted2.id]);
});

test("the rule's history names who granted it", async () => {
  const { id } = await step();
  await addPeople(id, 1);
  const [item] = await make(id);
  await grant(id);
  const d = await items.detail(W, item!);
  expect(d!.ruleGrantedBy).toContain("@");
  expect(d!.timeline.at(-1)!.actor).toEqual({ kind: "system", id: "standing_rule" });
});

/** A rule written directly, so nothing has matched yet. */
const quietRule = async (id: string, dailyCap: number) => {
  const r = await grant(id, 1);
  await q("update standing_rules set daily_cap = $1 where id = $2", [dailyCap, r.id]);
  await q("delete from standing_rule_uses where rule_id = $1", [r.id]);
  return r;
};

// Fifty concurrent matches take about 3 s alone, so the 5 s default fails when the whole suite runs at once.
test("fifty matches at once never pass the cap, and one Action matched many times is approved once", async () => {
  const { id } = await step();
  await quietRule(id, 1);
  await addPeople(id, 50);
  const waiting = await make(id);
  expect(waiting).toHaveLength(50);
  const scheduled = await Promise.all(waiting.map((i) => stateOf(i)));
  const before = scheduled.filter((s) => s === "scheduled").length;
  await q("update standing_rules set daily_cap = 10 where campaign_id = $1", [id]);
  await Promise.all(waiting.map((i) => rules.onSubmitted(W, i)));
  const after = await Promise.all(waiting.map((i) => stateOf(i)));
  // Drafts spread over several send days, and the cap counts each day on its own.
  const days = await q("select day, count(*)::int as n from standing_rule_uses u join standing_rules r on r.id = u.rule_id where r.campaign_id = $1 group by day", [id]);
  expect(Math.max(...days.map((d) => d.n as number))).toBe(10);
  expect(after.filter((s) => s === "scheduled").length).toBe(days.reduce((sum, d) => sum + (d.n as number), 0));
  expect(after.filter((s) => s === "scheduled").length).toBeGreaterThan(before);

  const { id: other } = await step();
  await addPeople(other, 1);
  const [one] = await make(other);
  await grant(other);
  const action = await actionOf(one!);
  ok(await ledger.moveAction(W, action, actor));
  await Promise.all(Array.from({ length: 20 }, () => rules.onSubmitted(W, one!)));
  expect(await stateOf(one!)).toBe("scheduled");
  expect((await q("select count(*)::int as n from approvals where action_id = $1 and voided_at is null", [action]))[0].n).toBe(1);
  expect((await q("select count(*)::int as n from standing_rule_uses where action_id = $1", [action]))[0].n).toBe(1);
}, 15_000);

test("a crash before approving leaves it waiting, counted once, and running again approves it once", async () => {
  const { id } = await step();
  await addPeople(id, 1);
  const [item] = await make(id);
  const rule = await grant(id, 5);
  const action = await actionOf(item!);
  ok(await ledger.moveAction(W, action, actor));
  const crashing = createStandingRules({ ledger: { ...ledger, approveByRule: () => Promise.reject(new Error("killed")) }, port: campaignRulePort, now, mayGrant: mayGrantRules, items: () => items });
  await expect(crashing.onSubmitted(W, item!)).rejects.toThrow("killed");
  expect(await stateOf(item!)).toBe("needs_approval");
  const uses = () => q("select count(*)::int as n from standing_rule_uses where rule_id = $1 and action_id = $2", [rule.id, action]);
  expect((await uses())[0].n).toBe(1);
  await rules.onSubmitted(W, item!);
  expect(await stateOf(item!)).toBe("scheduled");
  expect((await uses())[0].n).toBe(1);
});

test("nothing reaches across Workspaces: another's rule and Item do nothing", async () => {
  const { id } = await step();
  await addPeople(id, 1);
  const [item] = await make(id);
  const rule = await grant(id);
  const other = (await createOrg(cookie, "Other")).workspace.id;
  const action = await actionOf(item!);
  expect(await rules.list(other)).toEqual([]);
  expect(await rules.revoke(other, rule.id, actor, "Wrong list")).toEqual({ ok: false, reason: "not_found" });
  expect(await rules.reconfirm(other, rule.id, actor)).toEqual({ ok: false, reason: "not_found" });
  await rules.onSubmitted(other, item!);
  expect(await ledger.approveByRule(other, action, { ruleId: rule.id, draftVersion: 1, snapshot: [] })).toEqual({ ok: false, reason: "not_found" });
  expect((await q("select status from standing_rules where id = $1", [rule.id]))[0].status).toBe("active");
});

test("over HTTP: needs the permission and step-up to grant, refuses a named granter, and hides another Workspace's rule", async () => {
  const { id } = await step();
  const grantBody = { campaignId: id, stepKey: "first", dailyCap: 5 };
  const post = (path: string, who: string, body?: unknown) => call(`/api/w/${W}/standing-rules${path}`, who, { method: "POST", ...(body !== undefined && { body }) });

  const marketer = await addMember(cookie, W, "marketer");
  expect((await post("", marketer.cookie, grantBody)).status).toBe(403);
  expect((await post("", cookie, { ...grantBody, grantedBy: crypto.randomUUID() })).status).toBe(400);

  vi.useFakeTimers({ toFake: ["Date"] });
  // Granting is an everyday approval: the long step-up window (ADR 0037 rule 004).
  vi.setSystemTime(Date.now() + 61 * 60_000);
  try {
    expect(await (await post("", cookie, grantBody)).json()).toEqual({ error: "step_up_required" });
    const made = await grant(id);
    expect(await (await post(`/${made.id}/reconfirm`, cookie)).json()).toEqual({ error: "step_up_required" });
    // Stopping is always easy: any Member, no step-up, with a reason.
    expect((await post(`/${made.id}/revoke`, marketer.cookie)).status).toBe(400);
    expect((await post(`/${made.id}/revoke`, marketer.cookie, { reason: " " })).status).toBe(400);
    expect((await post(`/${made.id}/revoke`, marketer.cookie, { reason: "Wrong list" })).status).toBe(200);
    expect((await q("select reason, actor_user_id from standing_rule_revisions where rule_id = $1 and change = 'revoke'", [made.id]))[0]).toMatchObject({ reason: "Wrong list" });
  } finally {
    vi.useRealTimers();
  }

  expect((await post("", cookie, grantBody)).status).toBe(200);
  const listed = (await (await call(`/api/w/${W}/standing-rules`, cookie)).json()) as { rules: { campaignId: string; granterEmail: string | null }[] };
  expect(listed.rules.find((r) => r.campaignId === id)!.granterEmail).toContain("@");
  expect((await post(`/${crypto.randomUUID()}/revoke`, cookie, { reason: "Wrong list" })).status).toBe(404);
});

test("a step has one active rule at a time, even when two people grant at once, so caps can't add up", async () => {
  const { id } = await step();
  const body = { campaignId: id, stepKey: "first", dailyCap: 5 };
  const results = await Promise.all([rules.grant(W, body, actor), rules.grant(W, body, actor), rules.grant(W, body, actor)]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "step_has_rule" }, { ok: false, reason: "step_has_rule" }]);
  const first = results.find((r) => r.ok) as Extract<(typeof results)[number], { ok: true }>;
  ok(await rules.revoke(W, first.rule.id, actor, "Wrong list"));
  const second = await grant(id);
  expect(second.id).not.toBe(first.rule.id);

  // An expired rule doesn't stand in the way.
  await q("update standing_rules set expires_at = granted_at where id = $1", [second.id]);
  const third = await grant(id);
  expect(await rules.reconfirm(W, second.id, actor)).toEqual({ ok: false, reason: "step_has_rule" });
  expect(third.status).toBe("active");
});

test("a provider's sending-limit refusal doesn't suspend a template rule, whose words a person read", async () => {
  const { id } = await step();
  await addPeople(id, 1);
  const [waiting] = await make(id);
  const rule = await grant(id);
  expect(await stateOf(waiting!)).toBe("scheduled");
  fake.sendScript.push({ status: 429, reason: "rateLimitExceeded" });
  expect(await runAtSlot(await actionOf(waiting!))).toBe(0);
  expect((await q("select status from standing_rules where id = $1", [rule.id]))[0].status).toBe("active");
});
