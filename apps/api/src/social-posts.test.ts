// SPDX-License-Identifier: AGPL-3.0-only
// From an approved plan to a published post, on a network core has never heard of: real plans, Items,
// ledger and floors, through the real plugin host. Nothing here calls a real network.
import type { SocialNetworkInfo } from "@direx/extensions";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../test/db";
import { campaignCheck, campaignKinds, campaignOnPlanApproved, campaignOnPlanCreated, campaignSinks, createCampaigns, templateVersion } from "./modules/campaigns/index";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "./modules/credentials/index";
import { createFacts, describeFactChange, factKinds, factVersion } from "./modules/facts/index";
import { approverMayApprove, workspaceLive } from "./modules/identity/index";
import { createItems, itemRoutes, warn } from "./modules/items/index";
import { TEST_SECRET, testIdentity, testLedger } from "./modules/outreach/fixtures/support";
import { createOutreach, outreachFloors } from "./modules/outreach/index";
import { createPlans, planKinds, type PlanBody } from "./modules/plans/index";
import { loadPlugins } from "./modules/plugins/index";
import { touchCheck } from "./modules/schedule/index";
import { createTestNet } from "./modules/social/fixtures/net";
import { accountHealthCheck, createPosts, pauseInWorkspace, postAppearance, postLinkImage, pauseOnAccountLimit, postLimitCheck, socialKinds, socialRoutes, stepUpCredential, unpauseAccount } from "./modules/social/index";
import { createSocial } from "./modules/social/index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;

const LIMIT = 3;
const info: SocialNetworkInfo & { monthlyPostLimit?: number } = {
  connection: "testnet",
  label: "Test Net",
  accountTypes: ["page"],
  connect: "oauth",
  availability: { cloud: "available", self_host: "available" },
  noIdenticalAcrossAccounts: true,
  features: [
    { key: "publish", built: true, scopes: ["write"] },
    { key: "links", built: true, scopes: [], needsOwnApp: true },
    { key: "follow_ups", built: true, scopes: [] },
  ],
};
const later: SocialNetworkInfo = { ...info, noIdenticalAcrossAccounts: false, connection: "later", label: "Later", availability: { cloud: "not_built", self_host: "not_built" }, features: [], postLimit: 20 };
const networks = () => [info, later];

const net = createTestNet();
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });
const plugins = loadPlugins({
  sources: [{ mode: "in_process", plugin: net.plugin }],
  credentials: async () => ({ accessToken: "tok", expiresAt: "" }),
  onCredentialRejected: async (ws, id) => {
    await vault.markNeedsReauth(ws, id);
  },
  confinement: "none",
  log: () => {},
});
const { clock, ledger } = await testLedger({
  effects: plugins.effects,
  resolvers: { credential: credentialLabel, fact: factVersion, template: templateVersion, capability: async (_tx, id) => plugins.capabilityVersion(id) },
  checks: [workspaceLive(), outreachFloors(async () => true), campaignCheck(), postLimitCheck({ plugins: () => plugins, networks, now: () => clock.at }), accountHealthCheck({ now: () => clock.at }), approverMayApprove(), touchCheck({ effects: plugins.effects, now: () => clock.at }), credentialReady],
  onAccountLimit: pauseOnAccountLimit({ now: () => clock.at }),
  now: () => clock.at,
});
const now = () => clock.at;
const items = createItems({ ledger, now, kinds: { ...factKinds(), ...planKinds({ now, onPlanApproved: campaignOnPlanApproved({ now, items: () => items }) }), ...campaignKinds({ now }), ...socialKinds() }, describeChange: describeFactChange });
const outreach = createOutreach({ items: () => items, send: () => undefined, baseUrl: () => "http://direx.test", now });
const facts = createFacts({ items: () => items });
const plans = createPlans({ items: () => items, facts, onPlanCreated: campaignOnPlanCreated });
const own = { app: "system" as "own" | "system" };
const posts = createPosts({ plugins: () => plugins, vault: () => ({ appSource: async () => own.app }), networks, items: () => items, now, launchesOn: (w, day) => campaigns.launchesBetween(w, day, day) });
const campaigns = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, posts: () => posts, startDraft: () => async () => ({ ok: false, reason: "not_here" }), now });
const social = createSocial({ plugins: () => plugins, vault: () => vault, networks, deployment: () => "cloud", callbackUrl: () => "" });

const { routes, signIn, createOrg, call } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", itemRoutes({ items: () => items }));
(routes as unknown as OpenAPIHono).route("/", socialRoutes({ social: () => social, posts: () => posts }));
const cookie = await signIn();
const W = (await createOrg(cookie, "Acme")).workspace.id;
const db = await appClient();
afterAll(() => db.end());
async function q(text: string, params: unknown[] = []) {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  const r = await db.query(text, params);
  await db.query("commit");
  return r.rows;
}
const owner = (await q("select user_id from workspace_members"))[0].user_id as string;
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};
const revisionOf = async (id: string) => ((await (await call(`/api/w/${W}/items/${id}`, cookie)).json()) as { item: { revision: number } }).item.revision;
const approve = async (id: string) => call(`/api/w/${W}/items/${id}/approve`, cookie, { method: "POST", body: { revision: await revisionOf(id) } });
const stateOf = async (id: string) => ((await (await call(`/api/w/${W}/items/${id}`, cookie)).json()) as { item: { state: string; reasonCode: string | null; warnings: { code: string; text: string }[]; clean: boolean } }).item;

const saved = ok(await plans.saveStrategyDraft(W, { revision: 0, body: { schemaVersion: 1, whoFor: "Ops", personas: [], positioning: "Audit", channels: [{ key: "social", label: "Social", timing: "now", reason: "Read", basis: { kind: "assumption" } }], assumptions: [] } }));
expect((await approve(ok(await plans.submitStrategy(W, { revision: saved.revision, actor: { userId: owner } })).item.id)).status).toBe(200);

const body: PlanBody = { schemaVersion: 1, goal: "Reach", audience: "Ops", startsOn: "2026-11-02", endsOn: "2026-11-30", steps: [{ key: "launch", on: "2026-11-03", title: "Launch post" }], measures: [{ key: "m", label: "Reach", target: "4", basis: { kind: "assumption" } }], budget: [], assumptions: [] };
async function postStep() {
  const plan = await plans.createPlan(W, { title: "Q4", createdBy: owner });
  const { revision } = ok(await plans.savePlanDraft(W, plan.id, { revision: 0, body }));
  expect((await approve(ok(await plans.submitPlan(W, plan.id, { revision, actor: { userId: owner } })).item.id)).status).toBe(200);
  const id = (await campaigns.list(W)).find((c) => c.planId === plan.id)!.id;
  ok(await campaigns.setupStep(W, id, "launch", { type: "post", touchClass: null, mailboxCredentialId: null, audience: "everyone" }));
  return id;
}
// Every account here says who runs it, so only the disclosure test sees that warning.
async function account(scopes = ["write"], runBy: string | null = "Bio says: run by Acme") {
  const c = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: crypto.randomUUID(), name: "Ana", meta: {}, value: { key: "x" } });
  if (!c.ok) throw new Error(c.reason);
  await q("update credentials set kind = 'oauth2', scope = 'user', owner_user_id = $1, connection = 'testnet', meta = $3 where id = $2", [owner, c.credential.id, JSON.stringify({ scopes })]);
  const networkId = crypto.randomUUID();
  await q("insert into social_accounts (workspace_id, credential_id, connection, account_type, network_id, name, run_by) values ($1, $2, 'testnet', 'page', $3, 'Page', $4)", [W, c.credential.id, networkId, runBy]);
  return { connection: "testnet", credentialId: c.credential.id, networkId };
}
const WHEN = new Date("2026-11-03T09:00:00Z");
type Result = { ok: boolean; itemId: string; mode: string; reason?: string; detail?: string };
async function draft(id: string, targets: Parameters<typeof posts.draft>[2], plannedAt = WHEN) {
  return ok(await campaigns.draftPosts(W, id, "launch", { plannedAt, targets }, owner)).results as Result[];
}
const dispatch = async (itemId: string) => {
  clock.at = new Date(Math.max(clock.at.getTime(), WHEN.getTime() + 60_000));
  await ledger.run(W, (await items.actionIdOf(W, itemId))!);
};
const beforeWhen = () => (clock.at = new Date("2026-11-02T09:00:00Z"));
const atCeiling = (a: { credentialId: string; networkId: string }) =>
  q("insert into social_account_health (workspace_id, credential_id, network_id, posts, replies, links, clean_since, updated_at) values ($1, $2, $3, 5, 20, 3, now(), now())", [W, a.credentialId, a.networkId]);
