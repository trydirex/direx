// SPDX-License-Identifier: AGPL-3.0-only
// Who owns the app a connection uses: the Workspace's own app, then each app source in order.
import { afterAll, expect, test } from "vitest";
import { masterRootKey } from "./adapters/crypto";
import type { AppProvider, Provider } from "./adapters/provider";
import { firstApp, singleAppSource, type AppSource, type OAuthApp } from "./application/apps";
import { createVault } from "./application/secrets";
import { vaultDb } from "./test-helpers";

const { newWorkspace, close } = vaultDb();

const tokenClients: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    tokenClients.push(new URLSearchParams(await req.text()).get("client_id") ?? "");
    return Response.json({ access_token: "token", refresh_token: "refresh", expires_in: 3600 });
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
  const ctx = { workspaceId: "w", connection: "net" };
  expect(await firstApp([], ctx)).toBeNull();
  expect(await firstApp([source("platform", []), source("deployment", [app("new"), app("old")])], ctx)).toEqual(app("new", "deployment"));
  // An app can't claim another owner than the source it came from.
  expect(await firstApp([source("platform", [app("p", "workspace")])], ctx)).toEqual(app("p", "platform"));
});

test("a single-app source holds nothing when its lookup finds nothing", async () => {
  const s = singleAppSource("deployment", async (connection) => (connection === "net" ? { clientId: "d", clientSecret: "d-secret" } : null));
  expect(await s.apps({ workspaceId: "w", connection: "net" })).toEqual([app("d", "deployment")]);
  expect(await s.apps({ workspaceId: "w", connection: "other" })).toEqual([]);
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
  const vault = setup([{ owner: "platform", apps: async (ctx) => (calls.push(`${ctx.workspaceId}:${ctx.connection}`), platform.apps) }, source("deployment", [app("deploy")])]);

  expect(await vault.appOwner(ws, "net")).toBe("deployment");
  expect(await connect(vault, ws, owner)).toEqual({ clientId: "deploy", reason: null });
  expect(calls.every((c) => c === `${ws}:net`)).toBe(true);

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
