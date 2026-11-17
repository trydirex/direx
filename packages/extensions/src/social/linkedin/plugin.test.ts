// SPDX-License-Identifier: AGPL-3.0-only
// The LinkedIn plugins against a local server. Responses are written from LinkedIn's docs and get
// replaced with real ones when a real account connects.
import { invoke } from "../../test-wire";
import { afterAll, beforeEach, expect, test } from "vitest";
import { createLinkedInPagePlugin, createLinkedInPlugin } from "./plugin";

const seen: { path: string; auth: string | null; version: string | null }[] = [];
let answer: (path: string) => Response;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    seen.push({ path: u.pathname + u.search, auth: req.headers.get("authorization"), version: req.headers.get("linkedin-version") });
    return answer(u.pathname);
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen.length = 0;
});
const o = { baseUrl: `http://localhost:${server.port}`, timeoutMs: 1000 };
const credential = { accessToken: "tok", expiresAt: "2030-01-01T00:00:00.000Z" };
const ask = async (p: Parameters<typeof invoke>[0], capability: string, cred: unknown = credential) => ((await invoke(p, "query", { capability, input: null, credential: cred }, { workspaceId: "w", log: () => undefined })) as { output: unknown }).output;

test("a member is their own one target, from userinfo", async () => {
  answer = () => Response.json({ sub: "abc", name: "Ana Lee", picture: "x" });
  expect(await ask(createLinkedInPlugin(o), "social.identity")).toEqual({ accountId: "abc", accountLabel: "Ana Lee", accountType: "member" });
  expect(seen[0]).toMatchObject({ path: "/v2/userinfo", auth: "Bearer tok" });
});

test("an administrator's Pages are the targets, looked up one at a time with the version header", async () => {
  answer = (path) =>
    path === "/rest/organizationAcls"
      ? Response.json({ elements: [{ organization: "urn:li:organization:1", roleAssignee: "urn:li:person:p", role: "ADMINISTRATOR", state: "APPROVED" }, { organization: "urn:li:organization:2", roleAssignee: "urn:li:person:p" }] })
      : Response.json({ localizedName: path.endsWith("/1") ? "Acme" : "Beta" });
  expect(await ask(createLinkedInPagePlugin(o), "social.identity")).toEqual({
    accountId: "urn:li:person:p",
    accountLabel: "LinkedIn Pages",
    targets: [{ id: "urn:li:organization:1", name: "Acme", type: "page" }, { id: "urn:li:organization:2", name: "Beta", type: "page" }],
  });
  expect(seen.every((s) => s.version)).toBe(true);
  expect(seen.some((s) => s.path.includes("ids="))).toBe(false);
});

test("someone with no Pages can't connect the Page app", async () => {
  answer = () => Response.json({ elements: [] });
  await expect(ask(createLinkedInPagePlugin(o), "social.identity")).rejects.toThrow(/no Pages/);
});

test("health: 401 needs a reconnect, a 500 doesn't, and a lost Page role counts as refused", async () => {
  const member = createLinkedInPlugin(o);
  const page = createLinkedInPagePlugin(o);
  answer = () => new Response(null, { status: 401 });
  expect(await ask(member, "social.health")).toEqual({ ok: false, reason: "auth" });
  answer = () => new Response(null, { status: 500 });
  expect(await ask(member, "social.health")).toEqual({ ok: false, reason: "other" });
  answer = () => new Response(null, { status: 403 });
  expect(await ask(member, "social.health")).toEqual({ ok: false, reason: "other" });
  expect(await ask(page, "social.health")).toEqual({ ok: false, reason: "auth" });
  answer = () => Response.json({ sub: "abc" });
  expect(await ask(member, "social.health")).toEqual({ ok: true });
});

test("no token in any error", async () => {
  answer = () => new Response("tok", { status: 500 });
  await expect(ask(createLinkedInPlugin(o), "social.identity")).rejects.not.toThrow(/tok/);
});

test("the Page app holds only the two queries, and the member app can also publish", () => {
  const reads = [["query", "social.identity"], ["query", "social.health"]];
  expect(createLinkedInPagePlugin(o).manifest.capabilities.map((c) => [c.kind, c.name])).toEqual(reads);
  expect(createLinkedInPlugin(o).manifest.capabilities.map((c) => [c.kind, c.name])).toEqual([...reads, ["effect", "social.publish"]]);
});