const healthRow = async (a: { credentialId: string; networkId: string }) =>
  (await q("select posts, links, paused_at, pause_reason from social_account_health where credential_id = $1 and network_id = $2", [a.credentialId, a.networkId]))[0];
const published = (key: string) => net.state.published.filter((p) => p.key === key);

test("a post step needs no touch class, and anything else does", async () => {
  const id = await postStep();
  expect(await campaigns.setupStep(W, id, "launch", { type: "post", touchClass: "cold", mailboxCredentialId: null, audience: "everyone" })).toEqual({ ok: false, reason: "touch_class_mismatch" });
  expect(await campaigns.setupStep(W, id, "launch", { type: "email", touchClass: null, mailboxCredentialId: null, audience: "everyone" })).toEqual({ ok: false, reason: "touch_class_mismatch" });
});

test("a step's posts aren't drafted for a time already gone, as a Calendar post isn't", async () => {
  beforeWhen();
  const id = await postStep();
  const targets = [{ ...(await account()), text: "Too late" }];
  expect(await campaigns.draftPosts(W, id, "launch", { plannedAt: new Date("2026-11-01T09:00:00Z"), targets }, owner)).toEqual({ ok: false, reason: "slot_in_past" });
  expect(await campaigns.draftPosts(W, id, "launch", { plannedAt: clock.at, targets }, owner)).toEqual({ ok: false, reason: "slot_in_past" });
  expect(await q("select count(*)::int as n from social_posts where campaign_id = $1", [id])).toEqual([{ n: 0 }]);
});

test("one text on three accounts of different networks makes one Action each in one group, each approved on its own", async () => {
  beforeWhen();
  const id = await postStep();
  const [a, b] = [await account(), await account()];
  const r = await draft(id, [{ ...a, text: "Hello A" }, { ...b, text: "Hello B" }]);
  expect(r.map((x) => x.mode)).toEqual(["publish", "publish"]);
  const list = (await (await call(`/api/w/${W}/items?groupKey=${encodeURIComponent(`campaign:${id}:step:launch`)}`, cookie)).json()) as { items?: unknown[] };
  expect(list).toBeTruthy();
  const results = await items.approveClean(W, await Promise.all(r.map(async (x) => ({ id: x.itemId, revision: await revisionOf(x.itemId) }))), { approverId: owner as never, may: () => true });
  expect(results.map((x) => x.result.ok)).toEqual([true, true]);
  expect(await q("select count(distinct action_id)::int as n from approvals where action_id in (select action_id from social_posts where campaign_id = $1)", [id])).toEqual([{ n: 2 }]);
});

test("a post's Item shows the account and the network it goes out as", async () => {
  beforeWhen();
  const id = await postStep();
  const [r] = await draft(id, [{ ...(await account()), text: "Hello" }]);
  expect(await postAppearance(W, r!.itemId, networks())).toEqual({ kind: "post", account: expect.anything(), network: info.label, link: null });
  expect(await postAppearance(W, crypto.randomUUID(), networks())).toBeNull();
  // The first link's card is read once and kept; a page that couldn't be read isn't read again; a new link is.
  const reads: string[] = [];
  const card = { title: "Q4 ops", description: "Three things.", site: "Acme", image: null };
  const read = async (url: string) => (reads.push(url), url.includes("broken") ? null : card);
  const shown = (text: string) => postAppearance(W, r!.itemId, networks(), { text, readPreview: read });
  const link = { url: "https://acme.test/q4", title: "Q4 ops", description: "Three things.", site: "Acme", image: false };
  expect((await shown("Read https://acme.test/q4. Thoughts?"))!.link).toEqual(link);
  expect((await shown("Read https://acme.test/q4 again"))!.link).toEqual(link);
  expect((await shown("https://acme.test/broken"))!.link).toBeNull();
  expect((await shown("https://acme.test/broken"))!.link).toBeNull();
  expect((await shown("No link now"))!.link).toBeNull();
  expect(reads).toEqual(["https://acme.test/q4", "https://acme.test/broken"]);
  // A day later the page that failed is tried again.
  await postAppearance(W, r!.itemId, networks(), { text: "https://acme.test/broken", readPreview: read, now: new Date(Date.now() + 86_400_000 + 60_000) });
  expect(reads).toHaveLength(3);
  // A page's image is fetched with it and kept when its bytes are an image; the card says only that there is one.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const pictured = async (url: string) => (url.includes("svg") ? { ...card, image: "https://cdn.test/x.svg" } : { ...card, image: "https://cdn.test/x.png" });
  const readImage = async (url: string) => ({ bytes: url.endsWith(".svg") ? Buffer.from("<svg/>") : png });
  expect((await postAppearance(W, r!.itemId, networks(), { text: "https://acme.test/pictured", readPreview: pictured, readImage }))!.link).toMatchObject({ image: true });
  expect(await postLinkImage(W, r!.itemId)).toEqual({ type: "image/png", bytes: png });
  // Served from Direx as an image only: its own type, nosniff, a sandbox.
  const served = await call(`/api/w/${W}/social/posts/${r!.itemId}/link-image`, cookie);
  expect(served.status).toBe(200);
  expect(Buffer.from(await served.arrayBuffer())).toEqual(png);
  expect([served.headers.get("content-type"), served.headers.get("x-content-type-options"), served.headers.get("content-security-policy")]).toEqual(["image/png", "nosniff", "default-src 'none'; sandbox"]);
  // Bytes that aren't one of the four image types are not kept, whatever the server called them.
  expect((await postAppearance(W, r!.itemId, networks(), { text: "https://acme.test/svg", readPreview: pictured, readImage }))!.link).toMatchObject({ image: false });
  expect(await postLinkImage(W, r!.itemId)).toBeNull();
  expect((await call(`/api/w/${W}/social/posts/${r!.itemId}/link-image`, cookie)).status).toBe(404);
});

test("a preview fetched before replacement cannot restore the cancelled post's card or image", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  const [first] = await draft(id, [{ ...a, text: "https://acme.test/old" }]);
  const started = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const pending = postAppearance(W, first!.itemId, networks(), {
    text: "https://acme.test/old",
    readPreview: async () => {
      started.resolve();
      await resume.promise;
      return { title: "Old", description: null, site: "Acme", image: "https://cdn.test/old.png" };
    },
    readImage: async () => ({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) }),
  });
  await started.promise;
  try {
    ok(await items.cancel(W, first!.itemId, { userId: owner }));
    const [next] = await draft(id, [{ ...a, text: "https://acme.test/new" }]);
    expect(next).toMatchObject({ ok: true });
    expect(next!.itemId).not.toBe(first!.itemId);
    resume.resolve();
    await pending;
    expect(await q("select link_preview, link_image, link_image_type from social_posts where item_id = $1", [next!.itemId])).toEqual([
      { link_preview: null, link_image: null, link_image_type: null },
    ]);
    expect(await postLinkImage(W, next!.itemId)).toBeNull();
  } finally {
    resume.resolve();
    await pending;
  }
});

