// SPDX-License-Identifier: AGPL-3.0-only
// The Server page's routes outside dev (ADR 0024, rules 007 to 009): only Server admins, every
// change recorded, the last admin kept, the policy locked while mail fails, Organizations gated.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import { insertAuthUser, ownerClient } from "../../../../../test/db";
import { selfHostAdmission } from "./application/admission";
import { testIdentity } from "./test-auth";

const closed = testIdentity({ devMode: false, admission: selfHostAdmission({ devMode: false }) });
const open = testIdentity();
let owner: Awaited<ReturnType<typeof ownerClient>>;

/** A signed-in account with a confirmed email; a Server admin when `admin`. */
async function account(admin = false) {
  const userId = crypto.randomUUID();
  await insertAuthUser(userId);
  if (admin) await owner.query("insert into system.server_admins (user_id) values ($1)", [userId]);
  return { userId, email: `${userId}@example.com`, cookie: await closed.signIn(`${userId}@example.com`) };
}
const call = (cookie: string | undefined, path: string, method = "GET", body?: unknown) => closed.call(path, cookie, { method, body });
const events = async () => (await owner.query("select user_id, action, via, by_user_id from system.server_admin_events order by id")).rows;
const admins = async () => (await owner.query("select user_id from system.server_admins")).rows.map((r) => r.user_id as string);

beforeAll(async () => {
  owner = await ownerClient();
});
afterAll(() => owner.end());
beforeEach(async () => {
  await owner.query("delete from system.server_admins; delete from system.server_admin_events; update system.server_settings set signup_policy = 'invite_only', allowed_domains = '{}';");
});
afterEach(() => {
  delete closed.config().mailer.verify;
});

const ROUTES: [string, string, unknown?][] = [
  ["GET", "/api/server/policy"],
  ["PUT", "/api/server/policy", { policy: "anyone", domains: [] }],
  ["GET", "/api/server/mail-status"],
  ["GET", "/api/server/accounts"],
  ["POST", "/api/server/admins", { email: "a@example.com" }],
  ["DELETE", `/api/server/admins/${crypto.randomUUID()}`],
];

test("only a signed-in Server admin reaches the Server routes", async () => {
  const { cookie } = await account();
  for (const [method, path, body] of ROUTES) {
    expect((await call(undefined, path, method, body)).status).toBe(401);
    expect(await (await call(cookie, path, method, body)).json()).toEqual({ error: "forbidden" });
  }
});

test("a Server admin sets Allowed domains, stored lowercased and as punycode", async () => {
  const { cookie } = await account(true);
  const res = await call(cookie, "/api/server/policy", "PUT", { policy: "domains", domains: [" Example.COM", "bücher.example", "example.com"] });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ policy: "domains", domains: ["example.com", "xn--bcher-kva.example"] });
  expect(await (await call(cookie, "/api/server/policy")).json()).toEqual({ policy: "domains", domains: ["example.com", "xn--bcher-kva.example"] });

  expect((await call(cookie, "/api/server/policy", "PUT", { policy: "domains", domains: [] })).status).toBe(400);
  expect(await (await call(cookie, "/api/server/policy", "PUT", { policy: "domains", domains: ["not a domain"] })).json()).toEqual({ error: "bad_domain" });
});

test("while mail fails, the mail status says so and the policy can't change", async () => {
  const { cookie } = await account(true);
  closed.config().mailer.verify = async () => false;
  expect(await (await call(cookie, "/api/server/mail-status")).json()).toEqual({ ok: false });
  const res = await call(cookie, "/api/server/policy", "PUT", { policy: "anyone", domains: [] });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "mail_failing" });
  expect(await (await call(cookie, "/api/server/policy")).json()).toEqual({ policy: "invite_only", domains: [] });

  closed.config().mailer.verify = async () => true;
  expect(await (await call(cookie, "/api/server/mail-status")).json()).toEqual({ ok: true });
  expect((await call(cookie, "/api/server/policy", "PUT", { policy: "anyone", domains: [] })).status).toBe(200);
});

test("the accounts list holds account fields only, and marks Server admins", async () => {
  const admin = await account(true);
  const other = await account();
  const { accounts } = (await (await call(admin.cookie, "/api/server/accounts")).json()) as { accounts: Record<string, unknown>[] };
  const mine = accounts.find((a) => a.userId === admin.userId)!;
  expect(Object.keys(mine).sort()).toEqual(["createdAt", "email", "emailVerified", "serverAdmin", "userId"]);
  expect(mine).toMatchObject({ email: admin.email, emailVerified: true, serverAdmin: true });
  expect(accounts.find((a) => a.userId === other.userId)).toMatchObject({ serverAdmin: false });
});

test("adding and removing Server admins needs step-up, keeps the last one, and records who did it", async () => {
  const a = await account(true);
  const b = await account();
  expect(await (await call(a.cookie, "/api/server/admins", "POST", { email: "nobody@example.com" })).json()).toEqual({ error: "no_account" });
  expect((await call(a.cookie, "/api/server/admins", "POST", { email: b.email.toUpperCase() })).status).toBe(200);
  expect((await call(a.cookie, `/api/server/admins/${b.userId}`, "DELETE")).status).toBe(200);
  expect(await events()).toEqual([
    { user_id: b.userId, action: "grant", via: "admin", by_user_id: a.userId },
    { user_id: b.userId, action: "remove", via: "admin", by_user_id: a.userId },
  ]);

  const last = await call(a.cookie, `/api/server/admins/${a.userId}`, "DELETE");
  expect(last.status).toBe(409);
  expect(await last.json()).toEqual({ error: "last_server_admin" });

  await owner.query("update auth.session set created_at = now() - interval '11 minutes' where user_id = $1", [a.userId]);
  expect(await (await call(a.cookie, "/api/server/admins", "POST", { email: b.email })).json()).toEqual({ error: "step_up_required" });
  expect(await admins()).toEqual([a.userId]);
});

test("two Server admins removing each other at once leave one", async () => {
  const a = await account(true);
  const b = await account(true);
  const codes = (await Promise.all([call(a.cookie, `/api/server/admins/${b.userId}`, "DELETE"), call(b.cookie, `/api/server/admins/${a.userId}`, "DELETE")])).map((r) => r.status);
  expect(codes.sort()).toEqual([200, 403]);
  expect(await admins()).toHaveLength(1);
  expect(await events()).toHaveLength(1);
});

test("on self-host only a Server admin creates an Organization; in dev anyone does", async () => {
  const someone = await account();
  const refused = await call(someone.cookie, "/api/orgs", "POST", { name: "Acme", workspaceName: "Shop" });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "cannot_create_organization" });
  expect(await (await call(someone.cookie, "/api/server/status")).json()).toEqual({ claimed: false, canCreateOrganization: false, serverAdmin: false });

  const admin = await account(true);
  expect((await call(admin.cookie, "/api/orgs", "POST", { name: "Acme", workspaceName: "Shop" })).status).toBe(201);
  await open.createOrg(await open.signIn());
});

test("a Server admin with no membership reads no Workspace (rule 007)", async () => {
  const { workspace } = await open.createOrg(await open.signIn());
  const admin = await account(true);
  expect((await call(admin.cookie, `/api/w/${workspace.id}`)).status).toBe(404);
  expect((await call(admin.cookie, `/api/w/${workspace.id}/members`)).status).toBe(404);
});
