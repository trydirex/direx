// SPDX-License-Identifier: AGPL-3.0-only
// Connecting Notion's public integration through the connect flow, on a fake token endpoint shaped as
// developers.notion.com documents it: JSON bodies, the client pair as Basic auth, a Notion-Version
// header, no expires_in and no scopes, the Notion workspace named in the answer, and a refresh that
// rotates the refresh token.
import { afterAll, expect, test } from "vitest";
import { NOTION_OAUTH_PROVIDER } from "@direx/extensions";
import { masterRootKey } from "./adapters/crypto";
import { resolverOf, createVault } from "./application/secrets";
import { vaultDb } from "./test-helpers";

const { q, newWorkspace, close } = vaultDb();

type Call = { path: string; auth: string | null; version: string | null; type: string | null; body: Record<string, string> };
const calls: Call[] = [];
let n = 0;
const live = new Set<string>();
let workspaceName: string | null = "Ana's Notion";
let refusal: { status: number; body: unknown } | null = null;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    calls.push({ path: url.pathname, auth: req.headers.get("authorization"), version: req.headers.get("notion-version"), type: req.headers.get("content-type"), body });
    if (url.pathname === "/v1/oauth/revoke") return Response.json({ request_id: "r" });
    if (req.headers.get("authorization") !== `Basic ${Buffer.from("notion-client:notion-secret").toString("base64")}`) return Response.json({ error: "invalid_client" }, { status: 401 });
    if (refusal) return Response.json(refusal.body, { status: refusal.status });
    if (body.grant_type === "refresh_token" && !live.delete(body.refresh_token!)) return Response.json({ object: "error", status: 400, code: "invalid_grant", message: "Invalid refresh token." }, { status: 400 });
    const refresh = `nrt-${++n}`;
    live.add(refresh);
    return Response.json({
      access_token: `nat-${++n}`,
      token_type: "bearer",
      refresh_token: refresh,
      bot_id: "b0b0b0b0-0000-4000-8000-000000000001",
      workspace_id: "a1a1a1a1-0000-4000-8000-000000000001",
      workspace_name: workspaceName,
      workspace_icon: null,
      owner: { type: "user", user: { object: "user", id: "u1" } },
      duplicated_template_id: null,
    });
  },
});
afterAll(() => {
  server.stop(true);
  return close();
});
const base = `http://localhost:${server.port}`;
const provider = { ...NOTION_OAUTH_PROVIDER, tokenUrl: `${base}/v1/oauth/token`, revokeUrl: `${base}/v1/oauth/revoke` };

function setup() {
  const clock = { t: Date.now() };
  const vault = createVault({
    rootKey: masterRootKey(Buffer.alloc(32, 7)),
    now: () => new Date(clock.t),
    appProviders: [provider],
    systemApp: async () => ({ clientId: "notion-client", clientSecret: "notion-secret" }),
    callbackUrl: "http://direx.test/api/connections/callback",
    timeoutMs: 300,
  });
  return { clock, vault, resolve: resolverOf(vault) };
}
type Setup = ReturnType<typeof setup>;

async function connect(s: Setup, ws: string, user: string) {
  const started = await s.vault.start({ workspaceId: ws, userId: user, connection: "notion_oauth" });
  if (!started.ok) throw new Error(started.reason);
  const url = new URL(started.url);
  return { url, r: await s.vault.callback({ cookie: started.cookie, sessionUserId: user, state: url.searchParams.get("state")!, code: "the-code" }) };
}

test("the consent URL is Notion's, for a user, with no scope and no PKCE", async () => {
  const { ws, owner } = await newWorkspace();
  const { url } = await connect(setup(), ws, owner);
  expect(`${url.origin}${url.pathname}`).toBe("https://api.notion.com/v1/oauth/authorize");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: "notion-client",
    redirect_uri: "http://direx.test/api/connections/callback",
    response_type: "code",
    owner: "user",
    state: expect.any(String),
  });
});

test("a Workspace's own Notion app is used before the deployment's", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const app = await s.vault.create({ workspaceId: ws, actorUserId: owner, scope: "workspace", kind: "basic", key: "oauth_app:notion_oauth", name: "Notion app", meta: { username: "own-client" }, value: { password: "own-secret" } });
  expect(app.ok).toBe(true);
  const started = await s.vault.start({ workspaceId: ws, userId: owner, connection: "notion_oauth" });
  expect(started.ok && new URL(started.url).searchParams.get("client_id")).toBe("own-client");
});

