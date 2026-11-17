// SPDX-License-Identifier: AGPL-3.0-only
// Rules over email an agent writes, on the real ledger, floors and Gmail plugin against a fake Gmail.
// Drafts go through the real writer sink with scripted draft checks, so coverage reads what ships:
// the producer record, the check record, the warnings and the campaign's outside-content answer.
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, expect, test } from "vitest";
import { appClient, ownerClient } from "../../../../../test/db";
import { campaignCheck, campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, campaignRulePort, campaignSinks, createCampaigns, templateVersion } from "../campaigns/index";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { createFacts, describeFactChange, factKinds, factVersion } from "../facts/index";
import { approverMayApprove, mayGrantRules, workspaceLive } from "../identity/index";
import { createItems, itemRoutes } from "../items/index";
import { TEST_SECRET, testIdentity, testLedger } from "../outreach/fixtures/support";
import { createOutreach, outreachFloors } from "../outreach/index";
import { createPlans, planKinds, type PlanBody } from "../plans/index";
import { loadPlugins } from "../plugins/index";
import { touchCheck } from "../schedule/index";
import { createStandingRules, MIN_UNEDITED_APPROVALS, ruleStillCovers, standingRuleKinds, suspendAgentRulesFor, suspendOnProviderLimit, suspendOnStale } from "./index";
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
let gate = { offered: true, missing: [] as string[] };
let twoPerson = false;
const wording = { version: "w1", signedBy: "Founder" as string | null, signedOn: "2026-11-03" as string | null };
const { clock, ledger } = await testLedger({
  effects: plugins.effects,
  resolvers: { credential: credentialLabel, fact: factVersion, template: templateVersion, capability: async () => CAPABILITY },
  checks: [workspaceLive(), outreachFloors(async () => true), campaignCheck(), ruleStillCovers({ port: campaignRulePort, now: () => clock.at, mayGrant: mayGrantRules, gateOpen: () => gate.offered }), approverMayApprove(), touchCheck({ effects: plugins.effects, now: () => clock.at }), credentialReady],
  now: () => clock.at,
  onRuleStale: suspendOnStale({ now: () => clock.at }),
  onProviderLimit: suspendOnProviderLimit({ now: () => clock.at }),
});
const now = () => clock.at;
const rules = createStandingRules({ ledger, port: campaignRulePort, now, mayGrant: mayGrantRules, items: () => items, agentGate: () => gate, twoPersonRule: async () => twoPerson, wording });
const items = createItems({ ledger, now, kinds: { ...standingRuleKinds(), ...factKinds(), ...planKinds({ now, onPlanApproved: campaignOnPlanApproved({ now, items: () => items }) }), ...campaignKinds({ now }) }, describeChange: describeFactChange, onSubmitted: rules.onSubmitted, onApproved: rules.onApproved, ruleApprovalBy: rules.ruleApprovalBy });
const outreach = createOutreach({
  items: () => items,
  send: () => ({ id: SEND, dedupe: "queryable", version: CAPABILITY, prepare: (ws, input) => plugins.prepare(ws, SEND, input) }),
  baseUrl: () => "http://direx.test",
  now,
});
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const starts: { agent: string; input: unknown }[] = [];
const startDraft = () => async (_w: string, a: { agent: string; input: unknown }) => {
  starts.push(a);
  return { ok: true as const, run: { id: crypto.randomUUID() } };
};
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: startDraft as never, now, onOutsideContentChanged: async (tx, id, at) => void (await suspendAgentRulesFor(tx, id, at)) });

// The draft checks, scripted per draft.
type Answer = Record<string, unknown> | "refuse";
const PASS = { claim_check: { schemaVersion: 1, claims: [] }, injection_check: { schemaVersion: 1, verdict: "clean", reasons: [] } } as Record<string, Answer>;
let answers = PASS;
const fakeGenerate = (async (req: { purpose: string }) => {
  const a = answers[req.purpose]!;
  return a === "refuse" ? { ok: false, callId: null, refusal: "no_route" } : { ok: true, callId: crypto.randomUUID(), trust: "untrusted", output: a, toolCalls: [], routeHash: `route:${req.purpose}` };
}) as never;
const sinks = campaignSinks({ facts, outreach: () => outreach, now, startDraft: startDraft as never, generate: () => fakeGenerate, items: () => items });
const writer = { agent: "recipient_writer", definitionVersion: 1, promptDigest: "d", routeHash: "r" };

