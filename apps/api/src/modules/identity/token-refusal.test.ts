// SPDX-License-Identifier: AGPL-3.0-only
// No Workspace route takes an External token (ADR 0032 rule 002): a request with an Authorization
// header is refused before its session is read, with or without a valid session cookie. Every other
// route outside the door refuses `Bearer dxt_`, and only that, while the door's own routes take only a
// token. Routes are read from the app, so a new one is covered without a new case here.
import { expect, test } from "vitest";
import { app } from "../../main";
import { createTokens, DOOR_BASE } from "../door/index";
import { TEST_SECRET, testIdentity } from "./test-auth";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
process.env.DIREX_MASTER_KEY = "11".repeat(32);
const { signIn, createOrg } = testIdentity();

const cookie = await signIn();
const w = (await createOrg(cookie, "Tokens")).workspace.id;
const me = ((await (await app.request("/api/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id;
const made = await createTokens({ maxDays: null }).create(w, { name: "Script", days: 7, readers: ["read_changes", "read_campaign"], kinds: ["fact_proposal"] }, me);
if (!made.ok) throw new Error(made.reason);
const bearer = `Bearer ${made.token}`;

const workspaceRoutes = [...new Set(app.routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/api/w/:workspaceId")).map((r) => `${r.method} ${r.path}`))];
const pathFor = (p: string) => p.replace(":workspaceId", w).replace(/:[A-Za-z]+/g, () => crypto.randomUUID());

test("there are Workspace routes to walk", () => {
  expect(workspaceRoutes.length).toBeGreaterThan(50);
});

test("every Workspace route refuses a token, alone or beside a valid session", async () => {
  for (const key of workspaceRoutes) {
    const [method, path] = key.split(" ") as [string, string];
    for (const headers of [{ authorization: bearer }, { authorization: bearer, cookie }] as Record<string, string>[]) {
      const res = await app.request(pathFor(path), { method, headers });
      expect([res.status, await res.json()], `${key} ${headers.cookie ? "with" : "without"} a session`).toEqual([401, { error: "token_not_accepted" }]);
    }
  }
});

test("any Authorization header is refused on a Workspace route, and the session alone still works", async () => {
  const res = await app.request(`/api/w/${w}/members`, { headers: { authorization: "Basic dXNlcjpwYXNz", cookie } });
  expect([res.status, await res.json()]).toEqual([401, { error: "token_not_accepted" }]);
  expect((await app.request(`/api/w/${w}/members`, { headers: { cookie } })).status).toBe(200);
});

const inDoor = (path: string) => path.startsWith(`${DOOR_BASE}/`);
const otherRoutes = [...new Set(app.routes.filter((r) => r.method !== "ALL" && !r.path.startsWith("/api/w/:workspaceId") && !inDoor(r.path)).map((r) => `${r.method} ${r.path}`))];
const doorRoutes = [...new Set(app.routes.filter((r) => r.method === "POST" && inDoor(r.path)).map((r) => r.path))];

test("every route outside the Workspace tree refuses a token too, public and signed-in alike", async () => {
  expect(otherRoutes).toEqual(expect.arrayContaining(["GET /health", "GET /api/me", "POST /api/orgs", "GET /api/server/status", "POST /api/hooks/plugins/:workspaceId/:hookId", "GET /api/unsubscribe/:workspaceId/:token"]));
  for (const key of otherRoutes) {
    const [method, path] = key.split(" ") as [string, string];
    for (const headers of [{ authorization: bearer }, { authorization: bearer, cookie }] as Record<string, string>[]) {
      const res = await app.request(pathFor(path).replace("*", "session"), { method, headers });
      expect([res.status, await res.json()], `${key} ${headers.cookie ? "with" : "without"} a session`).toEqual([401, { error: "token_not_accepted" }]);
    }
  }
});

test("the scheme's case doesn't matter, and the door's own tree is left to the door", async () => {
  const lower = await app.request("/api/me", { headers: { authorization: `bearer ${made.token}`, cookie } });
  expect([lower.status, await lower.json()]).toEqual([401, { error: "token_not_accepted" }]);
  const door = await app.request(`${DOOR_BASE}/w/${w}/read_campaign`, { method: "POST", headers: { authorization: bearer, "content-type": "application/json" }, body: "{}" });
  expect(door.status).toBe(200);
});

test("the door is mounted, and every one of its routes refuses a request without a token, a session alone included", async () => {
  expect(doorRoutes.sort()).toEqual(["draft", "fact_proposal", "mcp", "read_campaign", "read_changes", "read_needs_you", "read_schedule"].map((r) => `${DOOR_BASE}/w/:workspaceId/${r}`));
  for (const path of doorRoutes) {
    for (const headers of [{}, { cookie }] as Record<string, string>[]) {
      const res = await app.request(pathFor(path), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
      expect([res.status, await res.json()], `${path} ${headers.cookie ? "with" : "without"} a session`).toEqual([401, { error: "token_required" }]);
    }
  }
});

test("the door's document lists its readers and MCP, and the web app's document lists none of them", async () => {
  const paths = async (url: string) => Object.keys(((await (await app.request(url)).json()) as { paths: Record<string, unknown> }).paths);
  expect((await paths(`${DOOR_BASE}/openapi.json`)).sort()).toEqual(["draft", "fact_proposal", "mcp", "read_campaign", "read_changes", "read_needs_you", "read_schedule"].map((r) => `${DOOR_BASE}/w/{workspaceId}/${r}`));
  expect((await paths("/openapi.json")).filter(inDoor)).toEqual([]);
});

test("a webhook answers a provider's own Authorization header as it would with none", async () => {
  const path = `/api/hooks/plugins/${w}/${crypto.randomUUID()}`;
  const send = (headers: Record<string, string>) => app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  const plain = await send({});
  const withProvider = await send({ authorization: "Bearer provider-signing-secret" });
  const answer = [plain.status, await plain.text()];
  expect([withProvider.status, await withProvider.text()]).toEqual(answer);
  // The webhook's own refusal of an unknown hook, not the token check's.
  expect(answer[1]).not.toContain("token_not_accepted");
});