test("rejecting one holds only that Network", async () => {
  beforeWhen();
  const id = await postStep();
  const [a, b] = [await account(), await account()];
  const [one, two] = await draft(id, [{ ...a, text: "One" }, { ...b, text: "Two" }]);
  await approve(two!.itemId);
  ok(await items.cancel(W, one!.itemId, { userId: owner }));
  await dispatch(two!.itemId);
  expect((await stateOf(one!.itemId)).state).toBe("cancelled");
  expect((await stateOf(two!.itemId)).state).toBe("sent");
});

test("a cancelled post gives way to a new one on the same account, and a sent one still can't be written again", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  const [first] = await draft(id, [{ ...a, text: "First" }]);
  ok(await items.cancel(W, first!.itemId, { userId: owner }));
  const [again] = await draft(id, [{ ...a, text: "Again" }]);
  expect(again).toMatchObject({ ok: true, mode: "publish" });
  expect(again!.itemId).not.toBe(first!.itemId);
  expect((await stateOf(first!.itemId)).state).toBe("cancelled");
  // A copy-and-paste post the person dismissed gives way the same way.
  const hand = { connection: "later", credentialId: null, networkId: null };
  const [dismissed] = await draft(id, [{ ...hand, text: "By hand" }]);
  ok(await items.cancel(W, dismissed!.itemId, { userId: owner }));
  const [handAgain] = await draft(id, [{ ...hand, text: "By hand again" }]);
  expect(handAgain).toMatchObject({ ok: true, mode: "manual" });
  expect(handAgain!.itemId).not.toBe(dismissed!.itemId);
  expect(await q("select count(*)::int as n from social_posts where campaign_id = $1", [id])).toEqual([{ n: 2 }]);
  // What went out stays: writing that account again is refused, and nothing posts twice.
  await approve(again!.itemId);
  await dispatch(again!.itemId);
  const [late] = await draft(id, [{ ...a, text: "Third" }], new Date(clock.at.getTime() + 3_600_000));
  expect(late).toMatchObject({ ok: false, reason: "wrong_state" });
  expect(net.state.published.filter((p) => p.spec.text === "Third")).toEqual([]);
});

test.each(["publish", "manual"] as const)("cancelled posts can switch publishing modes repeatedly starting with %s", async (firstMode) => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  let mode: "publish" | "manual" = firstMode;
  const switching = createPosts({ plugins: () => plugins, vault: () => ({ appSource: async () => own.app }), networks: () => [{ ...info, features: mode === "manual" ? [] : info.features }], items: () => items, now });
  const step = { campaignId: id, stepKey: "launch", title: "Launch post", plannedAt: WHEN };
  const modes = firstMode === "publish" ? ["publish", "manual", "publish", "manual", "publish"] as const : ["manual", "publish", "manual", "publish"] as const;
  const previous: string[] = [];
  for (const [i, nextMode] of modes.entries()) {
    mode = nextMode;
    const target = { ...a, text: `Replacement ${i}` };
    const [made] = await switching.draft(W, step, [target], owner);
    expect(made).toMatchObject({ ok: true, mode });
    const itemId = made!.itemId!;
    expect(previous).not.toContain(itemId);
    expect((await stateOf(itemId)).state).toBe("needs_approval");
    expect(await q("select item_id from social_posts where campaign_id = $1", [id])).toEqual([{ item_id: itemId }]);
    // A repeat still returns this draft; only replacing a cancelled Item changes the key.
    expect((await switching.draft(W, step, [target], owner))[0]).toMatchObject({ ok: true, itemId });
    for (const old of previous) expect((await stateOf(old)).state).toBe("cancelled");
    if (i < modes.length - 1) {
      ok(await items.cancel(W, itemId, { userId: owner }));
      previous.push(itemId);
    } else {
      expect((await approve(itemId)).status).toBe(200);
      await dispatch(itemId);
      expect((await stateOf(itemId)).state).toBe("sent");
      expect(net.state.published.filter((p) => p.spec.text === target.text && p.spec.target === a.networkId)).toHaveLength(1);
    }
  }
});

test.each([
  ["manual", "manual"], ["manual", "publish"], ["publish", "manual"], ["publish", "publish"],
] as const)("a delayed %s replacement cannot overwrite a posted %s winner", async (loserMode, winnerMode) => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  const [first] = await draft(id, [{ ...a, text: "Cancelled" }]);
  ok(await items.cancel(W, first!.itemId, { userId: owner }));
  let reached!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { reached = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const delayedItems = {
    ...items,
    createItem: async (...args: Parameters<typeof items.createItem>) => { reached(); await gate; return items.createItem(...args); },
    createActionItem: async (...args: Parameters<typeof items.createActionItem>) => { reached(); await gate; return items.createActionItem(...args); },
  };
  const make = (mode: "manual" | "publish", service = items) => createPosts({ plugins: () => plugins, vault: () => ({ appSource: async () => own.app }), networks: () => [{ ...info, features: mode === "manual" ? [] : info.features }], items: () => service, now });
  const step = { campaignId: id, stepKey: "launch", title: "Launch post", plannedAt: WHEN };
  const losing = make(loserMode, delayedItems).draft(W, step, [{ ...a, text: "Losing text" }], owner);
  await waiting;
  try {
    const winnerPosts = make(winnerMode);
    const [winner] = await winnerPosts.draft(W, step, [{ ...a, text: "Winning text" }], owner);
    expect(winner).toMatchObject({ ok: true, mode: winnerMode });
    expect((await approve(winner!.itemId!)).status).toBe(200);
    if (winnerMode === "publish") await dispatch(winner!.itemId!);
    else ok(await winnerPosts.markPosted(W, winner!.itemId!, "https://net.example/manual", owner));
    const before = await q("select * from social_posts where campaign_id = $1", [id]);
    release();
    expect(await losing).toMatchObject([{ ok: false, reason: "stale" }]);
    expect(await q("select * from social_posts where campaign_id = $1", [id])).toEqual(before);
    expect((await stateOf(winner!.itemId!)).state).toBe(winnerMode === "publish" ? "sent" : "applied");
    expect(await q("select count(*)::int as n from items where group_key = $1", [`campaign:${id}:step:launch`])).toEqual([{ n: 2 }]);
    expect(await q("select count(*)::int as n from actions where idempotency_key like $1", [`social:${id}:%`])).toEqual([{ n: winnerMode === "publish" ? 2 : 1 }]);
  } finally {
    release();
    await losing;
  }
});

test("editing an approved draft voids its approval under the same Action, and drafting the same text again changes nothing", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  const [first] = await draft(id, [{ ...a, text: "First" }]);
  const action = await items.actionIdOf(W, first!.itemId);
  const [same] = await draft(id, [{ ...a, text: "First" }]);
  expect(same!.itemId).toBe(first!.itemId);
  expect((await approve(first!.itemId)).status).toBe(200);
  const [again] = await draft(id, [{ ...a, text: "First" }]);
  expect(again!.itemId).toBe(first!.itemId);
  expect((await stateOf(first!.itemId)).state).toBe("scheduled");
  await draft(id, [{ ...a, text: "Second" }]);
  expect((await stateOf(first!.itemId)).state).toBe("needs_approval");
  expect(await items.actionIdOf(W, first!.itemId)).toBe(action);
  expect(await q("select count(*)::int as n from social_posts where campaign_id = $1", [id])).toEqual([{ n: 1 }]);
});

