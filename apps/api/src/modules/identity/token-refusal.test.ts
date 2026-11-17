// SPDX-License-Identifier: AGPL-3.0-only
// No Workspace route takes an External token (ADR 0032 rule 002): a request with an Authorization
// header is refused before its session is read, with or without a valid session cookie. Routes are
// read from the app, so a new one is covered without a new case here.
import { expect, test } from "vitest";
import { app } from "../../main";
import { createTokens } from "../door/index";
import { TEST_SECRET, testIdentity } from "./test-auth";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
process.env.DIREX_MASTER_KEY = "11".repeat(32);
const { signIn, createOrg } = testIdentity();

const cookie = await signIn();
const w = (await createOrg(cookie, "Tokens")).workspace.id;
const me = ((await (await app.request("/api/me", { headers: { cookie } })).json()) as { user: { id: string } }).user.id;
const made = await createTokens({ maxDays: null }).create(w, { name: "Script", days: 7, readers: ["read_changes"], kinds: ["fact_proposal"] }, me);
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
