// SPDX-License-Identifier: AGPL-3.0-only
// The token flow options on a provider, over real HTTP, for providers that aren't shaped like
// Google. The defaults are covered by connect.test.ts, which keeps its assertions.
import { afterAll, beforeEach, expect, test } from "vitest";
import { exchangeCode, exchangeLongToken, refreshTokens, renewToken, revokeToken, type Provider } from "./adapters/provider";

type Seen = { method: string; path: string; query: URLSearchParams; form: URLSearchParams; auth: string | null };
let seen: Seen[] = [];
let reply: () => Response = () => Response.json({ access_token: "at", expires_in: 60 });
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    seen.push({ method: req.method, path: url.pathname, query: url.searchParams, form: new URLSearchParams(await req.text()), auth: req.headers.get("authorization") });
    return reply();
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen = [];
  reply = () => Response.json({ access_token: "at", expires_in: 60 });
});

const base = `http://localhost:${server.port}`;
const provider = (over: Partial<Provider> = {}): Provider => ({
  connection: "net",
  authorizeUrl: `${base}/authorize`,
  tokenUrl: `${base}/token`,
  issuers: [],
  scopes: [],
  requiredScopes: [],
  extraParams: {},
  clientId: "id",
  clientSecret: "shh",
  ...over,
});
const code = { code: "c", verifier: "v", redirectUri: "http://direx.test/cb" };

test("by default the pair goes in the form body, with the PKCE verifier", async () => {
  await exchangeCode(provider(), code, 1000);
  const s = seen[0]!;
  expect([s.method, s.auth, s.form.get("client_secret"), s.form.get("code_verifier")]).toEqual(["POST", null, "shh", "v"]);
});

test("basic auth keeps the pair out of the body", async () => {
  await exchangeCode(provider({ tokenAuth: "basic" }), code, 1000);
  const s = seen[0]!;
  expect(s.auth).toBe(`Basic ${Buffer.from("id:shh").toString("base64")}`);
  expect([s.form.get("client_id"), s.form.get("client_secret")]).toEqual([null, null]);
});

test("pkce off sends no verifier", async () => {
  await exchangeCode(provider({ pkce: false }), code, 1000);
  expect(seen[0]!.form.get("code_verifier")).toBeNull();
});

test("a GET code exchange puts everything in the query", async () => {
  await exchangeCode(provider({ codeMethod: "GET" }), code, 1000);
  expect([seen[0]!.method, seen[0]!.query.get("code")]).toEqual(["GET", "c"]);
});

test("a missing expiry fails, unless a long-token exchange follows", async () => {
  reply = () => Response.json({ access_token: "at" });
  expect((await exchangeCode(provider(), code, 1000)).ok).toBe(false);
  const long = provider({ longToken: { url: `${base}/long`, grantType: "x", tokenParam: "access_token" } });
  expect(await exchangeCode(long, code, 1000)).toMatchObject({ ok: true, tokens: { accessToken: "at", expiresIn: undefined } });
});

test("the long-token exchange is a GET and must state an expiry", async () => {
  const p = provider({ longToken: { url: `${base}/long`, grantType: "swap", tokenParam: "short", sendClientId: true } });
  expect(await exchangeLongToken(p, "s", 1000)).toMatchObject({ ok: true, tokens: { expiresIn: 60 } });
  const s = seen[0]!;
  expect([s.method, s.path, s.query.get("grant_type"), s.query.get("short"), s.query.get("client_id"), s.query.get("client_secret")]).toEqual(["GET", "/long", "swap", "s", "id", "shh"]);
  reply = () => Response.json({ access_token: "at" });
  expect((await exchangeLongToken(p, "s", 1000)).ok).toBe(false);
  expect((await exchangeLongToken(provider(), "s", 1000)).ok).toBe(false);
});