test("an approved post publishes once at its time, the Item links to it, and it touches no Person", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  const people = await q("select count(*)::int as n from people");
  const touches = await q("select count(*)::int as n from touch_reservations");
  const [p] = await draft(id, [{ ...a, text: "Live" }]);
  await approve(p!.itemId);
  const action = (await items.actionIdOf(W, p!.itemId))!;
  await ledger.run(W, action);
  expect(published(action)).toHaveLength(0);
  await dispatch(p!.itemId);
  await ledger.run(W, action);
  expect(published(action)).toHaveLength(1);
  expect(published(action)[0]!.spec.text).toBe("Live");
  const [row] = await posts.list(W, id, "launch");
  expect(row).toMatchObject({ mode: "publish", url: expect.stringMatching(/^https:\/\/net\.example\//), item: { state: "sent" } });
  expect(await q("select count(*)::int as n from people")).toEqual(people);
  expect(await q("select count(*)::int as n from touch_reservations")).toEqual(touches);
  await campaigns.results(W, id);
  const plan = await plans.plan(W, (await campaigns.campaign(W, id))!.planId);
  expect(plan!.tracking!.steps.find((s) => s.key === "launch")!.status).toBe("done");
});

test("moving a post asks for approval of the new time, and it publishes then", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  const [p] = await draft(id, [{ ...a, text: "Moved" }]);
  await approve(p!.itemId);
  const action = (await items.actionIdOf(W, p!.itemId))!;
  const later2 = new Date(WHEN.getTime() + 3 * 60 * 60_000);
  ok(await items.moveItem(W, p!.itemId, later2, { userId: owner }));
  expect((await stateOf(p!.itemId)).state).toBe("needs_approval");
  await approve(p!.itemId);
  clock.at = new Date(WHEN.getTime() + 60_000);
  await ledger.run(W, action);
  expect(published(action)).toHaveLength(0);
  clock.at = new Date(later2.getTime() + 60_000);
  await ledger.run(W, action);
  expect(await stateOf(p!.itemId)).toMatchObject({ state: "sent" });
  expect(published(action)).toHaveLength(1);
});

test("a changed spec is refused at dispatch and never reaches the Network", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  const [p] = await draft(id, [{ ...a, text: "Approved" }]);
  await approve(p!.itemId);
  const action = (await items.actionIdOf(W, p!.itemId))!;
  const c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [W]);
  await c.query(`update actions set spec = jsonb_set(spec, '{text}', '"Changed"') where id = $1`, [action]);
  await c.end();
  await dispatch(p!.itemId);
  expect(await stateOf(p!.itemId)).toMatchObject({ state: "held", reasonCode: "approval_invalid" });
  expect(published(action)).toHaveLength(0);
});

test("Pause all sending and a campaign pause hold a post, and resuming a campaign releases it", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  const [p] = await draft(id, [{ ...a, text: "Paused" }]);
  await approve(p!.itemId);
  const action = (await items.actionIdOf(W, p!.itemId))!;
  ok(await campaigns.pause(W, id, owner));
  await dispatch(p!.itemId);
  expect(await stateOf(p!.itemId)).toMatchObject({ state: "held", reasonCode: "campaign_paused" });
  ok(await campaigns.resume(W, id, owner));
  await outreach.setPaused(W, true, owner);
  await ledger.run(W, action);
  expect(await stateOf(p!.itemId)).toMatchObject({ state: "held", reasonCode: "workspace_paused" });
  expect(published(action)).toHaveLength(0);
  await outreach.setPaused(W, false, owner);
  await items.resume(W, p!.itemId, { userId: owner });
  await ledger.run(W, action);
  expect(published(action)).toHaveLength(1);
});

test("a dropped connection is an unknown outcome, publishes again only if a person chooses", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  const [p] = await draft(id, [{ ...a, text: "Dropped" }]);
  await approve(p!.itemId);
  const action = (await items.actionIdOf(W, p!.itemId))!;
  net.state.next = "drop";
  await dispatch(p!.itemId);
  expect(await stateOf(p!.itemId)).toMatchObject({ state: "held", reasonCode: "outcome_unknown" });
  await ledger.run(W, action);
  expect(published(action)).toHaveLength(0);
  ok(await items.resolveUnknown(W, p!.itemId, "resend", owner));
  await ledger.run(W, action);
  expect(published(action)).toHaveLength(1);
});

test("a rate limit pauses the account until a person lifts it, a rejected token waits for a reconnect, and neither posts twice", async () => {
  beforeWhen();
  const id = await postStep();
  const [a, b] = [await account(), await account()];
  const [limited, rejected] = await draft(id, [{ ...a, text: "Limited" }, { ...b, text: "Rejected" }]);
  await approve(limited!.itemId);
  await approve(rejected!.itemId);
  net.state.next = "rate_limit";
  await dispatch(limited!.itemId);
  expect(await stateOf(limited!.itemId)).toMatchObject({ state: "held", reasonCode: "provider_rejected" });
  const retried = (await items.actionIdOf(W, limited!.itemId))!;
  expect(await healthRow(a)).toMatchObject({ pause_reason: "sending_limit" });
  // Within the day, so the account pause is what holds it, not lateness.
  clock.at = new Date(clock.at.getTime() + 23 * 60 * 60_000);
  await ledger.run(W, retried);
  expect(await stateOf(limited!.itemId)).toMatchObject({ state: "held", reasonCode: "account_paused" });
  expect(published(retried)).toHaveLength(0);
  await unpauseAccount(W, a, clock.at);
  ok(await items.resume(W, limited!.itemId, { userId: owner }));
  await ledger.run(W, retried);
  expect(published(retried)).toHaveLength(1);

  const action = (await items.actionIdOf(W, rejected!.itemId))!;
  net.state.next = "token_rejected";
  await ledger.run(W, action);
  expect(await q("select status from credentials where id = $1", [b.credentialId])).toEqual([{ status: "needs_reauth" }]);
  // Past the retry's wait, still within the day.
  clock.at = new Date(clock.at.getTime() + 30 * 60_000);
  await ledger.run(W, action);
  expect(await stateOf(rejected!.itemId)).toMatchObject({ state: "held", reasonCode: "credential_unavailable" });
  await q("update credentials set status = 'active' where id = $1", [b.credentialId]);
  expect(await ledger.resumeHeld(W, b.credentialId)).toBe(1);
  await ledger.run(W, action);
  expect(published(action)).toHaveLength(1);
});

test("a follow-up that fails or may have posted leaves the post sent and says so", async () => {
  beforeWhen();
  const id = await postStep();
  const [a, b] = [await account(), await account()];
  const [failed, dropped] = await draft(id, [{ ...a, text: "F", followUps: ["more"] }, { ...b, text: "D", followUps: ["more"] }]);
  await approve(failed!.itemId);
  await approve(dropped!.itemId);
  net.state.next = "follow_up_fails";
  await dispatch(failed!.itemId);
  net.state.next = "follow_up_drops";
  await dispatch(dropped!.itemId);
  const rows = await posts.list(W, id, "launch");
  const of = (itemId: string) => rows.find((r) => r.itemId === itemId)!;
  expect([of(failed!.itemId).item.state, of(failed!.itemId).followUps[0]?.status]).toEqual(["sent", "failed"]);
  expect([of(dropped!.itemId).item.state, of(dropped!.itemId).followUps[0]?.status]).toEqual(["sent", "uncertain"]);
  expect(published((await items.actionIdOf(W, failed!.itemId))!)).toHaveLength(1);
});

test("a post confirmed by a check reports its follow-ups as uncertain, not posted", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  const [p] = await draft(id, [{ ...a, text: "Confirmed", followUps: ["more"] }]);
  await approve(p!.itemId);
  await dispatch(p!.itemId);
  await q("update actions set result = null where id = $1", [await items.actionIdOf(W, p!.itemId)]);
  expect((await posts.list(W, id, "launch"))[0]!.followUps).toEqual([{ status: "uncertain" }]);
});

