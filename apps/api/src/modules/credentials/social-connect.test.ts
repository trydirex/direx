// SPDX-License-Identifier: AGPL-3.0-only
// Connecting a provider that isn't shaped like Google: no id_token, no refresh token, a long-token
// exchange, tokens that renew themselves, grants that end early, and an app per Workspace.
import { afterAll, expect, test } from "vitest";
import { masterRootKey } from "./adapters/crypto";
import type { AppProvider } from "./adapters/provider";
import { resolverOf, createVault } from "./application/secrets";
import type { Identity } from "./application/connect";
import { vaultDb } from "./test-helpers";

const { q, newWorkspace, close } = vaultDb();

type Calls = { path: string; query: URLSearchParams; form: URLSearchParams }[];
const calls: Calls = [];
let code: () => Response = () => Response.json({ access_token: "short" });
let long: () => Response = () => Response.json({ access_token: "long", expires_in: 5_184_000 });
let renew: () => Response = () => Response.json({ access_token: "renewed", expires_in: 5_184_000 });
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    calls.push({ path: url.pathname, query: url.searchParams, form: new URLSearchParams(await req.text()) });
    if (url.pathname === "/token") return code();
    if (url.pathname === "/long") return long();
    if (url.pathname === "/renew") return renew();
    return new Response(null, { status: 200 });
  },
});
afterAll(() => {
  server.stop(true);
  return close();
});
const base = `http://localhost:${server.port}`;

const net = (over: Partial<AppProvider> = {}): AppProvider => ({
  connection: "net",
  authorizeUrl: `${base}/authorize`,
  tokenUrl: `${base}/token`,
  revokeUrl: `${base}/{accountId}/revoke`,
  revokeMethod: "DELETE",
  issuers: [],
  scopes: ["a", "b"],
  requiredScopes: ["a"],
  extraParams: {},
  pkce: false,
  scopeSeparator: ",",
  scopeSource: "identity",
  longToken: { url: `${base}/long`, grantType: "swap", tokenParam: "access_token" },
  renewal: { kind: "self_renew", url: `${base}/renew`, grantType: "again" },
  ...over,
});

function setup(o: { provider?: AppProvider; identity?: Partial<Identity> | null; system?: boolean } = {}) {
  const clock = { t: Date.now() };
  const vault = createVault({
    rootKey: masterRootKey(Buffer.alloc(32, 9)),
    now: () => new Date(clock.t),
    appProviders: [o.provider ?? net()],
    systemApp: async () => (o.system === false ? null : { clientId: "direx-app", clientSecret: "direx-secret" }),
    identify: async () => {
      if (o.identity === null) throw new Error("no such account");
      return { accountId: "acct-1", accountLabel: "Ana's page", scopes: ["a", "b"], ...o.identity };
    },
    callbackUrl: "http://direx.test/api/connections/callback",
    timeoutMs: 300,
  });
  return { clock, vault, resolve: resolverOf(vault) };
}
type Setup = ReturnType<typeof setup>;

async function connect(s: Setup, ws: string, user: string) {
  const started = await s.vault.start({ workspaceId: ws, userId: user, connection: "net" });
  if (!started.ok) throw new Error(started.reason);
  const url = new URL(started.url);
  return { url, r: await s.vault.callback({ cookie: started.cookie, sessionUserId: user, state: url.searchParams.get("state")!, code: "c" }) };
}
async function connected(s: Setup, ws: string, user: string) {
  const { r } = await connect(s, ws, user);
  if (!r.ok) throw new Error(r.reason);
  return r.credential;
}
const DAY = 24 * 60 * 60_000;