test("the callback stores one oauth2 credential named for the Notion workspace", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  calls.length = 0;
  const { r } = await connect(s, ws, owner);
  if (!r.ok) throw new Error(r.reason);
  expect(calls[0]).toMatchObject({ path: "/v1/oauth/token", version: "2026-03-11", type: "application/json", body: { grant_type: "authorization_code", code: "the-code", redirect_uri: "http://direx.test/api/connections/callback" } });
  // The client pair goes in the header only.
  expect(JSON.stringify(calls[0]!.body)).not.toMatch(/notion-secret|notion-client/);
  expect(r.credential).toMatchObject({ kind: "oauth2", key: "notion_oauth:a1a1a1a1-0000-4000-8000-000000000001", name: "Ana's Notion", connection: "notion_oauth", status: "active", scope: "user" });
  expect(r.credential.meta).toEqual({ accountId: "a1a1a1a1-0000-4000-8000-000000000001", accountLabel: "Ana's Notion", scopes: ["read_content", "update_content"] });
  // No expires_in, so the token is taken to last an hour.
  expect(r.credential.expiresAt!.getTime()).toBe(s.clock.t + 3600_000);
  expect(JSON.stringify(r.credential)).not.toMatch(/nat-|nrt-/);
  const again = await connect(s, ws, owner);
  expect(again.r.ok && again.r.credential.id).toBe(r.credential.id);
});

test("a Notion workspace with no name is labelled by its id", async () => {
  workspaceName = null;
  const { ws, owner } = await newWorkspace();
  const { r } = await connect(setup(), ws, owner);
  workspaceName = "Ana's Notion";
  expect(r.ok && r.credential.name).toBe("a1a1a1a1-0000-4000-8000-000000000001");
});

test("each refresh stores the rotated refresh token, so the next refresh works", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const { r } = await connect(s, ws, owner);
  if (!r.ok) throw new Error(r.reason);
  const first = (await s.resolve(ws, r.credential.id, "query"))?.value as { accessToken: string };
  calls.length = 0;
  s.clock.t += 3600_000;
  const second = (await s.resolve(ws, r.credential.id, "query"))?.value as { accessToken: string };
  expect(second.accessToken).not.toBe(first.accessToken);
  expect(calls[0]).toMatchObject({ path: "/v1/oauth/token", type: "application/json", body: { grant_type: "refresh_token" } });
  const used = calls[0]!.body.refresh_token!;
  s.clock.t += 3600_000;
  const third = (await s.resolve(ws, r.credential.id, "query"))?.value as { accessToken: string };
  expect(third.accessToken).not.toBe(second.accessToken);
  // The second refresh sent the token the first one returned; the first one's is gone at Notion.
  expect(calls[1]!.body.refresh_token).not.toBe(used);
  expect((await s.vault.find(ws, r.credential.id))?.status).toBe("active");
});

test("a dead refresh token, named in Notion's `code` field, asks for a reconnect", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const { r } = await connect(s, ws, owner);
  if (!r.ok) throw new Error(r.reason);
  live.clear();
  s.clock.t += 3600_000;
  expect(await s.resolve(ws, r.credential.id, "query")).toBeNull();
  expect((await s.vault.find(ws, r.credential.id))?.status).toBe("needs_reauth");
});

test("a refused exchange, a missing workspace or a denial stores nothing", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  refusal = { status: 400, body: { error: "invalid_grant" } };
  expect((await connect(s, ws, owner)).r).toEqual({ ok: false, reason: "exchange_failed", detail: "invalid_grant" });
  refusal = { status: 200, body: { access_token: "nat-x", refresh_token: "nrt-x", token_type: "bearer" } };
  calls.length = 0;
  expect((await connect(s, ws, owner)).r).toEqual({ ok: false, reason: "identity_failed" });
  // The granted token is revoked at Notion, as JSON with Basic auth.
  expect(calls.find((c) => c.path === "/v1/oauth/revoke")).toMatchObject({ type: "application/json", body: { token: "nrt-x" }, auth: expect.stringMatching(/^Basic /) });
  refusal = { status: 200, body: { access_token: "nat-y", token_type: "bearer", workspace_id: "w" } };
  expect((await connect(s, ws, owner)).r).toEqual({ ok: false, reason: "no_refresh_token" });
  refusal = null;
  const started = await s.vault.start({ workspaceId: ws, userId: owner, connection: "notion_oauth" });
  if (!started.ok) throw new Error(started.reason);
  const state = new URL(started.url).searchParams.get("state")!;
  expect(await s.vault.callback({ cookie: started.cookie, sessionUserId: owner, state, error: "access_denied" })).toEqual({ ok: false, reason: "denied" });
  expect(await q(ws, "select 1 from credentials where kind = 'oauth2'")).toHaveLength(0);
});

test("disconnecting revokes the refresh token at Notion", async () => {
  const s = setup();
  const { ws, owner } = await newWorkspace();
  const { r } = await connect(s, ws, owner);
  if (!r.ok) throw new Error(r.reason);
  calls.length = 0;
  expect((await s.vault.remove({ workspaceId: ws, id: r.credential.id, actorUserId: owner })).ok).toBe(true);
  expect(calls[0]).toMatchObject({ path: "/v1/oauth/revoke", version: "2026-03-11", body: { token: expect.stringMatching(/^nrt-/) } });
});