test("text over the limit is refused with the count, and text at the limit passes", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  net.state.limit = 5;
  const [over] = await draft(id, [{ ...a, text: "123456" }]);
  expect(over).toMatchObject({ ok: false, reason: "refused_by_network", detail: "6 of 5 characters" });
  const [at] = await draft(id, [{ ...a, text: "12345" }]);
  expect(at).toMatchObject({ ok: true, mode: "publish" });
  expect(await posts.preview(W, { ...a, text: "12345" })).toMatchObject({ count: { used: 5, limit: 5 } });
  net.state.limit = 100;
});

test("on Direx's app links are removed and shown before approval, and with the Workspace's own app they stay", async () => {
  beforeWhen();
  const id = await postStep();
  const [a, b] = [await account(), await account()];
  const [gone] = await draft(id, [{ ...a, text: "See https://direx.test/x" }]);
  const rows = await posts.list(W, id, "launch");
  expect(rows[0]!.text).toBe("See");
  expect((await stateOf(gone!.itemId)).warnings).toEqual([{ code: "unspecified", text: expect.stringContaining("Links were removed") }]);
  own.app = "own";
  const [kept] = await draft(id, [{ ...b, text: "See https://direx.test/y" }]);
  own.app = "system";
  expect((await stateOf(kept!.itemId)).warnings).toEqual([]);
  expect((await posts.list(W, id, "launch")).find((r) => r.itemId === kept!.itemId)!.text).toBe("See https://direx.test/y");
});

test("one text on two accounts of a network that forbids it warns; different texts don't", async () => {
  beforeWhen();
  const id = await postStep();
  const [a, b] = [await account(), await account()];
  const [one] = await draft(id, [{ ...a, text: "Same" }, { ...b, text: "Same" }]);
  expect((await stateOf(one!.itemId)).clean).toBe(false);
  const [other] = await draft(id, [{ ...a, text: "Same" }, { ...b, text: "Not the same" }]);
  expect((await stateOf(other!.itemId)).clean).toBe(true);
});

test("a post to one of several accounts on a network that doesn't say who runs it warns, and stops once it does", async () => {
  beforeWhen();
  const id = await postStep();
  const quiet = await account(["write"], null);
  await account();
  const [first] = await draft(id, [{ ...quiet, text: "Clip one" }]);
  expect((await stateOf(first!.itemId)).warnings.map((w) => w.text)).toContain("Say who runs this account on the account itself, then note it under Run by.");
  await q("update social_accounts set run_by = 'Bio says: clips from Acme' where credential_id = $1", [quiet.credentialId]);
  const [second] = await draft(await postStep(), [{ ...quiet, text: "Clip two" }], new Date(WHEN.getTime() + 60 * 60_000));
  expect((await stateOf(second!.itemId)).warnings.map((w) => w.text)).not.toContain("Say who runs this account on the account itself, then note it under Run by.");
});

test("two posts on one account in one slot warn and stay out of approve all clean; on two accounts they don't", async () => {
  beforeWhen();
  const [x, y] = [await postStep(), await postStep()];
  const [a, b] = [await account(), await account()];
  await draft(x, [{ ...a, text: "Earlier" }]);
  const [near] = await draft(y, [{ ...a, text: "Near" }], new Date(WHEN.getTime() + 14 * 60_000));
  expect((await stateOf(near!.itemId)).clean).toBe(false);
  const [far] = await draft(y, [{ ...b, text: "Far" }], new Date(WHEN.getTime() + 14 * 60_000));
  expect((await stateOf(far!.itemId)).clean).toBe(true);
  const [apart] = await draft(y, [{ ...a, text: "Apart" }], new Date(WHEN.getTime() + 16 * 60_000));
  expect(apart!.ok).toBe(true);
  expect((await stateOf(apart!.itemId)).clean).toBe(true);
  // A wrong result here would hold real work.
  const results = await items.approveClean(W, [{ id: near!.itemId, revision: await revisionOf(near!.itemId) }], { approverId: owner as never, may: () => true });
  expect(results[0]!.result.ok).toBe(true);
});

test("the month's limit on Direx's app holds the next post with no call, and own keys have none", async () => {
  beforeWhen();
  info.monthlyPostLimit = LIMIT;
  // Earlier tests in this file published too.
  await q("update actions set first_dispatched_at = null, outcome_unknown_at = null where capability like 'com.example.testnet/%'");
  const a = await account();
  // This test is about the month's limit, so the account's daily budget stays out of the way.
  await atCeiling(a);
  const ids: string[] = [];
  for (let i = 0; i < LIMIT + 1; i++) {
    const id = await postStep();
    const [p] = await draft(id, [{ ...a, networkId: a.networkId, text: `Post ${i}` }], new Date(WHEN.getTime() + i * 20 * 60_000));
    await approve(p!.itemId);
    ids.push(p!.itemId);
  }
  clock.at = new Date(WHEN.getTime() + 24 * 60 * 60_000);
  for (const id of ids) await ledger.run(W, (await items.actionIdOf(W, id))!);
  const states = await Promise.all(ids.map(stateOf));
  expect(states.slice(0, LIMIT).map((s) => s.state)).toEqual(Array(LIMIT).fill("sent"));
  expect(states[LIMIT]).toMatchObject({ state: "held", reasonCode: "post_limit_reached" });
  const last = (await items.actionIdOf(W, ids[LIMIT]!))!;
  expect(published(last)).toHaveLength(0);
  await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: "oauth_app:testnet", name: "Own app", meta: {}, value: { key: "x" } });
  await items.resume(W, ids[LIMIT]!, { userId: owner });
  await ledger.run(W, last);
  expect(published(last)).toHaveLength(1);
  info.monthlyPostLimit = undefined;
});

test("a Network that can't publish offers copy and paste: approval, then marked by hand, with no ledger row or plugin call", async () => {
  beforeWhen();
  const id = await postStep();
  const calls = net.state.published.length;
  const [p] = await draft(id, [{ connection: "later", credentialId: null, networkId: null, text: "By hand" }]);
  expect(p).toMatchObject({ ok: true, mode: "manual" });
  expect(await stateOf(p!.itemId)).toMatchObject({ state: "needs_approval" });
  const early = await call(`/api/w/${W}/social/posts/${p!.itemId}/posted`, cookie, { method: "POST", body: { url: null } });
  expect(early.status).toBe(400);
  await approve(p!.itemId);
  expect((await stateOf(p!.itemId)).state).toBe("scheduled");
  const marked = await call(`/api/w/${W}/social/posts/${p!.itemId}/posted`, cookie, { method: "POST", body: { url: "https://later.example/1" } });
  expect(marked.status).toBe(200);
  expect((await stateOf(p!.itemId)).state).toBe("applied");
  const [row] = await posts.list(W, id, "launch");
  expect(row).toMatchObject({ mode: "manual", text: "By hand", url: "https://later.example/1" });
  expect(await q("select action_id from social_posts where item_id = $1", [p!.itemId])).toEqual([{ action_id: null }]);
  expect(net.state.published.length).toBe(calls);
  await campaigns.results(W, id);
  const plan = await plans.plan(W, (await campaigns.campaign(W, id))!.planId);
  expect(plan!.tracking!.steps.find((s) => s.key === "launch")!.status).toBe("done");
});

