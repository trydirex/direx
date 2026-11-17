// SPDX-License-Identifier: AGPL-3.0-only
// The lead generator end to end: a pasted website becomes one sent message, with every step a person
// has to take taken by a signed-in person over HTTP. Only the outside world is fake: the firm's site,
// the model provider, the verification plugin's answer, the mail host lookup and Gmail. The database,
// queues, agents loop, Items, ledger, floors and the Gmail plugin are real.
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { definePlugin, VERIFY_ADDRESS } from "@direx/plugin-sdk";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../test/db";
import { createAgents, createFetchHtml } from "./modules/agents/index";
import { campaignCheck, campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, createCampaigns, templateVersion } from "./modules/campaigns/index";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "./modules/credentials/index";
import { createFacts, describeFactChange, factKinds, factVersion } from "./modules/facts/index";
import { approverMayApprove, workspaceLive } from "./modules/identity/index";
import { createItems, itemRoutes } from "./modules/items/index";
import { createModels, routesFor, type Models } from "./modules/models/index";
import { anthropicTool, fakeProvider, testKeys } from "./modules/models/fixtures/provider";
import { TEST_SECRET, testIdentity, testLedger } from "./modules/outreach/fixtures/support";
import { createOutreach, outreachFloors } from "./modules/outreach/index";
import { createPlans, planKinds, type PlanBody } from "./modules/plans/index";
import { loadPlugins } from "./modules/plugins/index";
import {
  addressLabelsFor,
  COMPANY_READ_QUEUE,
  COMPANY_VERIFY_QUEUE,
  companyReviews,
  createCompanyReader,
  createHandovers,
  createRuns,
  createVerifier,
  HANDOVER_QUEUE,
  NAMES_OUTPUT_KEY,
  namesSink,
  prospectingDefinitions,
  prospectingRoutes,
  prospectKinds,
  signalsFor,
  type CompanyRead,
  type ReviewPayload,
} from "./modules/prospecting/index";
import { touchCheck } from "./modules/schedule/index";
import { sendForCredential, verifyForWorkspace } from "./worker";
import { passMailboxCheck } from "./modules/outreach/fixtures/support";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;

const DOMAIN = "ledgerworks.test";
const JANE = `jane.doe@${DOMAIN}`;
const STEP_DAY = "2026-11-03";

// The outside world.
const gmail = startFakeGmail();
const model = fakeProvider();
afterAll(async () => {
  gmail.stop();
  await model.stop();
});
const FILLER = "<p>We are a firm of chartered accountants serving owner-managed businesses with tax, audit and advisory work.</p>";
const PAGES: Record<string, string> = {
  "/robots.txt": "User-agent: *\nAllow: /",
  "/": `<html><body><nav><a href="/team">Team</a><a href="/contact">Contact</a><a href="/careers">Careers</a></nav>${FILLER}</body></html>`,
  "/team": `<h1>Our team</h1><p>Jane Doe, Managing Partner</p><a href="mailto:${JANE}">Email Jane</a>`,
  "/contact": `<h1>Contact</h1><address>1 Poultry<br>London EC2R 8EJ<br>UK</address>`,
  "/careers": `<h1>Careers</h1><p>We're hiring a senior accountant to join our London office.</p>`,
};
const verifyPlugin = definePlugin({
  manifest: {
    id: "com.example.testverify",
    apiVersion: 1,
    version: "1.0.0",
    minHostVersion: "0.1.0",
    trust: "first_party",
    connections: [{ key: "testverify", auth: "api_key" }],
    egress: { hosts: [] },
    capabilities: [{ kind: "query", name: VERIFY_ADDRESS, connection: "testverify" }],
  },
  queries: { [VERIFY_ADDRESS]: async () => ({ result: "deliverable", vendorStatus: "safe", credits: 1, costMicros: 0 }) },
});

let verifyKey: string | undefined;
const plugins = loadPlugins({
  sources: [
    { mode: "in_process", plugin: createGmailPlugin({ baseUrl: gmail.url, timeoutMs: 1000 }) },
    { mode: "in_process", plugin: verifyPlugin },
  ],
  // The verification key is an API key, the Mailbox an OAuth token.
  credentials: async (_ws, id) => (id === verifyKey ? { key: "k" } : { accessToken: gmail.token, expiresAt: "" }),
  confinement: "none",
  log: () => {},
});
const { boss, clock, ledger } = await testLedger({
  effects: plugins.effects,
  resolvers: { credential: credentialLabel, fact: factVersion, template: templateVersion, capability: async (_tx, id) => plugins.capabilityVersion(id) },
  checks: [workspaceLive(), outreachFloors(async () => true), campaignCheck(), approverMayApprove(), touchCheck({ effects: plugins.effects, now: () => clock.at }), credentialReady],
  now: () => clock.at,
});
const now = () => clock.at;
for (const queue of [COMPANY_READ_QUEUE, COMPANY_VERIFY_QUEUE, HANDOVER_QUEUE]) await boss.createQueue(queue);