const { routes, signIn, createOrg, call } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", itemRoutes({ items: () => items }));
const cookie = await signIn();
const W = (await createOrg(cookie, "Acme")).workspace.id;
const db = await appClient();
afterAll(() => db.end());
async function q(text: string, params: unknown[] = [], as: "app" | "owner" = "app") {
  const c = as === "app" ? db : await ownerClient();
  try {
    await c.query("begin");
    await c.query("select set_config('app.workspace_id', $1, true)", [W]);
    const r = await c.query(text, params);
    await c.query("commit");
    return r.rows;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    if (c !== db) await c.end();
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

/** A per-person cold campaign whose website question is answered yes. */
async function campaign(o: { outside?: boolean } = {}) {
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: owner });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  expect((await approve(ok(await plans.submitPlan(W, plan.id, { revision, actor })).item.id)).status).toBe(200);
  const id = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
  ok(await campaigns.setDraftingMode(W, id, "per_person"));
  ok(await campaigns.setupStep(W, id, "first", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
  if (o.outside !== false) ok(await campaigns.setOutsideContent(W, id, { allowed: true, userId: owner }));
  return id;
}

/** n new People. A free-mail address has no company site, so the writer starts with no reader. */
async function addPeople(id: string, n: number) {
  const rows = Array.from({ length: n }, () => `${crypto.randomUUID()}@gmail.com,Kim,Acme,US,published_address,Their contact page`);
  ok(await campaigns.addPeople(W, id, { csv: `email,first_name,company,country,basis,evidence\n${rows.join("\n")}`, userId: owner }));
}
/** n new People, each drafted by the writer with these check answers. Returns their Item ids. */
async function drafts(id: string, n: number, o: Parameters<typeof write>[1] = {}) {
  await addPeople(id, n);
  return write(id, o);
}
/** Drafts everyone in the campaign who has no draft yet, through the real writer sink. */
async function write(id: string, o: { answers?: (i: number) => Record<string, Answer>; text?: (i: number) => string | undefined; producer?: typeof writer } = {}) {
  starts.length = 0;
  ok(await campaigns.writePerPerson(W, id, "first", { timeZone: "UTC", userId: owner }));
  const out: string[] = [];
  for (const [i, s] of starts.filter((s) => s.agent === "recipient_writer").entries()) {
    answers = o.answers?.(i) ?? PASS;
    const text = o.text?.(i) ?? "Hi Kim, a quick question about how Acme handles audits.";
    const proposal = { kind: "draft" as const, outputKey: "recipient_write", body: { schemaVersion: 1, subject: "A quick question", text, citations: [], usedDetails: [] } };
    const r = await sinks.draft(W, proposal, { runId: crypto.randomUUID(), input: s.input, tainted: true, pagesRead: [], pages: [], producer: o.producer ?? writer });
    if (!r.ok || !r.itemId) throw new Error(JSON.stringify(r));
    out.push(r.itemId);
  }
  answers = PASS;
  return out;
}
const stateOf = async (itemId: string) => (await items.view(W, itemId))!.state;
const actionOf = async (itemId: string) => (await q("select action_id from items where id = $1", [itemId]))[0].action_id as string;
const grant = (id: string, more: { expiresAt?: Date; wordingVersion?: string } = {}) => rules.grantAgentWritten(W, { campaignId: id, stepKey: "first", wordingVersion: "w1", ...more }, actor);
/** A campaign with enough unedited approvals and an active rule, and `waiting` People added before the grant with no draft yet. */
async function ruled(waiting = 1) {
  const id = await campaign();
  const approved = await drafts(id, MIN_UNEDITED_APPROVALS);
  for (const i of approved) expect((await approve(i)).status).toBe(200);
  await addPeople(id, waiting);
  const rule = ok(await grant(id)).rule;
  return { id, rule, approved };
}
async function runAtSlot(action: string) {
  const start = clock.at;
  const before = fake.sent.length;
  try {
    clock.at = ((await q("select due_at from actions where id = $1", [action]))[0].due_at as Date | null) ?? start;
    await ledger.run(W, action);
  } finally {
    clock.at = start;
  }
  return fake.sent.length - before;
}
const holdOf = async (action: string) => (await q("select state, hold_reason, reason_detail from actions where id = $1", [action]))[0];

test("a grant is refused, in order, until each precondition holds", async () => {
  const id = await campaign({ outside: false });
  const refusal = async (more: Parameters<typeof grant>[1] = {}, who = actor) => (await rules.grantAgentWritten(W, { campaignId: id, stepKey: "first", wordingVersion: "w1", ...more }, who)) as { reason?: string; missing?: string[]; count?: number };
  expect((await refusal({}, { userId: crypto.randomUUID() })).reason).toBe("forbidden");
  twoPerson = true;
  expect((await refusal()).reason).toBe("two_person_rule");
  twoPerson = false;
  expect((await rules.grantAgentWritten(W, { campaignId: crypto.randomUUID(), stepKey: "first", wordingVersion: "w1" }, actor)) as object).toEqual({ ok: false, reason: "not_found" });
  await q("update campaign_steps set drafting_mode = 'template' where campaign_id = $1", [id]);
  expect((await refusal()).reason).toBe("not_per_person");
  await q("update campaign_steps set drafting_mode = 'per_person' where campaign_id = $1", [id]);
  await q("update campaign_steps set type = 'manual' where campaign_id = $1", [id]);
  expect((await refusal()).reason).toBe("not_email");
  await q("update campaign_steps set type = 'email' where campaign_id = $1", [id]);
  expect((await refusal()).reason).toBe("outside_content_off");
  ok(await campaigns.setOutsideContent(W, id, { allowed: true, userId: owner }));
  gate = { offered: false, missing: ["hostile_pages: 1 run, needs 5"] };
  expect(await refusal()).toEqual({ ok: false, reason: "gate_closed", missing: ["hostile_pages: 1 run, needs 5"] });
  gate = { offered: true, missing: [] };
  wording.signedBy = null;
  expect((await refusal()).reason).toBe("wording_unsigned");
  wording.signedBy = "Founder";

  const first = await drafts(id, MIN_UNEDITED_APPROVALS);
  for (const i of first.slice(0, -1)) expect((await approve(i)).status).toBe(200);
  expect(await refusal()).toEqual({ ok: false, reason: "too_few_approvals", count: MIN_UNEDITED_APPROVALS - 1 });
  // An edited draft no longer matches the words its checks read, so approving it isn't evidence.
  const personId = (await q("select person_id from campaign_actions c join items i on i.action_id = c.action_id where i.id = $1", [first.at(-1)]))[0].person_id as string;
  ok(await campaigns.editPersonDraft(W, id, "first", personId, { subject: "A quick question", text: "Hi Kim, a different question.", userId: owner }));
  expect((await approve(first.at(-1)!)).status).toBe(200);
  expect((await refusal()).count).toBe(MIN_UNEDITED_APPROVALS - 1);
  const [fifth] = await drafts(id, 1);
  expect((await approve(fifth!)).status).toBe(200);

  expect((await refusal({ expiresAt: new Date(clock.at.getTime() + 100 * 86_400_000) })).reason).toBe("bad_expiry");
  expect((await refusal({ wordingVersion: "old" })).reason).toBe("wording_outdated");
  const rule = ok(await grant(id)).rule;
  expect(rule).toMatchObject({ mode: "agent_written", dailyCap: null, templateRevision: null, outsideContent: true, language: "en", wordingVersion: "w1", draftingAgent: "recipient_writer", producer: { reader: null, writer } });
  expect((await refusal()).reason).toBe("step_has_rule");
});

test("whole flow: 17 drafts that pass go out with no person, the 3 that don't wait, and a sent one names the rule and drafter", async () => {
  const { id, rule } = await ruled(20);
  // Everyone joined before the grant. Drafts 18 and 19 make a promise nothing backs; 20's injection check can't run.
  const promise = "we refund you if it doesn't help";
  const all = await write(id, {
    text: (i) => (i === 17 || i === 18 ? `Hi Kim, ${promise}.` : undefined),
    answers: (i) => (i === 17 || i === 18 ? { ...PASS, claim_check: { schemaVersion: 1, claims: [{ quote: promise, kind: "promise", support: "none" }] } } : i === 19 ? { ...PASS, injection_check: "refuse" } : PASS),
  });
  expect(all).toHaveLength(20);
  const good = all.slice(0, 17);
  const failed = all.slice(17, 19);
  const unavailable = all.slice(19);
  expect(await Promise.all(good.map(stateOf))).toEqual(good.map(() => "scheduled"));
  for (const i of [...failed, ...unavailable]) expect(await stateOf(i)).not.toBe("scheduled");

  const action = await actionOf(good[0]!);
  const approval = (await q("select standing_rule_id, approver_id, producer_digest, snapshot from approvals where action_id = $1", [action]))[0];
  expect(approval).toMatchObject({ standing_rule_id: rule.id, approver_id: owner });
  expect(approval.producer_digest).toMatch(/^[0-9a-f]{64}$/);
  // A person's approval never depends on the drafter.
  expect(JSON.stringify(approval.snapshot)).not.toContain("recipient_writer");
  expect(await runAtSlot(action)).toBe(1);
  expect(await stateOf(good[0]!)).toBe("sent");
  expect(await rules.ruleApprovalBy(W, action)).toEqual({ by: expect.stringContaining("@"), writtenBy: "Direx's email writer, version 1" });
  expect((await q("select producer->'writer'->>'agent' as agent from campaign_actions where action_id = $1", [action]))[0].agent).toBe("recipient_writer");
});

test("a covered draft keeps its planned time, so the mailbox's daily limit still holds", async () => {
  const id = await campaign();
  const first = await drafts(id, MIN_UNEDITED_APPROVALS + 1);
  const planned = (await q("select planned_at from items where id = $1", [first.at(-1)]))[0].planned_at as Date;
  for (const i of first.slice(0, -1)) expect((await approve(i)).status).toBe(200);
  ok(await grant(id));
  expect(await stateOf(first.at(-1)!)).toBe("scheduled");
  expect((await q("select due_at from actions where id = $1", [await actionOf(first.at(-1)!)]))[0].due_at).toEqual(planned);
});

test("a new writer version stops coverage for its drafts without suspending the rule, and needs five new approvals", async () => {
  const { id, rule } = await ruled(0);
  const next = { ...writer, definitionVersion: 2 };
  const later = await drafts(id, MIN_UNEDITED_APPROVALS, { producer: next });
  expect(await Promise.all(later.map(stateOf))).toEqual(later.map(() => "needs_approval"));
  expect((await q("select status from standing_rules where id = $1", [rule.id]))[0].status).toBe("active");
  for (const i of later.slice(0, -1)) expect((await approve(i)).status).toBe(200);
  expect(await rules.reconfirm(W, rule.id, actor)).toMatchObject({ ok: false, reason: "too_few_approvals", count: MIN_UNEDITED_APPROVALS - 1 });
  expect((await approve(later.at(-1)!)).status).toBe(200);
  await addPeople(id, 1);
  const again = ok(await rules.reconfirm(W, rule.id, actor));
  expect(again.rule).toMatchObject({ revision: 2, producer: { writer: next } });
  const [fresh] = await write(id, { producer: next });
  expect(await stateOf(fresh!)).toBe("scheduled");
});

// The app role can't write these records, so a change to them is simulated as the owner.
const CHANGES: [string, (a: { id: string; ruleId: string; action: string }) => Promise<unknown>][] = [
  ["the writer in its record changed", (a) => q("update campaign_actions set producer = jsonb_set(producer, '{writer,definitionVersion}', '2') where action_id = $1", [a.action], "owner")],
  ["its check record failed", (a) => q(`update campaign_actions set checks = jsonb_set(checks, '{claim,status}', '"failed"') where action_id = $1`, [a.action], "owner")],
  ["its producer record was swapped for an equal-looking one", (a) => q(`update campaign_actions set producer = producer || '{"note":"x"}' where action_id = $1`, [a.action], "owner")],
  ["the campaign's website answer changed", (a) => campaigns.setOutsideContent(W, a.id, { allowed: false, userId: owner })],
  ["the safety results closed", async () => void (gate = { offered: false, missing: ["x"] })],
  ["a Member stopped it", (a) => rules.revoke(W, a.ruleId, actor, "Wrong list")],
  ["it expired", (a) => q("update standing_rules set expires_at = granted_at where id = $1", [a.ruleId])],
];
test.each(CHANGES)("at claim, a rule approval is held and nothing sends when %s", async (_name, change) => {
  const { id, rule } = await ruled();
  const [item] = await write(id);
  expect(await stateOf(item!)).toBe("scheduled");
  const action = await actionOf(item!);
  try {
    await change({ id, ruleId: rule.id, action });
    expect(await runAtSlot(action)).toBe(0);
  } finally {
    gate = { offered: true, missing: [] };
  }
  expect(await holdOf(action)).toMatchObject({ state: "held", hold_reason: "rule_needs_review" });
});

test("a changed website answer suspends the campaign's rules in the same change, with a revision row", async () => {
  const { id, rule } = await ruled();
  ok(await campaigns.setOutsideContent(W, id, { allowed: false, userId: owner }));
  expect((await q("select status, suspended_reason from standing_rules where id = $1", [rule.id]))[0]).toMatchObject({ status: "suspended", suspended_reason: "the campaign's website question changed" });
  expect((await q("select change from standing_rule_revisions where rule_id = $1 order by at", [rule.id])).map((r) => r.change)).toEqual(["grant", "suspend"]);
  // Setting the same answer again changes nothing.
  ok(await campaigns.setOutsideContent(W, id, { allowed: false, userId: owner }));
  expect((await q("select count(*)::int as n from standing_rule_revisions where rule_id = $1", [rule.id]))[0].n).toBe(2);
  expect(await rules.reconfirm(W, rule.id, actor)).toMatchObject({ ok: false, reason: "outside_content_off" });
});

test("a tampered producer digest fails the approval's signature", async () => {
  const { id } = await ruled();
  const [item] = await write(id);
  const action = await actionOf(item!);
  await q("update approvals set producer_digest = $2 where action_id = $1", [action, "0".repeat(64)], "owner");
  expect(await runAtSlot(action)).toBe(0);
  expect(await holdOf(action)).toMatchObject({ hold_reason: "approval_invalid", reason_detail: "signature does not verify" });
});

test("the form's offer says whether it may be shown, how many approvals there are, and the words", async () => {
  const id = await campaign();
  for (const i of await drafts(id, 2)) expect((await approve(i)).status).toBe(200);
  expect(await rules.agentWrittenOffer(W, id, "first")).toMatchObject({ offered: true, missing: [], approvals: 2, needed: MIN_UNEDITED_APPROVALS, wordingVersion: "w1" });
  gate = { offered: false, missing: ["hostile_pages: 1 run, needs 5"] };
  wording.signedBy = null;
  try {
    expect(await rules.agentWrittenOffer(W, id, "first")).toMatchObject({ offered: false, missing: ["hostile_pages: 1 run, needs 5", "the form's words aren't signed"] });
  } finally {
    gate = { offered: true, missing: [] };
    wording.signedBy = "Founder";
  }
});

test("a rule or campaign from another Workspace does nothing", async () => {
  const { id, rule } = await ruled();
  const other = (await createOrg(cookie, "Other")).workspace.id;
  expect(await rules.grantAgentWritten(other, { campaignId: id, stepKey: "first", wordingVersion: "w1" }, actor)).toMatchObject({ ok: false });
  expect(await rules.reconfirm(other, rule.id, actor)).toMatchObject({ ok: false, reason: "not_found" });
  expect(await campaigns.setOutsideContent(other, id, { allowed: false, userId: owner })).toEqual({ ok: false, reason: "not_found" });
  expect((await q("select status from standing_rules where id = $1", [rule.id]))[0].status).toBe("active");
});


test("a provider's sending-limit refusal on a rule's email suspends the rule; the same refusal on a person's approval doesn't", async () => {
  const { id, rule, approved } = await ruled();
  // One of the five a person approved.
  const byPerson = approved[0];
  fake.sendScript.push({ status: 429, reason: "rateLimitExceeded" });
  expect(await runAtSlot(await actionOf(byPerson!))).toBe(0);
  expect((await q("select status from standing_rules where id = $1", [rule.id]))[0].status).toBe("active");

  const [item] = await write(id);
  expect(await stateOf(item!)).toBe("scheduled");
  const action = await actionOf(item!);
  fake.sendScript.push({ status: 429, reason: "rateLimitExceeded" });
  expect(await runAtSlot(action)).toBe(0);
  expect((await q("select status, suspended_reason from standing_rules where id = $1", [rule.id]))[0]).toEqual({ status: "suspended", suspended_reason: "the mail provider refused sends over its sending limit" });
  expect((await q("select change from standing_rule_revisions where rule_id = $1 order by at", [rule.id])).map((r) => r.change)).toEqual(["grant", "suspend"]);
  // The Action itself is held for a retry, as any rate limit is.
  expect(await holdOf(action)).toMatchObject({ state: "held", hold_reason: "provider_rejected" });
});