test("a post copied by hand over its network's limit warns, so approve all leaves it out, and an edit to fit clears it", async () => {
  beforeWhen();
  const id = await postStep();
  const over = "x".repeat(21);
  const [p] = await draft(id, [{ connection: "later", credentialId: null, networkId: null, text: over }]);
  const LONG = "Over the Later limit of 20 by 1 characters. Shorten it before you post it.";
  expect(await stateOf(p!.itemId)).toMatchObject({ warnings: [{ code: "unspecified", text: LONG }], clean: false });
  const calendar = (await posts.write(W, { connection: "later", credentialId: null, networkId: null, text: over, at: WHEN }, owner)) as Result;
  expect(await stateOf(calendar.itemId)).toMatchObject({ warnings: [{ text: LONG }], clean: false });
  ok(await posts.edit(W, calendar.itemId, "x".repeat(20), owner));
  expect(await stateOf(calendar.itemId)).toMatchObject({ warnings: [], clean: true });
  ok(await posts.edit(W, calendar.itemId, "x".repeat(22), owner));
  expect((await stateOf(calendar.itemId)).warnings).toEqual([{ code: "unspecified", text: "Over the Later limit of 20 by 2 characters. Shorten it before you post it." }]);
});

test("a connected account on a Network missing the scope asks for a reconnect, and a follow-up it can't do is refused", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account(["read"]);
  expect((await draft(id, [{ ...a, text: "No" }]))[0]).toMatchObject({ ok: false, reason: "reconnect" });
});

test("another Workspace can't see or mark a post", async () => {
  beforeWhen();
  const id = await postStep();
  const [p] = await draft(id, [{ connection: "later", credentialId: null, networkId: null, text: "Mine" }]);
  const other = (await createOrg(cookie, "Other")).workspace.id;
  expect(await posts.list(other, id, "launch")).toEqual([]);
  const r = await call(`/api/w/${other}/social/posts/${p!.itemId}/posted`, cookie, { method: "POST", body: { url: null } });
  expect(r.status).toBe(404);
});

test("the Social agent's draft only fills the step for a person to read, and a merge field in it is refused", async () => {
  beforeWhen();
  const id = await postStep();
  const asked = ok(await campaigns.draftInput(W, id, "launch"));
  expect(asked.agent).toBe("social_drafter");
  const sink = campaignSinks({ facts, now }).draft;
  const context = (runId: string) => ({ input: asked.input, runId }) as never;
  const proposal = (text: string) => ({ kind: "draft", outputKey: "template", body: { schemaVersion: 1, text, citations: [] } }) as never;
  expect(await sink(W, proposal("Hi {{firstName}}"), context(crypto.randomUUID()))).toEqual({ ok: false, code: "unknown_merge_field" });
  const itemsBefore = await q("select count(*)::int as n from items");
  expect(await sink(W, proposal("Our audit is out."), context(crypto.randomUUID()))).toEqual({ ok: true, itemId: null });
  expect(await q("select count(*)::int as n from items")).toEqual(itemsBefore);
  const step = (await campaigns.campaign(W, id))!.steps.find((s) => s.key === "launch")!;
  expect(step.template).toMatchObject({ text: "Our audit is out.", subject: "" });
});

test("a post's rewrite gives the Social agent the post as data, lands on the same Item through a person's edit and voids its approval; an edit since wins", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  const [p] = await draft(id, [{ ...a, text: "Our audit is out." }]);
  const action = await items.actionIdOf(W, p!.itemId);
  expect((await approve(p!.itemId)).status).toBe(200);
  const started: { agent: string; input: { request: string; attached?: { text: string }; target: { redraft?: string } } }[] = [];
  const rewriting = createCampaigns({ plans, facts, items: () => items, outreach: () => outreach, posts: () => posts, startDraft: () => async (_w, s) => (started.push(s as never), { ok: true, run: { id: crypto.randomUUID() } }), now });
  expect(ok(await rewriting.rewrite(W, p!.itemId, { instruction: "Cut it down. No hype.", userId: owner, timeZone: "UTC", reason: "long", note: "No hype.", openedAt: clock.at })).runId).toBeTruthy();
  expect(started[0]!.agent).toBe("social_drafter");
  expect(started[0]!.input.request).toContain("as the person asked: Cut it down. No hype.");
  // The words a model may have written ride as data, never in the request.
  expect(started[0]!.input.request).not.toContain("Our audit is out.");
  expect(started[0]!.input.attached!.text).toContain("Our audit is out.");
  expect(started[0]!.input.target.redraft).toBe(p!.itemId);
  expect(await q("select decision, reason from review_decisions where item_id = $1", [p!.itemId])).toEqual([{ decision: "rewrite", reason: "long" }]);
  const sink = campaignSinks({ facts, now, posts: () => posts }).draft;
  const hand = (n: number, text: string) => sink(W, { kind: "draft", outputKey: "template", body: { schemaVersion: 1, text, citations: [] } } as never, { input: started[n]!.input, runId: crypto.randomUUID(), userId: owner } as never);
  // The network's rules apply, as to a person's edit.
  net.state.limit = 5;
  expect(await hand(0, "Far too long")).toMatchObject({ ok: false, code: "refused_by_network" });
  net.state.limit = 100;
  expect(await hand(0, "Audit out now, 40% faster.")).toEqual({ ok: true, itemId: p!.itemId });
  // Checked for claims like any draft: a number no Fact gives is a warning to read.
  expect(await stateOf(p!.itemId)).toMatchObject({ state: "needs_approval", warnings: [{ code: "uncited_number" }] });
  expect(await items.actionIdOf(W, p!.itemId)).toBe(action);
  expect((await posts.list(W, id, "launch")).map((x) => x.text)).toEqual(["Audit out now, 40% faster."]);

  // A person's edit while the next rewrite runs wins, and the rewrite is dropped.
  ok(await rewriting.rewrite(W, p!.itemId, { instruction: "Warmer.", userId: owner, timeZone: "UTC" }));
  ok(await posts.edit(W, p!.itemId, "My own words.", owner));
  expect(await hand(1, "Warm words.")).toEqual({ ok: false, code: "changed_since" });
  expect((await posts.list(W, id, "launch")).map((x) => x.text)).toEqual(["My own words."]);

  // A post outside any campaign has no writer to ask, and is refused as before.
  const calendar = await posts.write(W, { ...a, text: "Calendar post", at: WHEN }, owner);
  expect(await rewriting.rewrite(W, calendar.itemId!, { instruction: "Shorter.", userId: owner, timeZone: "UTC" })).toEqual({ ok: false, reason: "not_a_campaign_email" });
  expect(started).toHaveLength(2);
});

async function postOn(a: { connection: string; credentialId: string; networkId: string }, text: string, minutes: number) {
  const id = await postStep();
  const [p] = await draft(id, [{ ...a, text }], new Date(WHEN.getTime() + minutes * 60_000));
  await approve(p!.itemId);
  return p!.itemId;
}
const runAt = async (itemId: string, at: Date) => {
  clock.at = at;
  await ledger.run(W, (await items.actionIdOf(W, itemId))!);
};

test("a fresh account starts at the floor: one post a day, no links, and the next is held for a person", async () => {
  beforeWhen();
  own.app = "own";
  const a = await account();
  const linked = await postOn(a, "Read https://acme.test/audit", 0);
  const first = await postOn(a, "Hello", 20);
  const second = await postOn(a, "Again", 40);
  const later = new Date(WHEN.getTime() + 60 * 60_000);
  for (const id of [linked, first, second]) await runAt(id, later);
  expect((await stateOf(first)).state).toBe("sent");
  expect(await stateOf(second)).toMatchObject({ state: "held", reasonCode: "account_budget_reached" });
  expect(await stateOf(linked)).toMatchObject({ state: "held", reasonCode: "account_budget_reached" });
  const detail = (await q("select detail from action_events where action_id = $1 order by at desc limit 1", [await items.actionIdOf(W, linked)]))[0]?.detail;
  expect(detail).toBe("0 of 0 links today on this account");
  expect(published((await items.actionIdOf(W, second))!)).toHaveLength(0);
  expect(await healthRow(a)).toMatchObject({ posts: 1, links: 0, paused_at: null });
  // The next day a person moves it on, and it goes out.
  clock.at = new Date(WHEN.getTime() + 25 * 60 * 60_000);
  ok(await items.resume(W, second, { userId: owner }));
  await ledger.run(W, (await items.actionIdOf(W, second))!);
  expect((await stateOf(second)).state).toBe("sent");
  own.app = "system";
});