test("no id_token and no refresh token: stored under the network's account id, with the long token", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const { url, r } = await connect(s, ws, owner);
  if (!r.ok) throw new Error(r.reason);
  expect(url.searchParams.get("scope")).toBe("a,b");
  expect(url.searchParams.get("code_challenge")).toBeNull();
  expect(r.credential).toMatchObject({ key: "net:acct-1", name: "Ana's page", connection: "net", status: "active" });
  expect(r.credential.meta).toEqual({ accountId: "acct-1", accountLabel: "Ana's page", scopes: ["a", "b"] });
  expect(JSON.stringify(r.credential)).not.toMatch(/short|long"|direx-secret/);
  const used = await s.resolve(ws, r.credential.id, "query");
  expect(used?.value).toMatchObject({ accessToken: "long" });
});

test("scopes the short token listed survive its swap for a long one, even wrapped in data", async () => {
  code = () => Response.json({ data: [{ access_token: "short", user_id: "9", permissions: ["a"] }] });
  const s = setup({ provider: net({ scopeSource: undefined, scopeField: "permissions" }) });
  const { ws, owner } = await newWorkspace();
  const c = await connected(s, ws, owner);
  expect(c.meta).toMatchObject({ scopes: ["a"] });
  code = () => Response.json({ access_token: "short" });
});

test("a provider that may not list scopes counts what it asked for, and only when it lists none", async () => {
  const s = setup({ provider: net({ scopeSource: "token_or_asked" }) });
  const { ws, owner } = await newWorkspace();
  expect((await connected(s, ws, owner)).meta).toMatchObject({ scopes: ["a", "b"] });
  code = () => Response.json({ access_token: "short", scope: "b" });
  const narrow = await newWorkspace();
  expect((await connect(setup({ provider: net({ scopeSource: "token_or_asked", scopeSeparator: " " }) }), narrow.ws, narrow.owner)).r).toEqual({ ok: false, reason: "missing_scope" });
  code = () => Response.json({ access_token: "short" });
});

test("reconnecting the same account keeps the credential", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const first = await connected(s, ws, owner);
  const again = await connected(s, ws, owner);
  expect(again.id).toBe(first.id);
  expect(await q(ws, "select 1 from credentials where deleted_at is null")).toHaveLength(1);
});

test("a failed identity call or a missing scope stores nothing and revokes where it can", async () => {
  const { ws, owner } = await newWorkspace();
  calls.length = 0;
  expect((await connect(setup({ identity: null }), ws, owner)).r).toEqual({ ok: false, reason: "identity_failed" });
  // The account is unknown, so a per-account revoke can't be called.
  expect(calls.some((c) => c.path.endsWith("/revoke"))).toBe(false);
  calls.length = 0;
  expect((await connect(setup({ identity: { scopes: ["b"] } }), ws, owner)).r).toEqual({ ok: false, reason: "missing_scope" });
  expect(calls.some((c) => c.path === "/acct-1/revoke" && c.query.get("access_token") === "long")).toBe(true);
  expect(await q(ws, "select 1 from credentials where deleted_at is null")).toHaveLength(0);
});

test("a failed long-token exchange stores nothing", async () => {
  long = () => Response.json({ error: "nope" }, { status: 400 });
  const { ws, owner } = await newWorkspace();
  expect((await connect(setup(), ws, owner)).r).toEqual({ ok: false, reason: "exchange_failed" });
  long = () => Response.json({ access_token: "long", expires_in: 5_184_000 });
});

test("a self-renewing token renews 7 days before expiry, using only itself", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const c = await connected(s, ws, owner);
  calls.length = 0;
  s.clock.t += 40 * DAY;
  expect((await s.resolve(ws, c.id, "query"))?.value).toMatchObject({ accessToken: "long" });
  expect(calls).toHaveLength(0);
  s.clock.t += 14 * DAY;
  expect((await s.resolve(ws, c.id, "query"))?.value).toMatchObject({ accessToken: "renewed" });
  expect(calls[0]!.query.get("access_token")).toBe("long");
  expect(calls[0]!.query.get("client_secret")).toBeNull();
});

