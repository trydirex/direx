// SPDX-License-Identifier: AGPL-3.0-only
// A network core has never heard of: it connects through the vault, offers its targets, reports its
// health and says what it can do, over HTTP with real sessions, the real vault and the real host.
import { socialNetworks, type SocialNetworkInfo } from "@direx/extensions";
import { afterAll, expect, test, vi } from "vitest";
import { createBoss } from "./jobs/boss";
import { createVault, rootKeyFromEnv, singleAppSource, type AppProvider } from "./modules/credentials/index";
import { testApp, vaultDb } from "./modules/credentials/fixtures/app";
import { loadPlugins } from "./modules/plugins/index";
import { createTestNet } from "./modules/social/fixtures/net";
import { createSocial, socialRoutes } from "./modules/social/index";
import { sendForCredential } from "./worker";

process.env.DIREX_MASTER_KEY ??= "11".repeat(32);

const { close, q } = vaultDb();
const boss = createBoss();
await boss.start();
const server = Bun.serve({ port: 0, fetch: () => Response.json({ access_token: "tok", expires_in: 5_184_000 }) });
afterAll(async () => {
  server.stop(true);
  await boss.stop({ graceful: false });
  await close();
});
const base = `http://localhost:${server.port}`;
const DAY = 24 * 60 * 60_000;

const provider: AppProvider = { connection: "testnet", authorizeUrl: `${base}/a`, tokenUrl: `${base}/t`, issuers: [], scopes: ["read"], requiredScopes: [], extraParams: {}, pkce: false, scopeSource: "identity", renewal: { kind: "reconnect" } };
const info: SocialNetworkInfo = {
  connection: "testnet",
  label: "Test Net",
  accountTypes: ["page"],
  connect: "oauth",
  availability: { cloud: "awaiting_approval", self_host: "awaiting_approval" },
  tokenEnds: true,
  features: [
    { key: "publish", built: true, scopes: ["read"] },
    { key: "links", built: true, scopes: [], needsOwnApp: true },
    { key: "analytics", built: true, scopes: ["stats"] },
    { key: "comments", built: false, scopes: [] },
  ],
  wizard: { consoleUrl: "https://dev.example", scopes: ["read"], steps: ["Make an app"] },
};
const unbuilt: SocialNetworkInfo = { ...info, connection: "later", label: "Later", availability: { cloud: "not_built", self_host: "not_built" }, features: [], wizard: undefined };

function setup(o: { deployment?: "cloud" | "self_host"; systemApp?: boolean; networks?: SocialNetworkInfo[] } = {}) {
  const net = createTestNet();
  const clock = { t: Date.now() };
  const now = () => new Date(clock.t);
  const vault = createVault({
    rootKey: rootKeyFromEnv(),
    now,
    appProviders: [provider],
    appSources: [singleAppSource("deployment", async () => (o.systemApp === false ? null : { clientId: "direx", clientSecret: "direx-secret" }))],
    identify: (ws, c, t) => social.identify(ws, c, t),
    callbackUrl: "http://direx.test/cb",
    timeoutMs: 500,
  });
  const plugins = loadPlugins({ sources: [{ mode: "in_process", plugin: net.plugin }], credentials: vault.credentials, confinement: "none", boss });
  const social = createSocial({ plugins: () => plugins, vault: () => vault, networks: () => o.networks ?? [info, unbuilt], deployment: () => o.deployment ?? "cloud", callbackUrl: () => "http://direx.test/cb", now });
  const t = testApp(vault);
  t.app.route("/", socialRoutes({ social: () => social }));
  const connect = async (ws: string, userId: string) => {
    const s = await vault.start({ workspaceId: ws, userId, connection: "testnet" });
    if (!s.ok) throw new Error(s.reason);
    const r = await vault.callback({ cookie: s.cookie, sessionUserId: userId, state: new URL(s.url).searchParams.get("state")!, code: "c" });
    if (!r.ok) throw new Error(r.reason);
    return r.credential;
  };
  return { ...t, net, clock, vault, social, plugins, connect };
}
const body = async <T>(r: Response) => (await r.json()) as T;
type Target = { id: string; added: boolean };
type Account = { name: string; status: string; warning: { level: string } | null; canDo: { feature: string; status: string }[]; ownAppLimits: string[]; lastCheckedAt: string | null };