test("a paused account holds every post, and a pause halves the budget once", async () => {
  beforeWhen();
  const a = await account();
  await atCeiling(a);
  await pauseInWorkspace(W, a, { reason: "sending_limit", detail: "Test Net's rate limit" }, clock.at);
  await pauseInWorkspace(W, a, { reason: "sending_limit" }, clock.at);
  expect(await healthRow(a)).toMatchObject({ posts: 2, links: 1, pause_reason: "sending_limit" });
  const p = await postOn(a, "Hello", 0);
  await runAt(p, new Date(WHEN.getTime() + 60 * 60_000));
  expect(await stateOf(p)).toMatchObject({ state: "held", reasonCode: "account_paused" });
});

test("another Workspace sees none of this one's account health", async () => {
  const a = await account();
  await atCeiling(a);
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [crypto.randomUUID()]);
  const r = await db.query("select count(*)::int as n from social_account_health");
  await db.query("commit");
  expect(r.rows).toEqual([{ n: 0 }]);
});

test("a person reports a removal, lowers a limit and lifts the pause; nobody can raise a budget past the ceiling", async () => {
  const a = await account();
  await atCeiling(a);
  const id = (await q("select id from social_accounts where credential_id = $1", [a.credentialId]))[0].id as string;
  const path = (what: string) => `/api/w/${W}/social/accounts/${id}/${what}`;
  expect((await call(path("removed"), cookie, { method: "POST", body: { note: "The post vanished" } })).status).toBe(200);
  expect(await healthRow(a)).toMatchObject({ posts: 2, links: 1, pause_reason: "removed" });
  expect((await call(path("limits"), cookie, { method: "PUT", body: { posts: 6 } })).status).toBe(400);
  expect((await call(path("limits"), cookie, { method: "PUT", body: { posts: 1, links: 0 } })).status).toBe(200);
  expect(await healthRow(a)).toMatchObject({ posts: 1, links: 0 });
  expect((await call(path("unpause"), cookie, { method: "POST" })).status).toBe(200);
  expect(await healthRow(a)).toMatchObject({ paused_at: null, posts: 1 });
  expect((await call(`/api/w/${W}/social/accounts/${crypto.randomUUID()}/unpause`, cookie, { method: "POST" })).status).toBe(404);
});

test("the daily sweep grows a budget one step per seven clean days, never while paused, and never past the ceiling", async () => {
  const a = await account();
  const start = new Date("2026-12-01T04:00:00Z");
  await q("insert into social_account_health (workspace_id, credential_id, network_id, posts, replies, links, clean_since, updated_at) values ($1, $2, $3, 1, 3, 0, $4, $4)", [W, a.credentialId, a.networkId, start]);
  const day = (n: number) => new Date(start.getTime() + n * 24 * 60 * 60_000);
  await stepUpCredential(W, a.credentialId, day(6));
  expect(await healthRow(a)).toMatchObject({ posts: 1, links: 0 });
  await stepUpCredential(W, a.credentialId, day(7));
  expect(await healthRow(a)).toMatchObject({ posts: 2, links: 1 });
  await pauseInWorkspace(W, a, { reason: "sending_limit" }, day(8));
  await stepUpCredential(W, a.credentialId, day(30));
  expect(await healthRow(a)).toMatchObject({ posts: 1, links: 0 });
  await unpauseAccount(W, a, day(30));
  await stepUpCredential(W, a.credentialId, day(33));
  expect(await healthRow(a)).toMatchObject({ posts: 1 });
  for (let week = 1; week <= 12; week++) await stepUpCredential(W, a.credentialId, day(30 + week * 7));
  expect(await healthRow(a)).toMatchObject({ posts: 5, links: 3 });
});

test("a hand post counts once marked posted, and the next one that day warns instead of holding", async () => {
  beforeWhen();
  const c = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: crypto.randomUUID(), name: "Ana", meta: {}, value: { key: "x" } });
  if (!c.ok) throw new Error(c.reason);
  const networkId = crypto.randomUUID();
  await q("insert into social_accounts (workspace_id, credential_id, connection, account_type, network_id, name) values ($1, $2, 'later', 'page', $3, 'Page')", [W, c.credential.id, networkId]);
  const a = { connection: "later", credentialId: c.credential.id, networkId };
  const [first] = await draft(await postStep(), [{ ...a, text: "By hand" }]);
  expect((await stateOf(first!.itemId)).warnings).toEqual([]);
  await approve(first!.itemId);
  clock.at = WHEN;
  expect((await call(`/api/w/${W}/social/posts/${first!.itemId}/posted`, cookie, { method: "POST", body: { url: null } })).status).toBe(200);
  const [second] = await draft(await postStep(), [{ ...a, text: "Again by hand" }], new Date(WHEN.getTime() + 20 * 60_000));
  const after = await stateOf(second!.itemId);
  expect(after.state).toBe("needs_approval");
  expect(after.warnings.map((w) => w.text)).toContain("1 of 1 posts that day on this account. Posting more by hand raises the risk of a restriction.");
});

test("the Campaign's activity offers to undo its latest launch move, back to where it came from", async () => {
  beforeWhen();
  // December, so no other test's launch day is this one's.
  const id = await postStep();
  ok(await campaigns.moveAnchor(W, id, { on: "2026-12-14" }, { userId: owner }));
  ok(await campaigns.moveAnchor(W, id, { on: "2026-12-15" }, { userId: owner }));
  const undos = async () => (await campaigns.activity(W, id))!.flatMap((l) => (l.undo ? [l.undo] : []));
  expect(await undos()).toEqual([{ kind: "launch", on: "2026-12-14" }]);
  // Undoing is a move like any other, so it can be undone in turn.
  ok(await campaigns.moveAnchor(W, id, { on: "2026-12-14" }, { userId: owner }));
  expect(await undos()).toEqual([{ kind: "launch", on: "2026-12-15" }]);
});

test("a planned step shows as empty in its week until something is drafted for it", async () => {
  beforeWhen();
  // Late December, so no other test's steps fall in this week.
  const id = await postStep();
  ok(await campaigns.moveAnchor(W, id, { on: "2026-12-28" }, { userId: owner }));
  const empty = async () => (await campaigns.stepsWithoutDrafts(W, "2026-12-28", "2027-01-03")).filter((s) => s.campaignId === id);
  expect(await empty()).toEqual([{ campaignId: id, campaign: "Q4", stepKey: "launch", title: "Launch post", on: "2026-12-29" }]);
  expect((await campaigns.stepsWithoutDrafts(W, "2027-01-04", "2027-01-10")).filter((s) => s.campaignId === id)).toEqual([]);
  await draft(id, [{ ...(await account()), text: "Out now" }], new Date("2026-12-29T12:00:00Z"));
  expect(await empty()).toEqual([]);
});

