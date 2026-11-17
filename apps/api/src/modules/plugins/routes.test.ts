// SPDX-License-Identifier: AGPL-3.0-only
// Third-party plugins over HTTP, through the real identity routes and database (ADR 0026 rules 001
// and 002): only a Server admin reviews, installs and removes, after a recent sign-in, and only a
// Workspace owner turns a plugin on, for what it may do and reach now.
import type { Manifest } from "@direx/plugin-sdk";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { testIdentity } from "../identity/test-auth";
import { HOST_VERSION, pluginRoutes, type ProbeResult } from "./index";

const ID = "com.example.hello";
const hello: Manifest = {
  id: ID, name: "Hello", apiVersion: 1, version: "0.1.0", minHostVersion: "0.2.0", trust: "third_party",
  connections: [{ key: "hello", auth: "api_key" }], egress: { hosts: ["api.example.com"] },
  capabilities: [{ kind: "effect", name: "hello.ping", connection: "hello", dedupe: "blind", risk: "low", reachesPerson: false }],
};
let reported: ProbeResult = { ok: true, manifest: hello };

const identity = testIdentity();
const store = join(mkdtempSync(join(tmpdir(), "direx-plugin-routes-")), "plugin-store");
identity.routes.route(
  "/",
  pluginRoutes({ auth: identity.auth, storeDir: () => store, firstPartyIds: () => new Set(["com.example.gmail"]), hostVersion: HOST_VERSION, probe: async () => reported }),
);
let owner: Awaited<ReturnType<typeof ownerClient>>;

const call = (cookie: string | undefined, path: string, method = "GET", body?: unknown) => identity.call(path, cookie, { method, ...(body !== undefined && { body }) });
const upload = (cookie: string, bytes = "console.log('hello');") =>
  identity.routes.request("/api/server/plugins/review", { method: "POST", headers: { cookie, "content-type": "application/octet-stream" }, body: bytes });

async function admin() {
  const cookie = await identity.signIn();
  const me = (await (await call(cookie, "/api/me")).json()) as { user: { id: string } };
  await owner.query("insert into system.server_admins (user_id) values ($1)", [me.user.id]);
  return { cookie, userId: me.user.id };
}
type Review = { stageId: string; entrySha256: string; mode: string; plugin: { pluginId: string; capabilities: { reachesPerson: boolean }[] }; added: string[]; removed: string[]; permissionsChanged: boolean };
async function install(cookie: string, bytes?: string) {
  const review = (await (await upload(cookie, bytes)).json()) as Review;
  const res = await call(cookie, "/api/server/plugins/confirm", "POST", { stageId: review.stageId, entrySha256: review.entrySha256 });
  expect(res.status).toBe(200);
  return review;
}

beforeAll(async () => {
  owner = await ownerClient();
});
afterAll(() => owner.end());
beforeEach(async () => {
  reported = { ok: true, manifest: hello };
  await owner.query("delete from system.plugin_installs; delete from system.plugin_install_events; delete from system.server_admins; delete from workspace_plugins");
});
afterEach(() => vi.useRealTimers());

test("only a signed-in Server admin reaches the server plugin routes", async () => {
  const someone = await identity.signIn();
  for (const [method, path, body] of [
    ["GET", "/api/server/plugins"],
    ["POST", "/api/server/plugins/confirm", { stageId: crypto.randomUUID(), entrySha256: "x" }],
    ["DELETE", `/api/server/plugins/${ID}`],
  ] as [string, string, unknown?][]) {
    expect((await call(undefined, path, method, body)).status, path).toBe(401);
    expect(await (await call(someone, path, method, body)).json(), path).toEqual({ error: "forbidden" });
  }
  expect((await upload(someone)).status).toBe(403);
});

test("review shows what the bundle asks for and installs nothing; confirm installs exactly what was reviewed", async () => {
  const { cookie } = await admin();
  const res = await upload(cookie);
  expect(res.status).toBe(200);
  const review = (await res.json()) as Review;
  expect(review).toMatchObject({ mode: "install", plugin: { pluginId: ID, egress: ["api.example.com"], connections: [{ key: "hello", auth: "api_key" }] }, permissionsChanged: false });
  // Core decides: a third-party effect counts as reaching a Person.
  expect(review.plugin.capabilities).toEqual([{ kind: "effect", name: "hello.ping", reachesPerson: true }]);
  expect((await (await call(cookie, "/api/server/plugins")).json()) as unknown).toEqual({ plugins: [] });

  expect(await (await call(cookie, "/api/server/plugins/confirm", "POST", { stageId: review.stageId, entrySha256: "0".repeat(64) })).json()).toEqual({ error: "changed" });
  expect(await (await call(cookie, "/api/server/plugins/confirm", "POST", { stageId: crypto.randomUUID(), entrySha256: review.entrySha256 })).json()).toEqual({ error: "stage_gone" });
  expect((await call(cookie, "/api/server/plugins/confirm", "POST", { stageId: review.stageId, entrySha256: review.entrySha256 })).status).toBe(200);

  const { plugins } = (await (await call(cookie, "/api/server/plugins")).json()) as { plugins: { pluginId: string; entrySha256: string }[] };
  expect(plugins).toEqual([expect.objectContaining({ pluginId: ID, entrySha256: review.entrySha256 })]);
  expect(existsSync(join(store, `${review.entrySha256}.js`))).toBe(true);
  // The staged copy is gone once it is installed.
  expect(readdirSync(join(store, "..", "plugin-staging")).filter((f) => f.startsWith(review.stageId))).toEqual([]);
  const { rows } = await owner.query("select action, via, by_user_id is not null as by from system.plugin_install_events");
  expect(rows).toEqual([{ action: "install", via: "web", by: true }]);
});