test("a login with three Pages offers all three, and only the picked ones become accounts", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  const { targets } = await body<{ targets: Target[] }>(await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie));
  expect(targets.map((t) => [t.id, t.added])).toEqual([["p1", false], ["p2", false], ["p3", false]]);
  const added = await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["p1", "p3"] } });
  expect(added.status).toBe(200);
  const { accounts } = await body<{ accounts: Account[] }>(await s.call(`/api/w/${ws}/social/accounts`, owner.cookie));
  expect(accounts.map((a) => a.name)).toEqual(["Page one", "Page three"]);
  expect(JSON.stringify(await q(ws, "select * from social_accounts"))).not.toContain("tok");
});

test("a target the network didn't offer can't be added", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  const r = await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["someone-elses-page"] } });
  expect(r.status).toBe(400);
  expect(await q(ws, "select 1 from social_accounts")).toHaveLength(0);
});

test("a login with one target offers it, and it becomes an account only once a person picks it", async () => {
  const s = setup();
  s.net.state.identity = { accountId: "me", accountLabel: "Just me", accountType: "member", scopes: ["read"] };
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  const { targets } = await body<{ targets: Target[] }>(await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie));
  expect(targets.map((t) => [t.id, t.added])).toEqual([["me", false]]);
  expect((await s.social.accounts(ws)).length).toBe(0);
  await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["me"] } });
  const { accounts } = await body<{ accounts: (Account & { accountType: string })[] }>(await s.call(`/api/w/${ws}/social/accounts`, owner.cookie));
  expect(accounts.map((a) => [a.name, a.accountType])).toEqual([["Just me", "member"]]);
});

test("another Workspace can't see or use a login", async () => {
  const s = setup();
  const a = await s.workspace();
  const b = await s.workspace();
  const c = await s.connect(a.ws, a.owner.userId);
  await s.call(`/api/w/${a.ws}/social/credentials/${c.id}/targets`, a.owner.cookie, { method: "POST", body: { ids: ["p1"] } });
  expect((await body<{ accounts: Account[] }>(await s.call(`/api/w/${b.ws}/social/accounts`, b.owner.cookie))).accounts).toEqual([]);
  expect((await s.call(`/api/w/${b.ws}/social/credentials/${c.id}/targets`, b.owner.cookie)).status).toBe(404);
  expect(await q(b.ws, "select 1 from social_accounts")).toHaveLength(0);
});

test("can do: built and granted, needs own app, needs a reconnect, coming", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["p1"] } });
  const read = async () => (await body<{ accounts: Account[] }>(await s.call(`/api/w/${ws}/social/accounts`, owner.cookie))).accounts[0]!.canDo.map((x) => [x.feature, x.status]);
  expect(await read()).toEqual([["publish", "available"], ["links", "needs_own_app"], ["analytics", "reconnect"], ["comments", "coming"]]);
  await s.vault.create({ workspaceId: ws, actorUserId: owner.userId, scope: "workspace", kind: "basic", key: "oauth_app:testnet", name: "Ours", meta: { username: "own" }, value: { password: "own-secret" } });
  expect((await read())[1]).toEqual(["links", "available"]);
});

test("the own app's limits show only while the Workspace's own app is in use", async () => {
  const s = setup({ networks: [{ ...info, ownAppLimits: ["Only testers can connect."] }] });
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["p1"] } });
  const read = async () => (await body<{ accounts: Account[] }>(await s.call(`/api/w/${ws}/social/accounts`, owner.cookie))).accounts[0]!.ownAppLimits;
  expect(await read()).toEqual([]);
  await s.vault.create({ workspaceId: ws, actorUserId: owner.userId, scope: "workspace", kind: "basic", key: "oauth_app:testnet", name: "Ours", meta: { username: "own" }, value: { password: "own-secret" } });
  expect(await read()).toEqual(["Only testers can connect."]);
});

test("a network's refusal asks for a reconnect; a network failure changes nothing but the time", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["p1"] } });
  s.net.state.throwOnHealth = true;
  s.clock.t += 1000;
  await s.social.checkHealth(ws, c.id, "testnet");
  expect((await s.vault.find(ws, c.id))?.status).toBe("active");
  s.net.state.throwOnHealth = false;
  s.net.state.health = { ok: false, reason: "other" };
  await s.social.checkHealth(ws, c.id, "testnet");
  expect((await s.vault.find(ws, c.id))?.status).toBe("active");
  s.net.state.health = { ok: false, reason: "auth" };
  await s.social.checkHealth(ws, c.id, "testnet");
  expect((await s.vault.find(ws, c.id))?.status).toBe("needs_reauth");
});

