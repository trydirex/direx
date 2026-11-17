// SPDX-License-Identifier: AGPL-3.0-only
// Test support: the seo module over the real Search Console plugin and its fake API, run through
// the plugin host, with credentials connected through a fake Google over HTTP and stored in the vault.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createFakeSearchConsole, createSearchConsolePlugin, firstPartyPlugins, GOOGLE_SEARCH_CONSOLE_PROVIDER, SEARCH_CONSOLE_SCOPES } from "@direx/extensions";
import { afterAll } from "vitest";
import { createVault, rootKeyFromEnv } from "../../credentials/index";
import { startFakeProvider } from "../../credentials/fake-provider";
import { loadPlugins, searchProviders } from "../../plugins/index";
import { createBriefs, createSeo, seoRoutes, type StartBrief } from "../index";
import { TEST_SECRET, testIdentity } from "./support";

export function seoWorld() {
  process.env.DIREX_AUTH_SECRET = TEST_SECRET;
  const clock = { at: new Date("2026-11-06T12:00:00Z") };
  const waits: number[] = [];
  const sc = createFakeSearchConsole({
    sites: [
      { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
      { siteUrl: "https://full.example/", permissionLevel: "siteFullUser" },
      { siteUrl: "https://restricted.example/", permissionLevel: "siteRestrictedUser" },
      { siteUrl: "https://unverified.example/", permissionLevel: "siteUnverifiedUser" },
    ],
  });
  const plugins = loadPlugins({
    sources: [{ mode: "in_process", plugin: createSearchConsolePlugin({ fetch: sc.fetch, now: () => clock.at.getTime() }) }],
    credentials: async () => ({ accessToken: sc.token, expiresAt: "2099-01-01T00:00:00.000Z" }),
    confinement: "none",
    log: () => {},
  });

  const google = startFakeProvider();
  google.grant = [...SEARCH_CONSOLE_SCOPES, "openid", "https://www.googleapis.com/auth/userinfo.email"];
  const { connection, scopes, requiredScopes, extraParams } = GOOGLE_SEARCH_CONSOLE_PROVIDER;
  const vault = createVault({
    rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!,
    now: () => new Date(),
    providers: [{ ...google.provider(), connection, scopes: [...scopes], requiredScopes: [...requiredScopes], extraParams }],
    callbackUrl: "http://direx.test/api/connections/callback",
    timeoutMs: 1000,
  });
  afterAll(() => google.stop());

  const deployment = { selfHost: true };
  const provider = searchProviders(firstPartyPlugins().map((p) => p.manifest))[0];
  const seo = createSeo({
    credentials: (ws) => vault.list(ws),
    setMeta: (ws, id, name, value) => vault.setMeta(ws, id, name, value),
    markNeedsReauth: (ws, id) => vault.markNeedsReauth(ws, id),
    provider: () => provider,
    query: (ws, capability, input, credentialId) => plugins.query(ws, capability, input, credentialId),
    selfHost: () => deployment.selfHost,
    now: () => clock.at,
    // No real waiting: the clock moves on by the wait.
    sleep: async (ms) => {
      waits.push(ms);
      clock.at = new Date(clock.at.getTime() + ms);
    },
  });

  const { routes, signIn, createOrg, call } = testIdentity();
  // Briefs read a fixed page and record each start instead of running the agent.
  const started: Parameters<StartBrief>[1][] = [];
  const briefs = createBriefs({
    seo: () => seo,
    readPage: async (url) => ({ ok: true, url, finalUrl: url, title: "A title", metaDescription: null, html: "", text: "Page text", truncated: false, readAt: clock.at }),
    start: () => async (_ws, a) => {
      started.push(a);
      return { ok: true, run: { id: crypto.randomUUID() } };
    },
    workspaces: async () => [],
    now: () => clock.at,
  });
  (routes as unknown as OpenAPIHono).route("/", seoRoutes({ seo: () => seo, briefs: () => briefs }));

  /** A new Workspace and its Owner's session. */
  async function workspace() {
    const cookie = await signIn();
    const W = (await createOrg(cookie, "Search")).workspace.id;
    const userId = ((await (await call("/api/me", cookie)).json()) as { user: { id: string } }).user.id;
    return { W, cookie, userId };
  }

  /** Connects Search Console for the Workspace through the OAuth flow; returns the credential id. */
  async function connect(W: string, userId: string) {
    const started = await vault.start({ workspaceId: W, userId, connection });
    if (!started.ok) throw new Error(started.reason);
    const back = new URL((await fetch(started.url, { redirect: "manual" })).headers.get("location")!);
    const r = await vault.callback({ cookie: started.cookie, state: back.searchParams.get("state")!, code: back.searchParams.get("code")!, sessionUserId: userId });
    if (!r.ok) throw new Error(r.reason);
    return r.credential.id;
  }

  return { clock, waits, sc, vault, seo, briefs, started, deployment, call, workspace, connect };
}
