// SPDX-License-Identifier: AGPL-3.0-only
// Connecting a mailbox against a fake provider over HTTP: V11 to V16, V22 through the plugin
// seam, and the whole round trip through the ledger.
import { GOOGLE_SEARCH_CONSOLE_PROVIDER, SEARCH_CONSOLE_SCOPES } from "@direx/extensions";
import { accessToken, definePlugin } from "@direx/plugin-sdk";
import { afterAll, expect, test } from "vitest";
import { createBoss } from "../../jobs/boss";
import { approverIdFromSession, createLedger, oneKey } from "../ledger/index";
import { loadPlugins, type TriggerEvent } from "../plugins/index";
import { masterRootKey } from "./adapters/crypto";
import { credentialLabel, credentialReady } from "./application/check";
import { vaultFromEnv } from "./index";
import { createVault, resolverOf } from "./application/secrets";
import { startFakeProvider } from "./fake-provider";
import { vaultDb } from "./test-helpers";

const { q, newUser, addMember, newWorkspace, events, close } = vaultDb();
const fakes: { stop: () => void }[] = [];
afterAll(() => {
  for (const f of fakes) f.stop();
  return close();
});

function setup(opts: Parameters<typeof startFakeProvider>[0] = {}) {
  const fake = startFakeProvider(opts);
  fakes.push(fake);
  const clock = { t: Date.now() };
  const vault = createVault({
    rootKey: masterRootKey(Buffer.alloc(32, 9)),
    now: () => new Date(clock.t),
    providers: [fake.provider()],
    callbackUrl: "http://direx.test/api/connections/callback",
    timeoutMs: 300,
  });
  return { fake, clock, vault, resolve: resolverOf(vault) };
}

type Setup = ReturnType<typeof setup>;

/** Start, follow the provider's redirect, and hand back what the callback would receive. */
async function consent(s: Setup, ws: string, userId: string) {
  const started = await s.vault.start({ workspaceId: ws, userId, connection: "google" });
  if (!started.ok) throw new Error(started.reason);
  const res = await fetch(started.url, { redirect: "manual" });
  const back = new URL(res.headers.get("location")!);
  return { cookie: started.cookie, state: back.searchParams.get("state")!, code: back.searchParams.get("code")!, url: started.url };
}

async function connect(s: Setup, ws: string, userId: string) {
  const c = await consent(s, ws, userId);
  const r = await s.vault.callback({ ...c, sessionUserId: userId });
  if (!r.ok) throw new Error(r.reason);
  return r.credential;
}

test("V11: start then callback stores one active mailbox; a reconnect keeps its id", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const c = await consent(s, ws, owner);
  const url = new URL(c.url);
  expect(url.searchParams.get("scope")).toBe("https://mail.example/send openid email");
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
  const r = await s.vault.callback({ ...c, sessionUserId: owner });
  if (!r.ok) throw new Error(r.reason);
  expect(r.credential).toMatchObject({ kind: "oauth2", scope: "user", status: "active", connection: "google", ownerUserId: owner });
  expect(r.credential.meta).toEqual({ accountEmail: "ana@example.com", scopes: s.fake.grant });
  expect(JSON.stringify(r.credential)).not.toMatch(/rt-|at-/);
  const again = await connect(s, ws, owner);
  expect(again.id).toBe(r.credential.id);
  expect(await q(ws, "select 1 from credentials where deleted_at is null")).toHaveLength(1);
  expect((await events(ws, again.id)).map((e) => e.consumer)).toEqual(["connect", "connect"]);
});

