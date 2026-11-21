// SPDX-License-Identifier: AGPL-3.0-only
// A grant is pinned to the app that issued it: a refresh or revoke uses that app, whatever a new
// connect would pick now, and a grant made before pins were kept resolves as it always did.
import { afterAll, expect, test } from "vitest";
import { masterRootKey } from "./adapters/crypto";
import type { AppProvider } from "./adapters/provider";
import type { AppSource, OAuthApp } from "./application/apps";
import { createVault, resolverOf } from "./application/secrets";
import { vaultDb } from "./test-helpers";

const { q, newWorkspace, close } = vaultDb();

// Each token or revoke call, as "<path> <client id>".
const calls: string[] = [];
let expiresIn = 3600;
let refreshStatus = 200;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const form = new URLSearchParams(await req.text());
    const path = new URL(req.url).pathname;
    calls.push(`${path} ${form.get("client_id")}`);
    if (path === "/token" && form.get("grant_type") === "refresh_token" && refreshStatus !== 200) return Response.json({ error: "invalid_grant" }, { status: refreshStatus });
    return Response.json({ access_token: "token", refresh_token: "refresh", expires_in: expiresIn });
  },
});
afterAll(() => {
  server.stop(true);
  return close();
});
const base = `http://localhost:${server.port}`;

const template: AppProvider = {
  connection: "net",
  authorizeUrl: `${base}/authorize`,
  tokenUrl: `${base}/token`,
  revokeUrl: `${base}/revoke`,
  revokeClient: true,
  issuers: [],
  scopes: ["a"],
  requiredScopes: ["a"],
  extraParams: {},
  pkce: false,
  scopeSource: "identity",
};

const app = (clientId: string): OAuthApp => ({ clientId, clientSecret: `${clientId}-secret`, owner: "platform" });
// Mutable app lists per owner, so a test can rotate or drop an app between calls.
function sources() {
  const held = { platform: [] as OAuthApp[], deployment: [] as OAuthApp[], sign_in: [] as OAuthApp[] };
  const list: AppSource[] = (["platform", "deployment", "sign_in"] as const).map((owner) => ({ owner, apps: async () => held[owner] }));
  return { held, list };
}

function setup(list: AppSource[]) {
  const vault = createVault({
    rootKey: masterRootKey(Buffer.alloc(32, 5)),
    now: () => new Date(),
    appProviders: [template],
    appSources: list,
    identify: async () => ({ accountId: crypto.randomUUID(), accountLabel: "Ana", scopes: ["a"] }),
    callbackUrl: "http://direx.test/api/connections/callback",
    timeoutMs: 500,
  });
  return { vault, resolve: resolverOf(vault) };
}

/** Connects with a token that is due at once, so its next use refreshes it. */
async function connectDue(vault: ReturnType<typeof setup>["vault"], ws: string, user: string) {
  expiresIn = 1;
  const started = await vault.start({ workspaceId: ws, userId: user, connection: "net" });
  if (!started.ok) throw new Error(started.reason);
  const r = await vault.callback({ cookie: started.cookie, sessionUserId: user, state: new URL(started.url).searchParams.get("state")!, code: "c" });
  expiresIn = 3600;
  if (!r.ok) throw new Error(r.reason);
  return r.credential.id;
}

const pinOf = async (ws: string, id: string) => (await q(ws, "select app_owner, app_client_id from credentials where id = $1", [id]))[0];

test("a connect pins the grant to its app, and a refresh keeps using it after another app takes over", async () => {
  const { ws, owner } = await newWorkspace();
  const s = sources();
  s.held.sign_in = [app("signin")];
  const { vault, resolve } = setup(s.list);
  const id = await connectDue(vault, ws, owner);
  expect(await pinOf(ws, id)).toEqual({ app_owner: "sign_in", app_client_id: "signin" });

  // The server's own app is set later: new connects use it, this grant still refreshes with the sign-in app.
  s.held.deployment = [app("server")];
  expect(await vault.appOwner(ws, "net")).toBe("deployment");
  calls.length = 0;
  expect(await resolve(ws, id, "query")).toMatchObject({ value: { accessToken: "token" } });
  expect(calls).toEqual(["/token signin"]);
});