test("a post on another Campaign's launch day warns and stays out of approve all clean; one on its own launch day doesn't", async () => {
  beforeWhen();
  const [launching, other] = [await postStep(), await postStep()];
  ok(await campaigns.moveAnchor(W, launching, { on: "2026-11-05" }, { userId: owner }));
  expect((await campaigns.launchesBetween(W, "2026-11-05", "2026-11-05")).map((l) => l.campaignId)).toContain(launching);
  expect((await campaigns.launchesBetween(W, "2026-11-06", "2026-11-30")).map((l) => l.campaignId)).not.toContain(launching);
  const a = await account();
  const onTheDay = new Date("2026-11-05T12:00:00Z");
  const [clash] = await draft(other, [{ ...a, text: "Ours" }], onTheDay);
  expect((await stateOf(clash!.itemId)).warnings.map((w) => w.text)).toContain(`Campaign "Q4" launches that day.`);
  expect((await stateOf(clash!.itemId)).clean).toBe(false);
  const b = await account();
  const [own] = await draft(launching, [{ ...b, text: "Launch" }], onTheDay);
  expect((await stateOf(own!.itemId)).warnings.map((w) => w.text)).not.toContain(`Campaign "Q4" launches that day.`);
});

test("a launch that follows a post step moves once that post is live, noticed by the daily job", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  // A post step is a launch only once it names the account whose post is its output.
  expect(await campaigns.followStep(W, id, "launch", { userId: owner })).toEqual({ ok: false, reason: "not_output_step" });
  const [p] = await draft(id, [{ ...a, text: "We're live" }]);
  ok(await campaigns.setupStep(W, id, "launch", { type: "post", touchClass: null, mailboxCredentialId: null, audience: "everyone", outputConnection: a.connection, outputNetworkId: a.networkId }));
  ok(await campaigns.followStep(W, id, "launch", { userId: owner }));
  await approve(p!.itemId);
  await campaigns.followAnchors();
  expect((await campaigns.campaign(W, id))!.anchor).toEqual({ on: "2026-11-02", stepKey: "launch" });
  // The post goes out on Tue 3 Nov, a day after the planned launch: the next daily run moves it.
  await dispatch(p!.itemId);
  await campaigns.followAnchors();
  expect((await campaigns.campaign(W, id))!.anchor).toEqual({ on: "2026-11-03", stepKey: "launch" });
});

test("a person's edit of a post's text keeps its Action, voids an approval, and is refused over the network's limit", async () => {
  beforeWhen();
  const id = await postStep();
  const a = await account();
  const [p] = await draft(id, [{ ...a, text: "First", followUps: ["More"] }]);
  const action = await items.actionIdOf(W, p!.itemId);
  expect((await approve(p!.itemId)).status).toBe(200);
  expect((await stateOf(p!.itemId)).state).toBe("scheduled");
  const edit = (text: string, ws = W) => call(`/api/w/${ws}/social/posts/${p!.itemId}`, cookie, { method: "PUT", body: { text } });
  const saved = await edit("Second");
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ ok: true, count: { used: 6, limit: 100 } });
  expect((await stateOf(p!.itemId)).state).toBe("needs_approval");
  expect(await items.actionIdOf(W, p!.itemId)).toBe(action);
  const [row] = await q("select spec from actions where id = $1", [action]);
  expect(row.spec).toMatchObject({ text: "Second", followUps: ["More"] });
  net.state.limit = 5;
  const over = await edit("123456");
  expect(over.status).toBe(409);
  expect(await over.json()).toEqual({ error: "refused_by_network", detail: "6 of 5 characters" });
  net.state.limit = 100;
  expect((await edit("Nope", (await createOrg(cookie, "Elsewhere")).workspace.id)).status).toBe(404);
});

test("editing a copy-and-paste post sends an approved one back for approval, and a posted one can't change", async () => {
  beforeWhen();
  const id = await postStep();
  const [p] = await draft(id, [{ connection: "later", credentialId: null, networkId: null, text: "By hand" }]);
  await approve(p!.itemId);
  const edit = (text: string) => call(`/api/w/${W}/social/posts/${p!.itemId}`, cookie, { method: "PUT", body: { text } });
  expect((await edit("By hand, better")).status).toBe(200);
  expect((await stateOf(p!.itemId)).state).toBe("needs_approval");
  expect((await posts.list(W, id, "launch"))[0]).toMatchObject({ mode: "manual", text: "By hand, better" });
  await approve(p!.itemId);
  await call(`/api/w/${W}/social/posts/${p!.itemId}/posted`, cookie, { method: "POST", body: { url: null } });
  expect((await edit("Too late")).status).toBe(409);
});

test("a post written on the Calendar waits for approval, outside any campaign, on either kind of network", async () => {
  beforeWhen();
  const a = await account();
  const write = (body: object) => call(`/api/w/${W}/social/posts`, cookie, { method: "POST", body: { at: WHEN.toISOString(), ...body } });
  const made = await write({ ...a, text: "From the calendar" });
  expect(made.status).toBe(201);
  const { itemId, mode } = (await made.json()) as { itemId: string; mode: string };
  expect(mode).toBe("publish");
  expect(await stateOf(itemId)).toMatchObject({ state: "needs_approval" });
  expect(await q("select campaign_id, step_key from social_posts where item_id = $1", [itemId])).toEqual([{ campaign_id: null, step_key: `calendar:${itemId}` }]);
  // A second post on the same account is its own, and the two share a slot.
  const second = (await (await write({ ...a, text: "Another" })).json()) as { itemId: string };
  expect((await stateOf(second.itemId)).warnings.map((w) => w.text)).toContain("Another post on this account is planned within 15 minutes.");
  expect((await call(`/api/w/${W}/social/posts/${itemId}`, cookie, { method: "PUT", body: { text: "Edited" } })).status).toBe(200);
  const title = async (id: string) => ((await (await call(`/api/w/${W}/items/${id}`, cookie)).json()) as { item: { title: string } }).item.title;
  // Its title is its first words, so an edit retitles it, published or copied by hand.
  expect(await title(itemId)).toMatch(/: Edited$/);
  const hand = (await (await write({ connection: "later", credentialId: null, networkId: null, text: "Copy me" })).json()) as { itemId: string; mode: string };
  expect(hand.mode).toBe("manual");
  expect(await stateOf(hand.itemId)).toMatchObject({ state: "needs_approval" });
  expect(await title(hand.itemId)).toBe("Later: Copy me");
  ok(await posts.edit(W, hand.itemId, "Copy me, better", owner));
  expect(await title(hand.itemId)).toBe("Later: Copy me, better");
  // A time already gone is refused, as a move to one is.
  const past = await write({ ...a, text: "Too late", at: "2026-11-01T09:00:00Z" });
  expect(past.status).toBe(400);
  expect(await past.json()).toEqual({ error: "slot_in_past" });
  net.state.limit = 5;
  const over = await write({ ...a, text: "123456" });
  expect(over.status).toBe(409);
  net.state.limit = 100;
  expect((await write({ connection: "nope", credentialId: null, networkId: null, text: "x" })).status).toBe(400);
});

test("a post written in a system actor's name keeps its extra warnings, waits for approval and names the actor", async () => {
  beforeWhen();
  const a = await account();
  const actor = { system: `external_token:${crypto.randomUUID()}` };
  const r = await posts.writeAs(W, { ...a, text: "From a token", at: WHEN }, actor, [warn("untrusted_source", 'Sent by External token "Zapier".')]);
  if (!r.ok) throw new Error(r.reason);
  expect(await stateOf(r.itemId!)).toMatchObject({ state: "needs_approval", clean: false, warnings: expect.arrayContaining([{ code: "untrusted_source", text: 'Sent by External token "Zapier".' }]) });
  const detail = (await (await call(`/api/w/${W}/items/${r.itemId}`, cookie)).json()) as { timeline: { actor: { kind: string; id: string } }[] };
  expect(detail.timeline[0]?.actor).toEqual({ kind: "system", id: actor.system });
});
