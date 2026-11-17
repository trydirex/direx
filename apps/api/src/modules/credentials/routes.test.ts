// SPDX-License-Identifier: AGPL-3.0-only
// The credential routes over HTTP: who may do what (V7), step-up, the audit row for
// removing someone else's credential, connect and callback, and that no response
// carries a value.
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { masterRootKey } from "./adapters/crypto";
import { createVault } from "./application/secrets";
import { startFakeProvider } from "./fake-provider";
import { testApp, vaultDb } from "./test-helpers";

const db = vaultDb();
const fake = startFakeProvider();
const vault = createVault({
  rootKey: masterRootKey(Buffer.alloc(32, 5)),
  now: () => new Date(),
  providers: [fake.provider()],
  callbackUrl: "http://direx.test/api/connections/callback",
  timeoutMs: 500,
});
const { call, signIn, workspace } = testApp(vault);
const MIN = 60_000;
afterEach(() => vi.useRealTimers());
afterAll(() => {
  fake.stop();
  return db.close();
});

const SECRET = "sk-do-not-echo";
const base = `/api/w`;
async function member(ws: string, role: string) {
  const m = await signIn();
  await db.addMember(ws, m.userId, role);
  return m;
}
const create = (ws: string, cookie: string, scope: "workspace" | "user", key = `k-${crypto.randomUUID()}`) =>
  call(`${base}/${ws}/credentials`, cookie, { method: "POST", body: { scope, kind: "api_key", key, name: "N", value: { key: SECRET } } });
async function created(ws: string, cookie: string, scope: "workspace" | "user") {
  const res = await create(ws, cookie, scope);
  expect(res.status).toBe(201);
  return ((await res.json()) as { credential: { id: string; version: number } }).credential;
}
const rotate = (ws: string, cookie: string, id: string, version = 1) =>
  call(`${base}/${ws}/credentials/${id}/value`, cookie, { method: "PUT", body: { version, value: { key: `${SECRET}-2` } } });
const remove = (ws: string, cookie: string, id: string) => call(`${base}/${ws}/credentials/${id}`, cookie, { method: "DELETE" });
const error = async (res: Response) => [res.status, ((await res.json()) as { error: string }).error];

test("V7: a Marketer creates and rotates their own user secret but not a workspace one; a Viewer neither", async () => {
  const { ws } = await workspace();
  const marketer = await member(ws, "marketer");
  const viewer = await member(ws, "viewer");

  const res = await create(ws, marketer.cookie, "user");
  expect(res.status).toBe(201);
  const text = await res.text();
  expect(text).not.toContain(SECRET);
  const mine = (JSON.parse(text) as { credential: { id: string; ownerUserId: string } }).credential;
  expect(mine.ownerUserId).toBe(marketer.userId);
  expect((await rotate(ws, marketer.cookie, mine.id)).status).toBe(200);
  expect(await error(await rotate(ws, marketer.cookie, mine.id, 1))).toEqual([409, "stale_version"]);

  expect(await error(await create(ws, marketer.cookie, "workspace"))).toEqual([403, "forbidden"]);
  expect(await error(await create(ws, viewer.cookie, "user"))).toEqual([403, "forbidden"]);
  expect(await error(await rotate(ws, viewer.cookie, mine.id))).toEqual([403, "forbidden"]);
});

test("V7: an Admin manages workspace secrets only with a recent sign-in", async () => {
  const { ws } = await workspace();
  const admin = await member(ws, "admin");
  const shared = await created(ws, admin.cookie, "workspace");
  expect((await rotate(ws, admin.cookie, shared.id)).status).toBe(200);

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 11 * MIN);
  expect(await error(await create(ws, admin.cookie, "workspace"))).toEqual([403, "step_up_required"]);
  expect(await error(await rotate(ws, admin.cookie, shared.id, 2))).toEqual([403, "step_up_required"]);
  expect(await error(await remove(ws, admin.cookie, shared.id))).toEqual([403, "step_up_required"]);
  // A user secret of their own needs none.
  expect((await create(ws, admin.cookie, "user")).status).toBe(201);
});

test("everyone in the Workspace lists metadata, never a value", async () => {
  const { ws, owner } = await workspace();
  const viewer = await member(ws, "viewer");
  const shared = await created(ws, owner.cookie, "workspace");
  const res = await call(`${base}/${ws}/credentials`, viewer.cookie);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain(SECRET);
  expect((JSON.parse(text) as { credentials: { id: string }[] }).credentials.map((c) => c.id)).toEqual([shared.id]);
  expect((await call(`${base}/${ws}/credentials`)).status).toBe(401);
});