test("V12: each bad callback is refused and stores nothing", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const member = await newUser();
  await addMember(ws, member);
  const cases: [string, () => Promise<unknown>][] = [
    ["bad_cookie", async () => s.vault.callback({ ...(await consent(s, ws, owner)), cookie: undefined, sessionUserId: owner })],
    ["bad_cookie", async () => s.vault.callback({ ...(await consent(s, ws, owner)), cookie: "x.y", sessionUserId: owner })],
    ["state_mismatch", async () => s.vault.callback({ ...(await consent(s, ws, owner)), state: "other", sessionUserId: owner })],
    ["wrong_user", async () => s.vault.callback({ ...(await consent(s, ws, owner)), sessionUserId: member })],
    [
      "expired",
      async () => {
        const c = await consent(s, ws, owner);
        s.clock.t += 11 * 60_000;
        return s.vault.callback({ ...c, sessionUserId: owner });
      },
    ],
    [
      "not_member",
      async () => {
        const c = await consent(s, ws, member);
        await q(ws, "delete from workspace_members where user_id = $1", [member]);
        return s.vault.callback({ ...c, sessionUserId: member });
      },
    ],
  ];
  for (const [reason, run] of cases) expect(await run(), reason).toMatchObject({ ok: false, reason });
  expect(s.fake.calls.exchange).toBe(0);

  const narrow = setup({ grant: ["openid"] });
  const r = await narrow.vault.callback({ ...(await consent(narrow, ws, owner)), sessionUserId: owner });
  expect(r).toMatchObject({ ok: false, reason: "missing_scope" });
  expect(narrow.fake.calls.revoked).toHaveLength(1);
  expect(await q(ws, "select 1 from credentials")).toHaveLength(0);
});

test("V13: disconnect revokes at the provider, then nulls the ciphertext", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const cred = await connect(s, ws, owner);
  expect(await s.vault.remove({ workspaceId: ws, id: cred.id, actorUserId: owner })).toEqual({ ok: true });
  expect(s.fake.calls.revoked).toEqual([expect.stringMatching(/^rt-/)]);
  expect(await q(ws, "select ciphertext from credentials where id = $1", [cred.id])).toEqual([{ ciphertext: null }]);
  expect((await events(ws, cred.id)).at(-1)).toEqual({ consumer: "disconnect", outcome: "ok", error_code: null });
});

test("V14: a token with more than five minutes left is returned without calling the provider", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const cred = await connect(s, ws, owner);
  const r = await s.resolve(ws, cred.id, "execute");
  expect(r?.value).toEqual({ accessToken: expect.stringMatching(/^at-/), expiresAt: expect.any(String) });
  expect(r?.value).not.toHaveProperty("refreshToken");
  expect(s.fake.calls.refresh).toBe(0);
});

test("V15: ten concurrent resolves refresh once; a rotated refresh token is kept", async () => {
  const s = setup();
  s.fake.mode = "rotating";
  s.fake.expiresIn = 60;
  const { ws, owner } = await newWorkspace();
  const cred = await connect(s, ws, owner);
  s.fake.expiresIn = 3600;
  const all = await Promise.all(Array.from({ length: 10 }, () => s.resolve(ws, cred.id, "execute")));
  expect(s.fake.calls.refresh).toBe(1);
  const tokens = new Set(all.map((r) => (r?.value as { accessToken: string }).accessToken));
  expect(tokens.size).toBe(1);
  const outcomes = (await events(ws, cred.id)).map((e) => e.outcome).filter((o) => o === "refreshed");
  expect(outcomes).toHaveLength(1);
  // The stored refresh token must be the newest: the old one is dead at the fake.
  s.clock.t += 2 * 3600_000;
  expect(await s.resolve(ws, cred.id, "execute")).not.toBeNull();
  expect(s.fake.calls.refresh).toBe(2);
});

test("V16: invalid_grant sets needs_reauth and returns null; a reconnect makes it active", async () => {
  const s = setup();
  s.fake.expiresIn = 60;
  const { ws, owner } = await newWorkspace();
  const cred = await connect(s, ws, owner);
  s.fake.mode = "invalid_grant";
  expect(await s.resolve(ws, cred.id, "execute")).toBeNull();
  expect(await q(ws, "select status from credentials where id = $1", [cred.id])).toEqual([{ status: "needs_reauth" }]);
  expect((await events(ws, cred.id)).at(-1)).toEqual({ consumer: "execute", outcome: "needs_reauth", error_code: "invalid_grant" });
  expect(await s.resolve(ws, cred.id, "execute")).toBeNull();
  s.fake.mode = "normal";
  s.fake.expiresIn = 3600;
  const again = await connect(s, ws, owner);
  expect(again).toMatchObject({ id: cred.id, status: "active" });
  expect(await s.resolve(ws, cred.id, "execute")).not.toBeNull();
});