test("the sweep skips a network whose reads are billed", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  await s.social.sweep([{ workspaceId: ws, credentialId: c.id, connection: "testnet" }]);
  expect(s.net.state.healthCalls).toBe(1);
  const billed = createSocial({ plugins: () => s.plugins, vault: () => s.vault, networks: () => [{ ...info, noDailyHealth: true }], deployment: () => "cloud", callbackUrl: () => "" });
  await billed.sweep([{ workspaceId: ws, credentialId: c.id, connection: "testnet" }]);
  expect(s.net.state.healthCalls).toBe(1);
});

test("a token 13 days from its end warns, one with 30 left doesn't, and 2 days is urgent", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["p1"] } });
  const warning = async () => (await s.social.accounts(ws))[0]!.warning?.level ?? null;
  s.clock.t += 30 * DAY;
  expect(await warning()).toBeNull();
  s.clock.t += 17 * DAY;
  expect(await warning()).toBe("soon");
  s.clock.t += 11 * DAY;
  expect(await warning()).toBe("urgent");
});

test("a token that renews itself warns only for its grant", async () => {
  const s = setup();
  const grantExpiresAt = new Date(Date.now() + 10 * DAY).toISOString();
  s.net.state.identity = { accountId: "me", accountLabel: "Me", scopes: ["read"], grantExpiresAt };
  const quiet = createSocial({ plugins: () => s.plugins, vault: () => s.vault, networks: () => [{ ...info, tokenEnds: false }], deployment: () => "cloud", callbackUrl: () => "", now: () => new Date(s.clock.t) });
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  await quiet.addTargets(ws, c.id, ["me"]);
  expect((await quiet.accounts(ws))[0]!.warning?.endsAt.toISOString()).toBe(grantExpiresAt);
});

test("disconnecting removes the targets and keeps the history", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["p1"] } });
  const gone = await s.call(`/api/w/${ws}/social/credentials/${c.id}`, owner.cookie, { method: "DELETE" });
  expect(gone.status).toBe(200);
  expect(await q(ws, "select 1 from social_accounts")).toHaveLength(0);
  expect(await s.vault.find(ws, c.id)).toBeFalsy();
  expect((await s.vault.events(ws, c.id)).map((e) => e.consumer)).toContain("disconnect");
});

test("disconnecting needs a recent sign-in, and someone else's login needs a manager", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  const marketer = await s.signIn();
  await q(ws, "insert into workspace_members (workspace_id, user_id, role, created_at) values ($1, $2, 'marketer', now())", [ws, marketer.userId]);
  const remove = (cookie: string) => s.call(`/api/w/${ws}/social/credentials/${c.id}`, cookie, { method: "DELETE" });
  expect((await remove(marketer.cookie)).status).toBe(403);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const stale = await remove(owner.cookie);
    expect([stale.status, await stale.json()]).toEqual([403, { error: "step_up_required" }]);
  } finally {
    vi.useRealTimers();
  }
  expect((await s.vault.find(ws, c.id))?.status).toBe("active");
});

test("this route won't remove a secret that isn't a network login", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  const made = await s.vault.create({ workspaceId: ws, actorUserId: owner.userId, scope: "user", kind: "api_key", key: "k", name: "k", meta: {}, value: { key: "sk" } });
  if (!made.ok) throw new Error(made.reason);
  const r = await s.call(`/api/w/${ws}/social/credentials/${made.credential.id}`, owner.cookie, { method: "DELETE" });
  expect(r.status).toBe(400);
  expect((await s.vault.find(ws, made.credential.id))?.status).toBe("active");
});