test("a failed early renewal keeps working until the token really expires, then asks to reconnect", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const c = await connected(s, ws, owner);
  renew = () => Response.json({ error: "try later" }, { status: 500 });
  s.clock.t += 55 * DAY;
  expect((await s.resolve(ws, c.id, "query"))?.value).toMatchObject({ accessToken: "long" });
  s.clock.t += 6 * DAY;
  expect(await s.resolve(ws, c.id, "query")).toBeNull();
  expect((await s.vault.find(ws, c.id))?.status).toBe("needs_reauth");
  renew = () => Response.json({ access_token: "renewed", expires_in: 5_184_000 });
});

test("a token nothing can renew works until it expires, with no call, then asks to reconnect", async () => {
  const s = setup({ provider: net({ renewal: { kind: "reconnect" } }) });
  const { ws, owner } = await newWorkspace();
  const c = await connected(s, ws, owner);
  calls.length = 0;
  s.clock.t += 59.999 * DAY;
  expect((await s.resolve(ws, c.id, "query"))?.value).toMatchObject({ accessToken: "long" });
  s.clock.t += DAY;
  expect(await s.resolve(ws, c.id, "query")).toBeNull();
  expect((await s.vault.find(ws, c.id))?.status).toBe("needs_reauth");
  expect(calls).toHaveLength(0);
});

test("a provider that expects a refresh token refuses a connect without one", async () => {
  const { ws, owner } = await newWorkspace();
  const s = setup({ provider: net({ renewal: undefined }) });
  expect((await connect(s, ws, owner)).r).toEqual({ ok: false, reason: "no_refresh_token" });
});

test("the stored expiry is the earlier of token and grant, and survives a renewal", async () => {
  const s = setup({ identity: { grantExpiresAt: new Date(Date.now() + 30 * DAY).toISOString() } });
  const { ws, owner } = await newWorkspace();
  const c = await connected(s, ws, owner);
  expect(c.expiresAt!.getTime()).toBeLessThan(Date.now() + 31 * DAY);
  s.clock.t += 54 * DAY;
  await s.resolve(ws, c.id, "query");
  const after = await s.vault.find(ws, c.id);
  expect(after?.expiresAt!.getTime()).toBeLessThan(Date.now() + 31 * DAY);
});

test("a Workspace's own app is used over Direx's, and only in that Workspace", async () => {
  const s = setup();
  const a = await newWorkspace();
  const b = await newWorkspace();
  const saved = await s.vault.create({ workspaceId: a.ws, actorUserId: a.owner, scope: "workspace", kind: "basic", key: "oauth_app:net", name: "Our app", meta: { username: "own-app" }, value: { password: "own-secret" } });
  expect(saved.ok).toBe(true);
  expect(JSON.stringify(saved)).not.toContain("own-secret");
  const clientOf = async (w: { ws: string; owner: string }) => {
    const r = await s.vault.start({ workspaceId: w.ws, userId: w.owner, connection: "net" });
    if (!r.ok) throw new Error(r.reason);
    return new URL(r.url).searchParams.get("client_id");
  };
  expect(await clientOf(a)).toBe("own-app");
  expect(await clientOf(b)).toBe("direx-app");
});

test("another person's own secret with that key is not an app", async () => {
  const s = setup({ system: false });
  const { ws, owner } = await newWorkspace();
  await s.vault.create({ workspaceId: ws, actorUserId: owner, scope: "user", kind: "basic", key: "oauth_app:net", name: "x", meta: { username: "mine" }, value: { password: "p" } });
  expect(await s.vault.start({ workspaceId: ws, userId: owner, connection: "net" })).toEqual({ ok: false, reason: "unknown_connection" });
});

test("with no app at all the connection is unknown", async () => {
  const s = setup({ system: false });
  const { ws, owner } = await newWorkspace();
  expect(await s.vault.start({ workspaceId: ws, userId: owner, connection: "net" })).toEqual({ ok: false, reason: "unknown_connection" });
});

test("disconnecting uses the account id to revoke", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const c = await connected(s, ws, owner);
  calls.length = 0;
  await s.vault.remove({ workspaceId: ws, id: c.id, actorUserId: owner, stepUp: true });
  expect(calls.some((x) => x.path === "/acct-1/revoke")).toBe(true);
});