test("a provider that hangs on refresh times out: null, an error event, the row unchanged", async () => {
  const s = setup();
  s.fake.expiresIn = 60;
  const { ws, owner } = await newWorkspace();
  const cred = await connect(s, ws, owner);
  s.fake.mode = "hang";
  expect(await s.resolve(ws, cred.id, "poll")).toBeNull();
  expect((await events(ws, cred.id)).at(-1)).toEqual({ consumer: "poll", outcome: "error", error_code: "refresh_failed" });
  expect(await q(ws, "select status, version from credentials where id = $1", [cred.id])).toEqual([{ status: "active", version: "1" }]);
});

// Echoes the token it was handed, so a test can see which mailbox each call used.
const echo = definePlugin({
  manifest: {
    id: "com.example.echo",
    apiVersion: 1,
    version: "0.1.0",
    minHostVersion: "0.1.0",
    trust: "first_party",
    connections: [{ key: "google", auth: "oauth2" }],
    egress: { hosts: ["mail.example"] },
    capabilities: [
      { kind: "effect", name: "echo.send", connection: "google", dedupe: "blind", risk: "low", reachesPerson: false },
      { kind: "trigger", name: "echo.poll", connection: "google", source: "poll", pollIntervalMs: 60_000 },
    ],
  },
  effects: {
    "echo.send": {
      prepare: async (input) => ({ spec: input, preview: "" }),
      execute: async (_spec, ctx) => ({ kind: "sent", providerRef: accessToken(ctx.credential) ?? "none" }),
    },
  },
  triggers: { "echo.poll": { poll: async (_cursor, ctx) => ({ events: [{ eventId: accessToken(ctx.credential) ?? "none", data: {} }], cursor: "1" }) } },
});

test("V22: two mailboxes in one Workspace; each Action and each poll uses its own token", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  s.fake.email = "one@example.com";
  const one = await connect(s, ws, owner);
  s.fake.email = "two@example.com";
  const two = await connect(s, ws, owner);
  const handed: TriggerEvent[] = [];
  const plugins = loadPlugins({
    sources: [{ mode: "in_process", plugin: echo }],
    credentials: s.vault.credentials,
    confinement: "none",
    log: () => {},
    onEvent: async (_tx, e) => void handed.push(e),
  });
  const tokenOf = async (id: string) => (await s.resolve(ws, id, "query"))!.value as { accessToken: string };
  const [t1, t2] = [(await tokenOf(one.id)).accessToken, (await tokenOf(two.id)).accessToken];
  expect(t1).not.toBe(t2);

  for (const [cred, token] of [[one, t1], [two, t2]] as const) {
    const actionId = crypto.randomUUID();
    await q(
      ws,
      `insert into actions (id, workspace_id, idempotency_key, capability, dedupe_class, state, spec, spec_hash, credential_id, created_at, updated_at)
       values ($1, $2, $4, 'com.example.echo/echo.send', 'blind', 'dispatching', '{}', 'h', $3, now(), now())`,
      [actionId, ws, cred.id, actionId],
    );
    const r = await plugins.effects["com.example.echo/echo.send"]!.execute({}, { workspaceId: ws, idempotencyKey: actionId, credentialId: cred.id });
    expect(r).toEqual({ kind: "sent", providerRef: token });
    const [ev] = await q(ws, "select consumer, action_id from credential_access_events where credential_id = $1 and consumer = 'execute'", [cred.id]);
    expect(ev).toEqual({ consumer: "execute", action_id: actionId });
    await plugins.runPoll({ workspaceId: ws, pluginId: "com.example.echo", trigger: "echo.poll", credentialId: cred.id });
  }
  expect(handed.map((e) => e.eventId)).toEqual([t1, t2]);
  await plugins.close({ force: true });
});