test("a user secret is rotated only by its owner; deleting someone else's needs credential.manage and is audited", async () => {
  const { ws, owner } = await workspace();
  const marketer = await member(ws, "marketer");
  const other = await member(ws, "marketer");
  const admin = await member(ws, "admin");
  const theirs = await created(ws, marketer.cookie, "user");

  expect(await error(await rotate(ws, admin.cookie, theirs.id))).toEqual([403, "forbidden"]);
  expect(await error(await remove(ws, other.cookie, theirs.id))).toEqual([403, "forbidden"]);
  expect((await remove(ws, admin.cookie, theirs.id)).status).toBe(200);
  expect(await error(await remove(ws, admin.cookie, theirs.id))).toEqual([404, "missing"]);
  expect(await error(await rotate(ws, owner.cookie, crypto.randomUUID()))).toEqual([404, "missing"]);

  const own = await created(ws, marketer.cookie, "user");
  expect((await remove(ws, marketer.cookie, own.id)).status).toBe(200);

  const audit = await db.q(ws, "select event, subject_user_id, actor_user_id, step_up from workspace_audit where event = 'credential.deleted'");
  expect(audit).toEqual([{ event: "credential.deleted", subject_user_id: marketer.userId, actor_user_id: admin.userId, step_up: true }]);
});

test("access history is its owner's or a manager's, newest first", async () => {
  const { ws } = await workspace();
  const marketer = await member(ws, "marketer");
  const other = await member(ws, "marketer");
  const admin = await member(ws, "admin");
  const mine = await created(ws, marketer.cookie, "user");
  await rotate(ws, marketer.cookie, mine.id);
  const events = (cookie: string) => call(`${base}/${ws}/credentials/${mine.id}/events`, cookie);

  const res = await events(marketer.cookie);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { events: { consumer: string }[] }).events.map((e) => e.consumer)).toEqual(["rotate", "create"]);
  expect((await events(admin.cookie)).status).toBe(200);
  expect(await error(await events(other.cookie))).toEqual([403, "forbidden"]);
});

test("connect: start sets the state cookie and the callback stores the mailbox, then clears it", async () => {
  const { ws } = await workspace();
  const contributor = await member(ws, "contributor");
  const viewer = await member(ws, "viewer");
  expect(await error(await call(`${base}/${ws}/connections/google/start`, viewer.cookie, { method: "POST" }))).toEqual([403, "forbidden"]);
  expect(await error(await call(`${base}/${ws}/connections/nope/start`, contributor.cookie, { method: "POST" }))).toEqual([404, "unknown_connection"]);

  const started = await call(`${base}/${ws}/connections/google/start`, contributor.cookie, { method: "POST" });
  expect(started.status).toBe(200);
  const setCookie = started.headers.get("set-cookie")!;
  expect(setCookie).toMatch(/^direx_oauth=/);
  expect(setCookie).toMatch(/HttpOnly/);
  expect(setCookie).toMatch(/SameSite=Lax/);
  expect(setCookie).toMatch(/Path=\/api\/connections/);
  const stateCookie = setCookie.split(";")[0]!;
  const { url } = (await started.json()) as { url: string };
  const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
  const callback = (cookie: string, search = back.search) =>
    call(`/api/connections/callback${search}`, cookie);

  expect((await call(`/api/connections/callback${back.search}`)).status).toBe(401);
  const wrong = await callback(`${contributor.cookie}; ${stateCookie}`, `?state=x&code=${back.searchParams.get("code")}`);
  expect(wrong.headers.get("location")).toBe("http://direx.test/?page=credentials&connect_error=state_mismatch");

  const res = await callback(`${contributor.cookie}; ${stateCookie}`);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toMatch(new RegExp(`^http://direx.test/\\?workspace=${ws}&page=credentials&connected=[0-9a-f-]{36}$`));
  expect(res.headers.get("set-cookie")).toMatch(/^direx_oauth=;.*Max-Age=0/);
  const list = (await (await call(`${base}/${ws}/credentials`, contributor.cookie)).json()) as { credentials: { kind: string; ownerUserId: string }[] };
  expect(list.credentials).toMatchObject([{ kind: "oauth2", ownerUserId: contributor.userId }]);
});
