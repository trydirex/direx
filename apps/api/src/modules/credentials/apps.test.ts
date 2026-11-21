// SPDX-License-Identifier: AGPL-3.0-only
// Who owns the app a connection uses: the Workspace's own app, then each app source in order.
import { afterAll, expect, test } from "vitest";
import { masterRootKey } from "./adapters/crypto";
import type { AppProvider, Provider } from "./adapters/provider";
import { firstApp, singleAppSource, type AppSource, type OAuthApp } from "./application/apps";
import { createVault } from "./application/secrets";
import { vaultFromEnv } from "./index";
import { vaultDb } from "./test-helpers";

const { q, newWorkspace, close } = vaultDb();

const tokenClients: string[] = [];
let expiresIn = 3600;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    tokenClients.push(new URLSearchParams(await req.text()).get("client_id") ?? "");
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
  issuers: [],
  scopes: ["a"],
  requiredScopes: ["a"],
  extraParams: {},
  pkce: false,
  scopeSource: "identity",
};

const source = (owner: AppSource["owner"], apps: OAuthApp[], calls: string[] = []): AppSource => ({
  owner,
  apps: async ({ workspaceId, connection }) => {
    calls.push(`${workspaceId}:${connection}`);
    return apps;
  },
});
const app = (clientId: string, owner: OAuthApp["owner"] = "platform"): OAuthApp => ({ clientId, clientSecret: `${clientId}-secret`, owner });

test("the first app of the first source with one wins, owned by that source", async () => {
  const ctx = { workspaceId: "w", orgId: "o", connection: "net" };
  expect(await firstApp([], ctx)).toBeNull();
  expect(await firstApp([source("platform", []), source("deployment", [app("new"), app("old")])], ctx)).toEqual(app("new", "deployment"));
  // An app can't claim another owner than the source it came from.
  expect(await firstApp([source("platform", [app("p", "workspace")])], ctx)).toEqual(app("p", "platform"));
});

test("a single-app source holds nothing when its lookup finds nothing", async () => {
  const s = singleAppSource("deployment", async (connection) => (connection === "net" ? { clientId: "d", clientSecret: "d-secret" } : null));
  expect(await s.apps({ workspaceId: "w", orgId: "o", connection: "net" })).toEqual([app("d", "deployment")]);
  expect(await s.apps({ workspaceId: "w", orgId: "o", connection: "other" })).toEqual([]);
});

function setup(appSources: AppSource[], providers: Provider[] = []) {
  return createVault({
    rootKey: masterRootKey(Buffer.alloc(32, 7)),
    now: () => new Date(),
    appProviders: [template],
    appSources,
    providers,
    identify: async () => ({ accountId: "acct-1", accountLabel: "Ana", scopes: ["a"] }),
    callbackUrl: "http://direx.test/api/connections/callback",
    timeoutMs: 500,
  });
}

async function connect(vault: ReturnType<typeof setup>, ws: string, user: string) {
  const started = await vault.start({ workspaceId: ws, userId: user, connection: "net" });
  if (!started.ok) return { clientId: null, reason: started.reason };
  const url = new URL(started.url);
  const r = await vault.callback({ cookie: started.cookie, sessionUserId: user, state: url.searchParams.get("state")!, code: "c" });
  return { clientId: url.searchParams.get("client_id"), reason: r.ok ? null : r.reason };
}

