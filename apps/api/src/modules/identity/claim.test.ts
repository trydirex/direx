// SPDX-License-Identifier: AGPL-3.0-only
// The bootstrap claim outside dev (ADR 0024, rule 005): one link, one Server admin, recorded.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { insertAuthUser, ownerClient } from "../../../../../test/db";
import { selfHostAdmission } from "./application/admission";
import { testIdentity } from "./test-auth";

const closed = testIdentity({ devMode: false, admission: selfHostAdmission({ devMode: false }) });
let owner: Awaited<ReturnType<typeof ownerClient>>;

/** What `bun run server-admin --invite` stores; returns the raw token the link carries. */
async function issue(): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await owner.query("select system.issue_bootstrap_invite($1, now() + interval '1 hour')", [createHash("sha256").update(token).digest("hex")]);
  return token;
}
/** A signed-in account with a confirmed email (the magic link confirms it). */
async function account(): Promise<string> {
  const id = crypto.randomUUID();
  await insertAuthUser(id);
  return closed.signIn(`${id}@example.com`);
}
const claim = (cookie: string | undefined, token: string) => closed.call("/api/server/claim", cookie, { method: "POST", body: { token } });
const status = async (cookie: string) => (await closed.call("/api/server/status", cookie)).json();
const admins = async () => (await owner.query("select user_id from system.server_admins")).rows;

beforeAll(async () => {
  owner = await ownerClient();
});
afterAll(() => owner.end());
beforeEach(async () => {
  await owner.query("delete from system.server_admins; delete from system.bootstrap_invites; delete from system.server_admin_events;");
});

test("a signed-in person with the link becomes the first Server admin, and an event records it", async () => {
  const token = await issue();
  const cookie = await account();
  expect(await status(cookie)).toEqual({ claimed: false, canCreateOrganization: false, serverAdmin: false });

  const res = await claim(cookie, token);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(await status(cookie)).toEqual({ claimed: true, canCreateOrganization: true, serverAdmin: true });
  const { rows } = await owner.query("select action, via, by_user_id from system.server_admin_events");
  expect(rows).toEqual([{ action: "grant", via: "bootstrap", by_user_id: null }]);
});

test("a used link is refused, and the server keeps one Server admin", async () => {
  const token = await issue();
  expect((await claim(await account(), token)).status).toBe(200);
  const res = await claim(await account(), token);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "link_unusable" });
  expect(await admins()).toHaveLength(1);
});

test("two claims at once leave one Server admin", async () => {
  const token = await issue();
  const [a, b] = [await account(), await account()];
  const codes = (await Promise.all([claim(a, token), claim(b, token)])).map((r) => r.status).sort();
  expect(codes).toEqual([200, 409]);
  expect(await admins()).toHaveLength(1);
});

test("an expired or revoked link is refused", async () => {
  const revoked = await issue();
  await issue(); // revokes the first
  const expired = randomBytes(32).toString("hex");
  await owner.query("insert into system.bootstrap_invites (token_hash, created_at, expires_at) values ($1, now() - interval '2 hours', now() - interval '1 hour')", [
    createHash("sha256").update(expired).digest("hex"),
  ]);
  const cookie = await account();
  for (const t of [revoked, expired]) expect(await (await claim(cookie, t)).json()).toEqual({ error: "link_unusable" });
  expect(await admins()).toEqual([]);
});

test("claiming needs a session and a token-shaped body", async () => {
  const token = await issue();
  expect((await claim(undefined, token)).status).toBe(401);
  expect((await closed.call("/api/server/status")).status).toBe(401);
  expect((await claim(await account(), "not-a-token")).status).toBe(400);
});