// The composition root, as main.ts and worker.ts wire it.
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now });
const items = createItems({
  ledger,
  now,
  kinds: { ...factKinds(), ...planKinds({ now, onPlanApproved: campaignOnPlanApproved({ now, items: () => items }) }), ...campaignKinds({ now }), ...prospectKinds({ boss, now }) },
  describeChange: describeFactChange,
  recipient: (workspaceId, spec, itemId) => campaigns.recipientNotes(workspaceId, spec, itemId),
});
const outreach = createOutreach({ items: () => items, send: sendForCredential(plugins, vault), baseUrl: () => "http://direx.test", now });
const facts = createFacts({ items: () => items, now });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, startDraft: () => async () => ({ ok: false, reason: "not_here" }), now, signalsFor, addressLabelsFor });
const reviews = companyReviews({ items: () => items, now });
const names = namesSink(now, reviews.open);
let models: Models;
const agents = createAgents({
  boss,
  deployment: "self_host",
  routes: routesFor("self_host"),
  models: () => models,
  sinks: { draft: (workspaceId, proposal, context) => names(workspaceId, proposal, context) },
  definitions: prospectingDefinitions,
  addWarning: items.addWarning,
  context: async () => [],
  notify: async () => {},
  fetchPage: async (_b, url) => ({ ok: false, url, reason: "http_error" }),
});
models = createModels({ deployment: "self_host", keys: testKeys("sk-test"), baseURLs: { anthropic: model.url }, runGate: agents.runGate });
await agents.work();
const requested: string[] = [];
const reader = createCompanyReader({
  fetchHtml: createFetchHtml({
    maxChars: Infinity,
    resolve: async () => [{ address: "93.184.216.34" }],
    request: async (url) => {
      requested.push(url.href);
      const page = url.hostname === DOMAIN ? PAGES[url.pathname] : undefined;
      if (page === undefined) return new Response("not here", { status: 404, headers: { "content-type": "text/html" } });
      return new Response(page, { headers: { "content-type": url.pathname === "/robots.txt" ? "text/plain" : "text/html" } });
    },
  }),
  startNames: async (workspaceId, a) => {
    const started = await agents.start(workspaceId, a);
    return started.ok ? { ok: true } : { ok: false, reason: started.reason };
  },
  openReview: reviews.open,
  now,
});
const failedChecks: string[] = [];
const verifier = createVerifier({ verify: verifyForWorkspace(plugins, vault, [verifyPlugin]), now, resolveMx: async () => [{ exchange: "mx.example.net" }], log: (line) => failedChecks.push(line) });
const handovers = createHandovers({ boss, campaigns: () => campaigns, freshResults: verifier.freshResults, now });

const { routes, signIn, createOrg, call } = testIdentity();
const routed = routes as unknown as OpenAPIHono;
routed.route("/", itemRoutes({ items: () => items }));
routed.route("/", prospectingRoutes({ runs: () => createRuns({ boss, now }), handovers: () => handovers, terms: () => { throw new Error("a pasted run needs no terms"); } }));
const cookie = await signIn();
const W = (await createOrg(cookie, "Acme")).workspace.id;
const url = (rest: string) => `/api/w/${W}${rest}`;
const db = await appClient();
afterAll(() => db.end());
async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  await db.query("begin");
  try {
    await db.query("select set_config('app.workspace_id', $1, true)", [W]);
    const r = await db.query(text, params);
    await db.query("commit");
    return r.rows as T[];
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}
const owner = (await q<{ user_id: string }>("select user_id from workspace_members"))[0]!.user_id;
const actor = { userId: owner };
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};
const post = (path: string, body: unknown) => call(url(path), cookie, { method: "POST", body });
const read = async <T>(path: string) => (await (await call(url(path), cookie)).json()) as T;
type Detail = { item: { id: string; state: string; revision: number }; content: unknown; recipient?: { signals: { type: string; quote: string; pageUrl: string }[]; roleAddress: boolean; guessedAddress: boolean } | null };
/** A person's approval through the items route, at the Item's current revision. */
async function approve(itemId: string, choice?: string) {
  const { item } = await read<Detail>(`/items/${itemId}`);
  return post(`/items/${itemId}/approve`, { revision: item.revision, ...(choice !== undefined && { choice }) });
}