test("a connect uses the sources in order, and the Workspace's own app ahead of all of them", async () => {
  const { ws, owner } = await newWorkspace();
  const calls: string[] = [];
  const platform = { apps: [] as OAuthApp[] };
  const vault = setup([{ owner: "platform", apps: async (ctx) => (calls.push(`${ctx.workspaceId}:${ctx.orgId}:${ctx.connection}`), platform.apps) }, source("deployment", [app("deploy")])]);
  const [{ org_id: orgId }] = await q(ws, "select org_id from workspaces where id = $1", [ws]);

  expect(await vault.appOwner(ws, "net")).toBe("deployment");
  expect(await connect(vault, ws, owner)).toEqual({ clientId: "deploy", reason: null });
  expect(calls.length > 0 && calls.every((c) => c === `${ws}:${orgId}:net`)).toBe(true);

  platform.apps = [app("platform-new"), app("platform-old")];
  expect(await vault.appOwner(ws, "net")).toBe("platform");
  expect(await vault.appSource(ws, "net")).toBe("system");
  tokenClients.length = 0;
  expect(await connect(vault, ws, owner)).toEqual({ clientId: "platform-new", reason: null });
  expect(tokenClients).toEqual(["platform-new"]);

  const own = await vault.create({ workspaceId: ws, actorUserId: owner, scope: "workspace", kind: "basic", key: "oauth_app:net", name: "Our app", meta: { username: "own-id" }, value: { password: "own-secret" } });
  expect(own.ok).toBe(true);
  calls.length = 0;
  expect(await vault.appOwner(ws, "net")).toBe("workspace");
  expect(await vault.appSource(ws, "net")).toBe("own");
  expect(calls).toEqual([]);
  expect(await connect(vault, ws, owner)).toEqual({ clientId: "own-id", reason: null });
});

test("with no source holding an app, the connection is unknown", async () => {
  const { ws, owner } = await newWorkspace();
  for (const vault of [setup([]), setup([source("platform", []), source("deployment", [])])]) {
    expect(await vault.appOwner(ws, "net")).toBeNull();
    expect(await vault.appSource(ws, "net")).toBeNull();
    expect(await connect(vault, ws, owner)).toEqual({ clientId: null, reason: "unknown_connection" });
  }
});

test("a fixed provider uses and reports its deployment app even when a Workspace app exists", async () => {
  const { ws, owner } = await newWorkspace();
  const calls: string[] = [];
  const vault = setup([source("platform", [app("platform")], calls)], [
    { ...template, clientId: "fixed", clientSecret: "fixed-secret" },
  ]);
  const expectFixed = async () => {
    expect(await vault.appOwner(ws, "net")).toBe("deployment");
    expect(await vault.appSource(ws, "net")).toBe("system");
    tokenClients.length = 0;
    expect(await connect(vault, ws, owner)).toEqual({ clientId: "fixed", reason: null });
    expect(tokenClients).toEqual(["fixed"]);
    expect(calls).toEqual([]);
  };

  await expectFixed();
  const own = await vault.create({ workspaceId: ws, actorUserId: owner, scope: "workspace", kind: "basic", key: "oauth_app:net", name: "Our app", meta: { username: "own-id" }, value: { password: "own-secret" } });
  expect(own.ok).toBe(true);
  await expectFixed();
});

test("an installed extension's apps come after the Workspace's own and before the server's and the sign-in pair", async () => {
  process.env.DIREX_MASTER_KEY = "11".repeat(32);
  const { ws, owner } = await newWorkspace();
  const platform = { apps: [{ clientId: "platform-id", clientSecret: "platform-secret" }] };
  const asked: { workspaceId: string; orgId: string; connection: string }[] = [];
  const vault = vaultFromEnv({ baseURL: "http://direx.test", google: { clientId: "signin-id", clientSecret: "signin-secret" } }, undefined, {
    googleAppProviders: [template],
    identify: async () => ({ accountId: "acct-1", accountLabel: "Ana", scopes: ["a"] }),
    platformApps: async (ctx) => (asked.push(ctx), platform.apps),
  });
  expect(await vault.appOwner(ws, "net")).toBe("platform");
  expect(asked.at(-1)).toMatchObject({ workspaceId: ws, connection: "net" });
  expect(asked.at(-1)?.orgId).toMatch(/^[0-9a-f-]{36}$/);
  // A token that is due at once, so the next use refreshes it.
  expiresIn = 1;
  const r = await connect(vault as ReturnType<typeof setup>, ws, owner);
  expiresIn = 3600;
  expect(r).toEqual({ clientId: "platform-id", reason: null });

  // A refresh reads the platform app outside the Workspace transaction and uses it.
  const [credential] = await vault.list(ws);
  tokenClients.length = 0;
  expect(await vault.credentials(ws, credential!.id, { consumer: "query" })).toMatchObject({ accessToken: "token" });
  expect(tokenClients).toEqual(["platform-id"]);

  platform.apps = [];
  expect(await vault.appOwner(ws, "net")).toBe("sign_in");
});