test("connect, send through the ledger with the vault's token, disconnect, and the next Action is held", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const mailbox = await connect(s, ws, owner);
  const plugins = loadPlugins({ sources: [{ mode: "in_process", plugin: echo }], credentials: s.vault.credentials, confinement: "none", log: () => {} });
  const boss = createBoss();
  await boss.start();
  try {
    const ledger = createLedger({
      boss,
      signingKeys: oneKey({ id: "test", secret: "t".repeat(32) }),
      effects: plugins.effects,
      checks: [credentialReady],
      resolvers: { credential: credentialLabel },
    });
    await ledger.ensureQueue();
    const SEND = "com.example.echo/echo.send";
    const approved = async () => {
      const { action } = await ledger.createAction(ws, {
        idempotencyKey: crypto.randomUUID(),
        capability: SEND,
        dedupe: "blind",
        spec: {},
        actor: { userId: owner },
        credentialId: mailbox.id,
      });
      await ledger.submitForApproval(ws, action.id, { userId: owner });
      const r = await ledger.approve(ws, action.id, { approverId: approverIdFromSession(owner), draftVersion: 1, snapshot: [] });
      if (!r.ok) throw new Error(r.reason);
      return action.id;
    };

    const first = await approved();
    await ledger.run(ws, first);
    const token = ((await s.resolve(ws, mailbox.id, "query"))!.value as { accessToken: string }).accessToken;
    expect(await ledger.getAction(ws, first)).toMatchObject({ state: "sent", providerRef: token });

    expect(await s.vault.remove({ workspaceId: ws, id: mailbox.id, actorUserId: owner })).toEqual({ ok: true });
    const second = await approved();
    await ledger.run(ws, second);
    expect(await ledger.getAction(ws, second)).toMatchObject({ state: "held", holdReason: "credential_unavailable" });
  } finally {
    await plugins.close({ force: true });
    await boss.stop({ graceful: false, close: true });
  }
});

test("Search Console is its own connection: only its read-only scope, refused without it, and Gmail untouched", async () => {
  const s = setup();
  const gmail = s.fake.provider();
  const { connection, scopes, requiredScopes, extraParams } = GOOGLE_SEARCH_CONSOLE_PROVIDER;
  const vault = createVault({
    rootKey: masterRootKey(Buffer.alloc(32, 9)),
    now: () => new Date(),
    providers: [gmail, { ...gmail, connection, scopes: [...scopes], requiredScopes: [...requiredScopes], extraParams }],
    callbackUrl: "http://direx.test/api/connections/callback",
    timeoutMs: 300,
  });
  const { ws, owner } = await newWorkspace();
  const consentTo = async (to: string) => {
    const started = await vault.start({ workspaceId: ws, userId: owner, connection: to });
    if (!started.ok) throw new Error(started.reason);
    const back = new URL((await fetch(started.url, { redirect: "manual" })).headers.get("location")!);
    return { url: new URL(started.url), callback: { cookie: started.cookie, state: back.searchParams.get("state")!, code: back.searchParams.get("code")!, sessionUserId: owner } };
  };

  const mail = await vault.callback((await consentTo("google")).callback);
  if (!mail.ok) throw new Error(mail.reason);

  s.fake.grant = [...SEARCH_CONSOLE_SCOPES, "openid", "https://www.googleapis.com/auth/userinfo.email"];
  const asked = await consentTo("google_search_console");
  expect(asked.url.searchParams.get("scope")).toBe(`${SEARCH_CONSOLE_SCOPES[0]} openid email`);
  const search = await vault.callback(asked.callback);
  if (!search.ok) throw new Error(search.reason);
  expect(search.credential).toMatchObject({ kind: "oauth2", status: "active", connection: "google_search_console" });
  expect(search.credential.id).not.toBe(mail.credential.id);

  s.fake.grant = ["openid", "https://www.googleapis.com/auth/userinfo.email"];
  expect(await vault.callback((await consentTo("google_search_console")).callback)).toMatchObject({ ok: false, reason: "missing_scope" });

  const rows = await q(ws, "select connection, status, meta from credentials where deleted_at is null order by connection");
  expect(rows).toEqual([
    { connection: "google", status: "active", meta: mail.credential.meta },
    { connection: "google_search_console", status: "active", meta: search.credential.meta },
  ]);
});