/** Mailboxes and keys are connected by a person; the test sets the rows that sign-in would. */
async function credential(key: string, connection: string, oauth: boolean) {
  const c = ok(await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key, name: key, meta: {}, value: { key: "x" } }));
  if (oauth) await q("update credentials set kind = 'oauth2', scope = 'user', owner_user_id = $1, connection = $2 where id = $3", [owner, connection, c.credential.id]);
  else await q("update credentials set connection = $1 where id = $2", [connection, c.credential.id]);
  await passMailboxCheck(W, c.credential.id);
  return c.credential.id;
}

test("a pasted website becomes one sent message, and the Person's evidence and signal can be read back", { timeout: 30_000 }, async () => {
  const mailbox = await credential("me@acme.test", "google", true);
  verifyKey = await credential("verify-key", "testverify", false);
  await outreach.saveIdentity(W, { senderName: "Sam at Acme", postalAddress: "1 Main St" });

  // An approved strategy and plan make the Campaign, with an email step on the Mailbox.
  const strategy = ok(
    await plans.saveStrategyDraft(W, {
      revision: 0,
      body: { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "email", label: "Email", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] },
    }),
  );
  expect((await approve(ok(await plans.submitStrategy(W, { revision: strategy.revision, actor })).item.id)).status).toBe(200);
  const body: PlanBody = {
    schemaVersion: 1,
    goal: "4 meetings",
    audience: "Accounting firms",
    startsOn: "2026-11-02",
    endsOn: "2026-11-30",
    steps: [{ key: "first", on: STEP_DAY, title: "First" }],
    measures: [{ key: "m", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
    budget: [],
    assumptions: [],
  };
  const plan = await plans.createPlan(W, { title: "Q4 firms", createdBy: owner });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  expect((await approve(ok(await plans.submitPlan(W, plan.id, { revision, actor })).item.id)).status).toBe(200);
  const campaignId = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
  ok(await campaigns.setDraftingMode(W, campaignId, "template"));
  ok(await campaigns.setupStep(W, campaignId, "first", { type: "email", touchClass: "cold", mailboxCredentialId: mailbox, audience: "everyone" }));
  ok(await campaigns.saveTemplate(W, campaignId, "first", { revision: 0, subject: "Hi {{firstName}}", text: "Hello {{firstName}}, from {{senderName}}.", userId: owner }));

  // 1. Pasted: one run, one company, one queued read.
  const pasted = await post("/prospecting/runs/pasted", { websites: [`https://${DOMAIN}/`], signals: ["hiring"], confirmedUsd: 1 });
  expect(pasted.status).toBe(200);
  const { results } = (await pasted.json()) as { results: { ok: boolean; companyId?: string }[] };
  const companyId = results[0]!.companyId!;
  const jobs = (await boss.findJobs<CompanyRead>(COMPANY_READ_QUEUE, { data: { companyId } })).map((j) => j.data);
  expect(jobs).toEqual([{ workspaceId: W, companyId }]);

  // 2. Read: robots.txt first, then the pages, and a names run started on what they say.
  model.respondWith(() => anthropicTool("propose", { schemaVersion: 1, people: [{ first: "Jane", last: "Doe", role: "Managing Partner" }] }));
  expect(await reader.read(jobs[0]!)).toBe(true);
  expect(requested[0]).toBe(`https://${DOMAIN}/robots.txt`);

  // 3. Names: the run goes through the real queue and loop to the provider, and its hand-over opens the review.
  type Company = { id: string; country: string | null; namesStatus: string | null; reviewItemId: string | null };
  const company = async () => (await read<{ companies: Company[] }>("/prospecting/companies")).companies.find((c) => c.id === companyId)!;
  await expect.poll(async () => (await company()).reviewItemId, { timeout: 20_000, interval: 100 }).not.toBeNull();
  expect(await company()).toMatchObject({ country: "GB", namesStatus: "done" });
  const proposals = await q<{ output_key: string }>("select output_key from agent_proposals");
  expect(proposals.map((p) => p.output_key)).toEqual([NAMES_OUTPUT_KEY]);

  // 4. Review: a person keeps Jane's address; accepting queues the verification job.
  const reviewId = (await company()).reviewItemId!;
  const review = (await read<Detail>(`/items/${reviewId}`)).content as ReviewPayload;
  const jane = review.addresses.findIndex((a) => a.email === JANE);
  expect(review.addresses[jane]).toMatchObject({ kind: "named", name: "Jane Doe", role: "Managing Partner", leftOut: null, pageUrl: `https://${DOMAIN}/team` });
  expect(review.signals).toEqual([expect.objectContaining({ type: "hiring", pageUrl: `https://${DOMAIN}/careers` })]);
  expect((await approve(reviewId, String(jane))).status).toBe(200);
  const verifyJobs = (await boss.findJobs(COMPANY_VERIFY_QUEUE, { data: { companyId } })).map((j) => j.data);
  expect(verifyJobs).toEqual([{ workspaceId: W, companyId }]);

  // 5. Verify: through the loaded plugin, with the Workspace's key on its connection.
  expect(await verifier.verifyCompany({ workspaceId: W, companyId })).toEqual({ status: "done", checked: 1, guessesKept: 0 });
  expect(failedChecks).toEqual([]);
  expect(await q("select verification_result from prospect_addresses where email = $1", [JANE])).toEqual([{ verification_result: "deliverable" }]);

  // 6. Cohort and hand-over to the Campaign.
  const cohort = await post("/prospecting/cohorts", { name: "Firms", filter: {} });
  expect(cohort.status).toBe(200);
  const { id: cohortId } = (await cohort.json()) as { id: string };
  const handed = await post(`/prospecting/cohorts/${cohortId}/add-to-campaign`, { campaignId });
  expect(handed.status).toBe(202);
  const { handoverId } = (await handed.json()) as { handoverId: string };
  expect((await boss.findJobs(HANDOVER_QUEUE, { data: { handoverId } })).map((j) => j.data)).toEqual([{ workspaceId: W, handoverId }]);
  await handovers.run({ workspaceId: W, handoverId });
  const handover = await read<{ status: string; results: { email: string; status: string; personId: string | null }[] }>(`/prospecting/handovers/${handoverId}`);
  expect(handover).toMatchObject({ status: "done", results: [{ email: JANE, status: "added" }] });
  const personId = handover.results[0]!.personId!;

  // 7. The evidence for that Person reads back: published, the page it was on, and the check.
  const [eligibility] = await q<{ country: string; basis: string; evidence: string }>("select country, basis, evidence from person_eligibility where person_id = $1", [personId]);
  expect(eligibility).toMatchObject({ country: "GB", basis: "published_address" });
  expect(eligibility!.evidence).toMatch(/^Address published on the company's site; verified deliverable on 2026-11-02; page read .+, snapshot [0-9a-f-]+: https:\/\/ledgerworks\.test\/team$/);

  // 8. Draft, and the approval shows the signal and how the address was found.
  const [draft] = ok(await campaigns.makeDrafts(W, campaignId, "first", { timeZone: "UTC", userId: owner })).results;
  expect(draft).toMatchObject({ ok: true, personId });
  const itemId = draft!.itemId!;
  const detail = await read<Detail>(`/items/${itemId}`);
  expect(detail.item.state).toBe("needs_approval");
  expect(detail.recipient).toEqual({ signals: [expect.objectContaining({ type: "hiring", quote: expect.stringContaining("hiring a senior accountant"), pageUrl: `https://${DOMAIN}/careers` })], roleAddress: false, guessedAddress: false });
  expect((await approve(itemId)).status).toBe(200);

  // 9. The real Dispatcher sends exactly one message, on the step's day, through Gmail.
  const actionId = (await q<{ action_id: string }>("select action_id from items where id = $1", [itemId]))[0]!.action_id;
  clock.at = new Date(`${STEP_DAY}T09:30:00Z`);
  await ledger.run(W, actionId);
  expect(gmail.sent).toHaveLength(1);
  const raw = Buffer.from(gmail.sent[0]!.raw, "base64url").toString();
  expect(raw).toContain(`To: ${JANE}`);
  expect(Buffer.from(raw.split("\r\n\r\n")[1]!, "base64").toString()).toContain("Hello Jane, from Sam at Acme.");
  expect(await items.view(W, itemId)).toMatchObject({ state: "sent" });
});