test("a form network: a refused sign-in stores nothing, a good one stores an encrypted password, and again replaces it", async () => {
  const s = setup({ networks: [{ ...info, connect: "form", wizard: undefined }] });
  const { ws, owner } = await s.workspace();
  const send = (body: unknown) => s.call(`/api/w/${ws}/social/testnet/form`, owner.cookie, { method: "POST", body });
  s.net.state.identity = { nope: true };
  expect((await send({ username: "ana", password: "app-pass-1" })).status).toBe(422);
  expect(await q(ws, "select 1 from credentials where deleted_at is null")).toHaveLength(0);
  expect((await send({ username: "ana", password: "p", server: "http://169.254.169.254" })).status).toBe(400);

  s.net.state.identity = { accountId: "did:1", accountLabel: "@ana" };
  const saved = await send({ username: "ana", password: "app-pass-1" });
  expect(saved.status).toBe(201);
  expect(await saved.clone().text()).not.toContain("app-pass-1");
  const { credentialId } = (await saved.json()) as { credentialId: string };
  const stored = await q(ws, "select key, connection, kind, meta from credentials where id = $1", [credentialId]);
  expect(stored).toEqual([{ key: "testnet:did:1", connection: "testnet", kind: "basic", meta: { username: "ana" } }]);
  const again = (await (await send({ username: "ana", password: "app-pass-2" })).json()) as { credentialId: string };
  expect(again.credentialId).toBe(credentialId);
  await s.vault.markNeedsReauth(ws, credentialId);
  await send({ username: "ana", password: "app-pass-3" });
  expect((await s.vault.find(ws, credentialId))?.status).toBe("active");
  expect(await q(ws, "select 1 from credentials where deleted_at is null")).toHaveLength(1);
});

test("a network that isn't a form, or isn't built, has no form", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  expect((await s.call(`/api/w/${ws}/social/testnet/form`, owner.cookie, { method: "POST", body: { username: "a", password: "b" } })).status).toBe(404);
});

test("a social account can't send a campaign's email", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  expect(await sendForCredential(s.plugins, s.vault)(ws, c.id)).toBeUndefined();
});

test("networks: with no app, self-host offers the wizard and cloud says not available; unbuilt stays unbuilt", async () => {
  const s = setup({ deployment: "self_host", systemApp: false });
  const { ws, owner } = await s.workspace();
  type N = { connection: string; availability: string; canConnect: boolean; wizard?: { callbackUrl: string; scopes: string[] } };
  const list = async (x: typeof s, w: string, cookie: string) => (await body<{ networks: N[] }>(await x.call(`/api/w/${w}/social/networks`, cookie))).networks;
  const [net, later] = await list(s, ws, owner.cookie);
  expect(net).toMatchObject({ availability: "awaiting_approval", canConnect: false, wizard: { callbackUrl: "http://direx.test/cb", scopes: ["read"] } });
  expect(later).toMatchObject({ availability: "not_built", canConnect: false });
  expect(later!.wizard).toBeUndefined();
  const cloud = setup({ deployment: "cloud", systemApp: false });
  const w = await cloud.workspace();
  const [onCloud] = await list(cloud, w.ws, w.owner.cookie);
  expect(onCloud).toMatchObject({ availability: "not_available", canConnect: false });
  expect(onCloud!.wizard).toBeUndefined();
  expect((await cloud.call(`/api/w/${w.ws}/connections/testnet/start`, w.owner.cookie, { method: "POST" })).status).toBe(404);
});

test("networks: the wizard warns when the network would refuse this install's callback URL, and connecting stays as it was", async () => {
  const tiktok = { ...info, callback: socialNetworks().find((n) => n.connection === "tiktok")!.callback };
  const s = setup({ deployment: "self_host", systemApp: false, networks: [tiktok, { ...unbuilt, callback: tiktok.callback }] });
  const { ws, owner } = await s.workspace();
  const [net, later] = (await body<{ networks: { canConnect: boolean; callbackProblem: string | null }[] }>(await s.call(`/api/w/${ws}/social/networks`, owner.cookie))).networks;
  expect(net).toMatchObject({ canConnect: false, callbackProblem: "needs_https" });
  expect(later!.callbackProblem).toBeNull();
  const onHttps = createSocial({ plugins: () => s.plugins, vault: () => s.vault, networks: () => [tiktok], deployment: () => "self_host", callbackUrl: () => "https://direx.example/cb" });
  const [secure] = await onHttps.networks(ws);
  expect(secure).toMatchObject({ canConnect: false, callbackProblem: null });
});

test("a network the plugin doesn't describe fully isn't a network", async () => {
  const s = setup();
  expect(s.plugins.socialConnections()).toEqual(["testnet"]);
  expect(s.plugins.socialFor("gmail")).toBeUndefined();
});

test("nothing in any response or stored row holds a token", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["p1"] } });
  for (const path of ["networks", "accounts", `credentials/${c.id}/targets`]) {
    expect(await (await s.call(`/api/w/${ws}/social/${path}`, owner.cookie)).text()).not.toMatch(/"tok"|direx-secret/);
  }
});