test("a source rotating its app keeps the old grants working while it still lists the old app", async () => {
  const { ws, owner } = await newWorkspace();
  const s = sources();
  s.held.platform = [app("old")];
  const { vault, resolve } = setup(s.list);
  const id = await connectDue(vault, ws, owner);

  s.held.platform = [app("new"), app("old")];
  calls.length = 0;
  await resolve(ws, id, "query");
  expect(calls).toEqual(["/token old"]);
  const next = await connectDue(vault, ws, owner);
  expect(await pinOf(ws, next)).toEqual({ app_owner: "platform", app_client_id: "new" });
});

test("once the issuing app is gone, the grant needs reconnecting, with app_gone, and calls no provider", async () => {
  const { ws, owner } = await newWorkspace();
  const s = sources();
  s.held.platform = [app("old")];
  const { vault, resolve } = setup(s.list);
  const id = await connectDue(vault, ws, owner);

  s.held.platform = [app("new")];
  calls.length = 0;
  expect(await resolve(ws, id, "query")).toBeNull();
  expect(calls).toEqual([]);
  expect((await vault.find(ws, id))?.status).toBe("needs_reauth");
  expect((await vault.events(ws, id))[0]).toMatchObject({ outcome: "needs_reauth", errorCode: "app_gone" });
});

test("a grant pinned to the Workspace's own app refreshes with it, and needs reconnecting when it changes", async () => {
  const { ws, owner } = await newWorkspace();
  const s = sources();
  s.held.deployment = [app("server")];
  const { vault, resolve } = setup(s.list);
  const own = await vault.create({ workspaceId: ws, actorUserId: owner, scope: "workspace", kind: "basic", key: "oauth_app:net", name: "Our app", meta: { username: "own-id" }, value: { password: "own-secret" } });
  if (!own.ok) throw new Error(own.reason);
  const id = await connectDue(vault, ws, owner);
  expect(await pinOf(ws, id)).toEqual({ app_owner: "workspace", app_client_id: "own-id" });
  calls.length = 0;
  await resolve(ws, id, "query");
  expect(calls).toEqual(["/token own-id"]);

  // Removing the Workspace's app marks its grants for reconnecting, as before pins were kept.
  expect((await vault.remove({ workspaceId: ws, id: own.credential.id, actorUserId: owner })).ok).toBe(true);
  expect((await vault.find(ws, id))?.status).toBe("needs_reauth");
});

test("a grant from before pins were kept refreshes through whichever app a new connect would use", async () => {
  const { ws, owner } = await newWorkspace();
  const s = sources();
  s.held.sign_in = [app("signin")];
  const { vault, resolve } = setup(s.list);
  const id = await connectDue(vault, ws, owner);
  await q(ws, "update credentials set app_owner = null, app_client_id = null where id = $1", [id]);

  s.held.deployment = [app("server")];
  calls.length = 0;
  refreshStatus = 400;
  expect(await resolve(ws, id, "query")).toBeNull();
  refreshStatus = 200;
  // Today's trap, kept for older grants: the server's app can't refresh a token the sign-in app issued.
  expect(calls).toEqual(["/token server"]);
  expect((await vault.events(ws, id))[0]).toMatchObject({ outcome: "needs_reauth", errorCode: "invalid_grant" });
});

test("a disconnect revokes with the app that issued the grant", async () => {
  const { ws, owner } = await newWorkspace();
  const s = sources();
  s.held.platform = [app("old")];
  const { vault } = setup(s.list);
  const id = await connectDue(vault, ws, owner);

  s.held.platform = [app("new"), app("old")];
  calls.length = 0;
  expect((await vault.remove({ workspaceId: ws, id, actorUserId: owner })).ok).toBe(true);
  expect(calls).toEqual(["/revoke old"]);
});