test("one plain field is set in a connected account's meta and replaced when set again; secret-looking names and strict kinds are refused", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const cred = await connect(s, ws, owner);
  const first = await s.vault.setMeta(ws, cred.id, "siteUrl", "sc-domain:example.com");
  expect(first).toMatchObject({ ok: true, credential: { meta: { ...(cred.meta as object), siteUrl: "sc-domain:example.com" } } });
  await s.vault.setMeta(ws, cred.id, "siteUrl", "https://other.example/");
  expect((await s.vault.find(ws, cred.id))!.meta).toEqual({ ...(cred.meta as object), siteUrl: "https://other.example/" });

  expect(await s.vault.setMeta(ws, cred.id, "accessToken", "leak")).toMatchObject({ ok: false, reason: "bad_meta" });
  const key = await s.vault.create({ workspaceId: ws, actorUserId: owner, scope: "workspace", kind: "api_key", key: "k", name: "N", meta: {}, value: { key: "sk-1" } });
  if (!key.ok) throw new Error(key.reason);
  expect(await s.vault.setMeta(ws, key.credential.id, "siteUrl", "x")).toMatchObject({ ok: false, reason: "bad_meta" });
  expect(await s.vault.setMeta(ws, crypto.randomUUID(), "siteUrl", "x")).toEqual({ ok: false, reason: "missing" });
  expect((await q(ws, "select meta from credentials where id = $1", [cred.id]))[0].meta.siteUrl).toBe("https://other.example/");
});

test("reconnecting the same account keeps what was saved beside it and refreshes the account's own fields", async () => {
  const s = setup();
  const { connection, scopes, requiredScopes, extraParams } = GOOGLE_SEARCH_CONSOLE_PROVIDER;
  const vault = createVault({
    rootKey: masterRootKey(Buffer.alloc(32, 9)),
    now: () => new Date(),
    providers: [{ ...s.fake.provider(), connection, scopes: [...scopes], requiredScopes: [...requiredScopes], extraParams }],
    callbackUrl: "http://direx.test/api/connections/callback",
    timeoutMs: 300,
  });
  const { ws, owner } = await newWorkspace();
  const reconnect = async () => {
    const started = await vault.start({ workspaceId: ws, userId: owner, connection });
    if (!started.ok) throw new Error(started.reason);
    const back = new URL((await fetch(started.url, { redirect: "manual" })).headers.get("location")!);
    const r = await vault.callback({ cookie: started.cookie, state: back.searchParams.get("state")!, code: back.searchParams.get("code")!, sessionUserId: owner });
    if (!r.ok) throw new Error(r.reason);
    return r.credential;
  };
  s.fake.grant = [...SEARCH_CONSOLE_SCOPES, "openid", "https://www.googleapis.com/auth/userinfo.email"];
  const first = await reconnect();
  expect(await vault.setMeta(ws, first.id, "siteUrl", "sc-domain:example.com")).toMatchObject({ ok: true });

  s.fake.grant = [...SEARCH_CONSOLE_SCOPES, "openid"];
  const again = await reconnect();
  expect(again.id).toBe(first.id);
  expect(again.meta).toEqual({ accountEmail: (first.meta as { accountEmail: string }).accountEmail, scopes: [...SEARCH_CONSOLE_SCOPES, "openid"], siteUrl: "sc-domain:example.com" });
});

test("the vault from env connects the Google apps its composition root passes, with the sign-in pair, and none without one", async () => {
  const a = { workspaceId: crypto.randomUUID(), userId: crypto.randomUUID(), connection: "google_search_console" };
  const google = { clientId: "id-1", clientSecret: "secret-1" };
  // A fixture key, so the test doesn't depend on the machine having one.
  process.env.DIREX_MASTER_KEY = "11".repeat(32);
  const started = await vaultFromEnv({ baseURL: "http://localhost:3000", google }, undefined, { googleApps: [GOOGLE_SEARCH_CONSOLE_PROVIDER] }).start(a);
  expect(started.ok && new URL(started.url).searchParams.get("client_id")).toBe("id-1");
  expect(await vaultFromEnv({ baseURL: "http://localhost:3000" }, undefined, { googleApps: [GOOGLE_SEARCH_CONSOLE_PROVIDER] }).start(a)).toEqual({ ok: false, reason: "unknown_connection" });
});