// Several accounts on one network: each starts its budget where a person says, and on a network that
// allows several only for different purposes, every account after the first states its own.
test("an account a person calls established starts higher; a new one starts at the floor", async () => {
  const s = setup();
  s.net.state.identity = { accountId: "me", accountLabel: "Main", accountType: "member", scopes: ["read"] };
  const { ws, owner } = await s.workspace();
  const main = await s.connect(ws, owner.userId);
  const added = await s.call(`/api/w/${ws}/social/credentials/${main.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["me"], established: ["me"] } });
  expect(added.status).toBe(200);
  s.net.state.identity = { accountId: "clips", accountLabel: "Clips", accountType: "member", scopes: ["read"] };
  const clips = await s.connect(ws, owner.userId);
  await s.call(`/api/w/${ws}/social/credentials/${clips.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["clips"] } });
  const budgets = Object.fromEntries((await s.social.accounts(ws)).map((a) => [a.name, a.health.budget]));
  expect(budgets).toEqual({ Main: { posts: 3, replies: 10, links: 1 }, Clips: { posts: 1, replies: 3, links: 0 } });
});

test("an older account can be called established once, while it is at the floor and not paused", async () => {
  const s = setup();
  s.net.state.identity = { accountId: "me", accountLabel: "Main", accountType: "member", scopes: ["read"] };
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["me"] } });
  const [a] = await s.social.accounts(ws);
  const mark = () => s.call(`/api/w/${ws}/social/accounts/${a!.id}/established`, owner.cookie, { method: "POST" });
  expect((await mark()).status).toBe(200);
  expect((await s.social.accounts(ws))[0]!.health.budget).toEqual({ posts: 3, replies: 10, links: 1 });
  expect((await mark()).status).toBe(409);

  s.net.state.identity = { accountId: "two", accountLabel: "Two", accountType: "member", scopes: ["read"] };
  const paused = await s.connect(ws, owner.userId);
  await s.call(`/api/w/${ws}/social/credentials/${paused.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["two"] } });
  const two = (await s.social.accounts(ws)).find((x) => x.name === "Two")!;
  await s.call(`/api/w/${ws}/social/accounts/${two.id}/removed`, owner.cookie, { method: "POST", body: { note: null } });
  expect((await s.call(`/api/w/${ws}/social/accounts/${two.id}/established`, owner.cookie, { method: "POST" })).status).toBe(409);
});

test("on a network that needs an angle, the second account can't be added or keep going without one", async () => {
  const s = setup({ networks: [{ ...info, angleForEachAccount: true }, unbuilt] });
  const { ws, owner } = await s.workspace();
  const add = async (accountId: string, angles?: Record<string, string>) => {
    s.net.state.identity = { accountId, accountLabel: accountId, accountType: "member", scopes: ["read"] };
    const c = await s.connect(ws, owner.userId);
    return s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie, { method: "POST", body: { ids: [accountId], ...(angles ? { angles } : {}) } });
  };
  expect((await add("main")).status).toBe(200);
  const refused = await add("clips");
  expect([refused.status, (await body<{ error: string }>(refused)).error]).toEqual([400, "angle_required"]);
  expect((await add("clips", { clips: "  " })).status).toBe(400);
  expect((await add("clips", { clips: "Pricing tips" })).status).toBe(200);

  const accounts = await s.social.accounts(ws);
  expect(accounts.map((a) => [a.name, a.angle, a.siblings])).toEqual([["main", null, 1], ["clips", "Pricing tips", 1]]);
  const clips = accounts.find((a) => a.name === "clips")!;
  const about = (b: { runBy: string | null; angle: string | null }, id = clips.id) => s.call(`/api/w/${ws}/social/accounts/${id}/about`, owner.cookie, { method: "PUT", body: b });
  expect((await about({ runBy: "Bio: clips from Acme", angle: null })).status).toBe(400);
  expect((await about({ runBy: "Bio: clips from Acme", angle: "Founder stories" })).status).toBe(200);
  // The first account never needed an angle, so it can save Run by without one.
  expect((await about({ runBy: "Bio: Acme", angle: null }, accounts[0]!.id)).status).toBe(200);
  expect((await s.social.accounts(ws)).map((a) => [a.runBy, a.angle])).toEqual([["Bio: Acme", null], ["Bio: clips from Acme", "Founder stories"]]);
  expect((await about({ runBy: "x".repeat(201), angle: null }, accounts[0]!.id)).status).toBe(400);
});

test("a network without angles never asks for one, and a lone account has no siblings", async () => {
  const s = setup();
  const { ws, owner } = await s.workspace();
  s.net.state.identity = { accountId: "solo", accountLabel: "Solo", accountType: "member", scopes: ["read"] };
  const one = await s.connect(ws, owner.userId);
  await s.call(`/api/w/${ws}/social/credentials/${one.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["solo"] } });
  expect((await s.social.accounts(ws)).map((a) => a.siblings)).toEqual([0]);
  s.net.state.identity = { accountId: "second", accountLabel: "Second", accountType: "member", scopes: ["read"] };
  const two = await s.connect(ws, owner.userId);
  expect((await s.call(`/api/w/${ws}/social/credentials/${two.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["second"] } })).status).toBe(200);
  expect((await s.social.accounts(ws)).map((a) => a.siblings)).toEqual([1, 1]);
});

test("the picker is told when a target needs an angle, and a row when it can still start higher", async () => {
  const s = setup({ networks: [{ ...info, angleForEachAccount: true }, unbuilt] });
  const { ws, owner } = await s.workspace();
  const offered = async (accountId: string) => {
    s.net.state.identity = { accountId, accountLabel: accountId, accountType: "member", scopes: ["read"] };
    const c = await s.connect(ws, owner.userId);
    return { c, targets: (await body<{ targets: (Target & { needsAngle: boolean })[] }>(await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie))).targets };
  };
  const first = await offered("main");
  expect(first.targets.map((t) => t.needsAngle)).toEqual([false]);
  await s.call(`/api/w/${ws}/social/credentials/${first.c.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["main"] } });
  expect((await offered("clips")).targets.map((t) => t.needsAngle)).toEqual([true]);
  const [main] = await s.social.accounts(ws);
  expect([main!.asksAngle, main!.establishable]).toEqual([true, true]);
  await s.call(`/api/w/${ws}/social/accounts/${main!.id}/established`, owner.cookie, { method: "POST" });
  expect((await s.social.accounts(ws))[0]!.establishable).toBe(false);
});