test("a self-renewing token sends only itself", async () => {
  const p = provider({ renewal: { kind: "self_renew", url: `${base}/renew`, grantType: "again" } });
  expect((await renewToken(p, "old", 1000)).ok).toBe(true);
  expect(seen[0]!.query.get("access_token")).toBe("old");
  expect(seen[0]!.query.get("client_secret")).toBeNull();
  expect((await renewToken(provider(), "old", 1000)).ok).toBe(false);
});

test("a failure keeps the provider's error code, never its free text", async () => {
  reply = () => Response.json({ error: "invalid_client", error_description: "Client authentication failed" }, { status: 401 });
  expect(await exchangeCode(provider(), code, 1000)).toEqual({ ok: false, error: "failed", code: "invalid_client" });
  reply = () => Response.json({ error: "Call us on 555 to fix this" }, { status: 400 });
  expect(await exchangeCode(provider(), code, 1000)).toEqual({ ok: false, error: "failed", code: undefined });
});

test("a provider's own dead-token error counts as invalid_grant, and only that one", async () => {
  reply = () => Response.json({ error: "invalid_request" }, { status: 400 });
  expect(await refreshTokens(provider(), "r", 1000)).toEqual({ ok: false, error: "failed", code: "invalid_request" });
  expect(await refreshTokens(provider({ deadTokenErrors: ["invalid_request"] }), "r", 1000)).toEqual({ ok: false, error: "invalid_grant", code: "invalid_request" });
});

test("scopes may be a custom field, an array, and tokens may be wrapped in data", async () => {
  reply = () => Response.json({ data: [{ access_token: "at", expires_in: 60, permissions: ["a", "b"] }] });
  expect(await exchangeCode(provider({ scopeField: "permissions", scopeSeparator: "," }), code, 1000)).toMatchObject({ ok: true, tokens: { accessToken: "at", scope: "a,b" } });
});

test("revoke: no endpoint is fine, POST form with basic, DELETE per account", async () => {
  expect(await revokeToken(provider(), "t", 1000)).toBe(true);
  expect(seen).toHaveLength(0);

  await revokeToken(provider({ revokeUrl: `${base}/revoke`, tokenAuth: "basic" }), "t", 1000);
  expect([seen[0]!.method, seen[0]!.form.get("token"), seen[0]!.auth?.startsWith("Basic ")]).toEqual(["POST", "t", true]);

  const del = provider({ revokeUrl: `${base}/{accountId}/permissions`, revokeMethod: "DELETE" });
  await revokeToken(del, "t", 1000, "a/b");
  expect([seen[1]!.method, seen[1]!.path, seen[1]!.query.get("access_token")]).toEqual(["DELETE", "/a%2Fb/permissions", "t"]);
  // An account id the provider needs but wasn't given is a failed revoke, never a call.
  expect(await revokeToken(del, "t", 1000)).toBe(false);
  expect(seen).toHaveLength(2);
});

test("a renamed client id goes under its own name on exchange, refresh and the long-token swap", async () => {
  const p = provider({ clientIdParam: "client_key", longToken: { url: `${base}/long`, grantType: "swap", tokenParam: "access_token", sendClientId: true } });
  await exchangeCode(p, code, 1000);
  await refreshTokens(p, "rt", 1000);
  await exchangeLongToken(p, "short", 1000);
  const named = (s: Seen, k: string) => s.form.get(k) ?? s.query.get(k);
  expect(seen.map((s) => [named(s, "client_key"), named(s, "client_id")])).toEqual([
    ["id", null],
    ["id", null],
    ["id", null],
  ]);
});

test("revoke sends only the token, unless the provider asks for the client pair too", async () => {
  await revokeToken(provider({ revokeUrl: `${base}/revoke` }), "t", 1000);
  await revokeToken(provider({ revokeUrl: `${base}/revoke`, clientIdParam: "client_key", revokeClient: true }), "t", 1000);
  expect([...seen[0]!.form.keys()]).toEqual(["token"]);
  expect(Object.fromEntries(seen[1]!.form)).toEqual({ client_key: "id", client_secret: "shh", token: "t" });
});