test("a refused bundle says why, and a second upload of an installed plugin is an upgrade with its changes", async () => {
  const { cookie } = await admin();
  reported = { ok: true, manifest: { ...hello, connections: [{ key: "hello", auth: "oauth2" }] } };
  const refused = await upload(cookie);
  expect(refused.status).toBe(422);
  expect(await refused.json()).toEqual({ error: "refused", reasons: ["connection hello signs in with OAuth, which third-party plugins can't yet"] });

  reported = { ok: true, manifest: hello };
  await install(cookie);
  reported = { ok: true, manifest: { ...hello, version: "0.2.0", egress: { hosts: ["api.example.com", "cdn.example.com"] } } };
  const review = (await (await upload(cookie, "console.log('hello v2');")).json()) as Review;
  expect(review).toMatchObject({ mode: "upgrade", added: ["reaches cdn.example.com"], removed: [], permissionsChanged: true });
});

test("an upload over 10 MB is refused before it is read", async () => {
  const { cookie } = await admin();
  expect((await upload(cookie, "x".repeat(10 * 1024 * 1024 + 1))).status).toBe(413);
});

test("installing, upgrading and removing need a sign-in within the last ten minutes", async () => {
  const { cookie } = await admin();
  const review = (await (await upload(cookie)).json()) as Review;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 11 * 60_000);
  expect(await (await upload(cookie)).json()).toEqual({ error: "step_up_required" });
  expect(await (await call(cookie, "/api/server/plugins/confirm", "POST", { stageId: review.stageId, entrySha256: review.entrySha256 })).json()).toEqual({ error: "step_up_required" });
  expect(await (await call(cookie, `/api/server/plugins/${ID}`, "DELETE")).json()).toEqual({ error: "step_up_required" });
});

test("only a Workspace owner turns it on, for that Workspace only, and everyone there sees it", async () => {
  const { cookie: adminCookie } = await admin();
  const ownerCookie = await identity.signIn();
  const { workspace } = await identity.createOrg(ownerCookie);
  const other = await identity.createOrg(await identity.signIn(), "Other");
  const marketer = await identity.addMember(ownerCookie, workspace.id, "marketer");
  const list = async (cookie: string, ws = workspace.id) => ((await (await call(cookie, `/api/w/${ws}/plugins`)).json()) as { plugins: { pluginId: string; on: boolean }[] }).plugins;

  expect(await list(marketer.cookie)).toEqual([]);
  await install(adminCookie);
  expect(await list(marketer.cookie)).toEqual([expect.objectContaining({ pluginId: ID, on: false })]);

  expect(await (await call(marketer.cookie, `/api/w/${workspace.id}/plugins/${ID}`, "PUT")).json()).toEqual({ error: "forbidden" });
  expect((await call(ownerCookie, `/api/w/${workspace.id}/plugins/${ID}`, "PUT")).status).toBe(200);
  expect(await list(marketer.cookie)).toEqual([expect.objectContaining({ pluginId: ID, on: true })]);
  // Being a Server admin opens no Workspace, and another Workspace is unaffected.
  expect((await call(adminCookie, `/api/w/${workspace.id}/plugins/${ID}`, "PUT")).status).toBe(404);
  expect(await list(ownerCookie, workspace.id)).toEqual([expect.objectContaining({ on: true })]);
  expect((await call(ownerCookie, `/api/w/${other.workspace.id}/plugins`)).status).toBe(404);

  // An upgrade that changes what it may reach turns it off until the owner says yes again.
  reported = { ok: true, manifest: { ...hello, version: "0.2.0", egress: { hosts: ["api.example.com", "cdn.example.com"] } } };
  await install(adminCookie, "console.log('hello v2');");
  expect(await list(ownerCookie)).toEqual([expect.objectContaining({ version: "0.2.0", on: false })]);
  expect((await call(ownerCookie, `/api/w/${workspace.id}/plugins/${ID}`, "PUT")).status).toBe(200);
  expect(await list(ownerCookie)).toEqual([expect.objectContaining({ on: true })]);

  expect((await call(ownerCookie, `/api/w/${workspace.id}/plugins/${ID}`, "DELETE")).status).toBe(200);
  expect(await list(ownerCookie)).toEqual([expect.objectContaining({ on: false })]);
  expect(await (await call(ownerCookie, `/api/w/${workspace.id}/plugins/com.example.nope`, "PUT")).json()).toEqual({ error: "not_installed" });
});

test("removing takes it away from every Workspace and deletes its stored file", async () => {
  const { cookie } = await admin();
  const ownerCookie = await identity.signIn();
  const { workspace } = await identity.createOrg(ownerCookie);
  const review = await install(cookie);
  await call(ownerCookie, `/api/w/${workspace.id}/plugins/${ID}`, "PUT");
  expect((await call(cookie, `/api/server/plugins/${ID}`, "DELETE")).status).toBe(200);
  expect(await (await call(cookie, `/api/server/plugins/${ID}`, "DELETE")).json()).toEqual({ error: "not_installed" });
  expect(existsSync(join(store, `${review.entrySha256}.js`))).toBe(false);
  expect(((await (await call(ownerCookie, `/api/w/${workspace.id}/plugins`)).json()) as { plugins: unknown[] }).plugins).toEqual([]);
});