test("an account posts on its network's pace until a manager sets its own, and each change is recorded", async () => {
  const s = setup({ networks: [{ ...info, pace: { from: 8 * 60, until: 21 * 60, weekends: true, gapMinutes: 60 } }, unbuilt] });
  const { ws, owner } = await s.workspace();
  const c = await s.connect(ws, owner.userId);
  await s.call(`/api/w/${ws}/social/credentials/${c.id}/targets`, owner.cookie, { method: "POST", body: { ids: ["p1"] } });
  const id = ((await q(ws, "select id from social_accounts")) as { id: string }[])[0]!.id;
  const path = `/api/w/${ws}/social/accounts/${id}/pace`;
  const read = async (cookie: string) => body<{ own: unknown; defaults: unknown; pace: unknown; timeZone: string }>(await s.call(path, cookie));
  const put = (cookie: string, b: unknown) => s.call(path, cookie, { method: "PUT", body: b });
  const none = { postingFrom: null, postingUntil: null, postingWeekends: null, gapMinutes: null };
  const network = { from: 480, until: 1260, weekends: true, gapMinutes: 60 };
  expect(await read(owner.cookie)).toEqual({ own: none, defaults: network, pace: network, timeZone: "UTC" });

  const weekdays = { postingFrom: 540, postingUntil: 1020, postingWeekends: false, gapMinutes: null };
  expect((await put(owner.cookie, weekdays)).status).toBe(200);
  expect(await read(owner.cookie)).toMatchObject({ own: weekdays, pace: { from: 540, until: 1020, weekends: false, gapMinutes: 60 } });
  // Hours come as a pair inside one day.
  expect((await put(owner.cookie, { ...none, postingFrom: 600 })).status).toBe(400);
  expect((await put(owner.cookie, { ...weekdays, postingFrom: 1100 })).status).toBe(400);

  const marketer = await s.signIn();
  await q(ws, "insert into workspace_members (workspace_id, user_id, role, created_at) values ($1, $2, 'marketer', now())", [ws, marketer.userId]);
  expect((await read(marketer.cookie)).pace).toEqual({ from: 540, until: 1020, weekends: false, gapMinutes: 60 });
  expect((await put(marketer.cookie, none)).status).toBe(403);

  expect(await q(ws, "select before, after, changed_by from social_pace_changes")).toEqual([{ before: none, after: weekdays, changed_by: owner.userId }]);
});
