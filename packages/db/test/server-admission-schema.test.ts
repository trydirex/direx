// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of server admission (ADR 0024): the system functions as direx_app,
// and the CLI's functions as the owner.
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { withWorkspace } from "../src/index";
import { organizations, workspaceInvites, workspaceMembers, workspaces } from "../src/schema";
import { appClient, insertAuthUser, ownerClient } from "../../../test/db";

let app: pg.Client;
let owner: pg.Client;

const sha = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("hex");
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

function pgCode(e: unknown): string | undefined {
  return (e as { code?: string }).code;
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return pgCode(e);
  }
}

async function newUser(verified = true): Promise<string> {
  const id = crypto.randomUUID();
  await insertAuthUser(id);
  if (verified) await app.query(`update auth."user" set email_verified = true where id = $1`, [id]);
  return id;
}

const admission = async (email: string, tokenHash: string | null) =>
  (await app.query("select system.signup_admission($1, $2) as r", [email, tokenHash])).rows[0].r as string;

const issue = (tokenHash: string, expires = inHours(72)) =>
  owner.query("select system.issue_bootstrap_invite($1, $2)", [tokenHash, expires]);

const claim = (c: pg.Client, user: string, tokenHash: string) =>
  c.query("select system.claim_bootstrap($1, $2)", [user, tokenHash]);

const admins = async () =>
  (await owner.query("select user_id from system.server_admins order by user_id")).rows.map((r) => r.user_id as string);

/** A claimed server whose only Server admin is returned. */
async function claimedBy(): Promise<string> {
  const token = newToken();
  await issue(sha(token));
  const u = await newUser();
  await claim(app, u, sha(token));
  return u;
}

beforeAll(async () => {
  app = await appClient();
  owner = await ownerClient();
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

// Each test starts from an unclaimed server with Invite only, as a fresh or upgraded one is.
beforeEach(async () => {
  await owner.query(`
    delete from system.server_admins;
    delete from system.bootstrap_invites;
    delete from system.server_admin_events;
    update system.server_settings set signup_policy = 'invite_only', allowed_domains = '{}', updated_by = null;`);
});

test("direx_app holds no privilege on the admission tables and can't run the CLI's functions (DX-R-0024-010)", async () => {
  for (const t of ["server_settings", "server_admins", "bootstrap_invites", "server_admin_events"]) {
    const { rows } = await app.query(
      "select has_table_privilege('direx_app', $1, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as p",
      [`system.${t}`],
    );
    expect(rows[0].p, t).toBe(false);
    expect(await codeOf(app.query(`select * from system.${t}`)), t).toBe("42501");
  }
  expect(await codeOf(app.query("select system.issue_bootstrap_invite($1, $2)", [sha(newToken()), inHours(1)]))).toBe("42501");
  expect(await codeOf(app.query("select system.cli_grant_server_admin('a@example.com')"))).toBe("42501");
});

test("a fresh server is unclaimed and Invite only (DX-R-0024-003)", async () => {
  const { rows } = await app.query("select * from system.server_status()");
  expect(rows).toEqual([{ claimed: false, signup_policy: "invite_only", allowed_domains: [] }]);
  expect(await admission("anyone@example.com", null)).toBe("refused");
});

test("the policy admits by exact domain, or anyone, and only a Server admin can set it", async () => {
  const a = await claimedBy();
  const stranger = await newUser();
  expect(await codeOf(app.query("select system.set_signup_policy($1, 'anyone', '{}')", [stranger]))).toBe("DX403");

  await app.query("select system.set_signup_policy($1, 'domains', $2)", [a, ["acme.com", "xn--bcher-kva.de"]]);
  expect(await admission("Sam@ACME.com", null)).toBe("policy");
  expect(await admission("sam@mail.acme.com", null)).toBe("refused");
  expect(await admission("sam@acme.com.evil.io", null)).toBe("refused");
  expect(await admission("x@evil.io@acme.com", null)).toBe("policy");
  expect(await admission("sam@xn--bcher-kva.de", null)).toBe("policy");
  expect(await admission("not-an-address", null)).toBe("refused");

  expect(await codeOf(app.query("select system.set_signup_policy($1, 'domains', $2)", [a, ["ACME.com"]]))).toBe("DXDOM");
  expect(await codeOf(app.query("select system.set_signup_policy($1, 'domains', $2)", [a, ["acme"]]))).toBe("DXDOM");
  expect(await codeOf(app.query("select system.set_signup_policy($1, 'open', '{}')", [a]))).toBe("23514");

  await app.query("select system.set_signup_policy($1, 'anyone', '{}')", [a]);
  expect(await admission("anyone@example.com", null)).toBe("policy");
  const { rows } = await owner.query("select updated_by from system.server_settings");
  expect(rows[0].updated_by).toBe(a);
});

test("a Workspace invite admits only its own email, while it's usable", async () => {
  const inviter = await newUser();
  const workspaceId = crypto.randomUUID();
  const token = newToken();
  const now = new Date();
  await withWorkspace(workspaceId, async (tx) => {
    const orgId = crypto.randomUUID();
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: now });
    await tx.insert(workspaces).values({ id: workspaceId, orgId, name: "W", createdAt: now });
    await tx.insert(workspaceMembers).values({ workspaceId, userId: inviter, role: "owner", createdAt: now });
    await tx.insert(workspaceInvites).values({
      workspaceId,
      email: "kim@client.io",
      role: "marketer",
      tokenHash: sha(token),
      invitedBy: inviter,
      expiresAt: inHours(24),
      createdAt: now,
    });
  });

  expect(await admission(" Kim@Client.io ", sha(token))).toBe("invite");
  expect(await admission("other@client.io", sha(token))).toBe("refused");
  expect(await admission("kim@client.io", sha(newToken()))).toBe("refused");

  await owner.query("update workspace_invites set revoked_at = now() where token_hash = $1", [sha(token)]);
  expect(await admission("kim@client.io", sha(token))).toBe("refused");
});

test("a bootstrap invite admits anyone until the server is claimed, and is claimed once (DX-R-0024-005)", async () => {
  const token = newToken();
  await issue(sha(token));
  expect(await admission("first@anywhere.io", sha(token))).toBe("bootstrap");

  const first = await newUser();
  await claim(app, first, sha(token));
  expect(await admins()).toEqual([first]);
  expect(await admission("second@anywhere.io", sha(token))).toBe("refused");

  const second = await newUser();
  expect(await codeOf(claim(app, second, sha(token)))).toBe("DXCLM");
  expect(await codeOf(issue(sha(newToken())))).toBe("DXCLM");

  const { rows } = await owner.query("select user_id, action, via, by_user_id from system.server_admin_events");
  expect(rows).toEqual([{ user_id: first, action: "grant", via: "bootstrap", by_user_id: null }]);
});

test("a bootstrap invite can't be claimed unverified, expired, revoked or unknown", async () => {
  const old = newToken();
  await issue(sha(old));
  const token = newToken();
  await issue(sha(token));
  const { rows } = await owner.query("select revoked_at from system.bootstrap_invites where token_hash = $1", [sha(old)]);
  expect(rows[0].revoked_at).not.toBeNull();

  const unverified = await newUser(false);
  expect(await codeOf(claim(app, unverified, sha(token)))).toBe("DXUNV");

  const u = await newUser();
  expect(await codeOf(claim(app, u, sha(old)))).toBe("DX404");
  expect(await codeOf(claim(app, u, sha(newToken())))).toBe("DX404");

  await owner.query(
    "update system.bootstrap_invites set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where token_hash = $1",
    [sha(token)],
  );
  expect(await codeOf(claim(app, u, sha(token)))).toBe("DX404");
  expect(await admins()).toEqual([]);

  expect(await codeOf(issue(sha(newToken()), inHours(73)))).toBe("23514");
});

test("two claims at once leave one Server admin", async () => {
  const token = newToken();
  await issue(sha(token));
  const [a, b] = [await newUser(), await newUser()];
  const other = await appClient();
  try {
    await app.query("begin");
    await other.query("begin");
    await claim(app, a, sha(token));
    const late = claim(other, b, sha(token)).then(
      () => undefined,
      (e: unknown) => pgCode(e),
    );
    await app.query("commit");
    expect(await late).toBe("DXCLM");
    await other.query("rollback");
  } finally {
    await other.end();
  }
  expect(await admins()).toEqual([a]);
});

test("Server admins add and remove each other, never the last one, and every change is recorded (DX-R-0024-009)", async () => {
  const a = await claimedBy();
  const b = await newUser();
  const stranger = await newUser();

  expect(await codeOf(app.query("select system.set_server_admin($1, $2, true)", [stranger, b]))).toBe("DX403");
  expect(await codeOf(app.query("select system.set_server_admin($1, $2, true)", [a, crypto.randomUUID()]))).toBe("DX404");

  await app.query("select system.set_server_admin($1, $2, true)", [a, b]);
  await app.query("select system.set_server_admin($1, $2, true)", [a, b]);
  expect((await admins()).sort()).toEqual([a, b].sort());

  await app.query("select system.set_server_admin($1, $2, false)", [b, a]);
  expect(await admins()).toEqual([b]);
  expect(await codeOf(app.query("select system.set_server_admin($1, $2, false)", [b, b]))).toBe("DXLST");
  expect(await codeOf(app.query("select system.set_server_admin($1, $2, false)", [b, stranger]))).toBe("DX404");

  const { rows } = await owner.query("select user_id, action, via, by_user_id from system.server_admin_events order by id");
  expect(rows).toEqual([
    { user_id: a, action: "grant", via: "bootstrap", by_user_id: null },
    { user_id: b, action: "grant", via: "admin", by_user_id: a },
    { user_id: a, action: "remove", via: "admin", by_user_id: b },
  ]);
});

test("two Server admins removing each other at once leave one", async () => {
  const a = await claimedBy();
  const b = await newUser();
  await app.query("select system.set_server_admin($1, $2, true)", [a, b]);
  const other = await appClient();
  try {
    await app.query("begin");
    await other.query("begin");
    await app.query("select system.set_server_admin($1, $2, false)", [a, b]);
    const late = other.query("select system.set_server_admin($1, $2, false)", [b, a]).then(
      () => undefined,
      (e: unknown) => pgCode(e),
    );
    await app.query("commit");
    expect(await late).toBe("DX403");
    await other.query("rollback");
  } finally {
    await other.end();
  }
  expect(await admins()).toEqual([a]);
});

test("a Server admin's account can't be deleted", async () => {
  const a = await claimedBy();
  expect(await codeOf(app.query(`delete from auth."user" where id = $1`, [a]))).toBe("23503");
});

test("the CLI grants an existing account by email, as the owner", async () => {
  const u = await newUser();
  expect(await codeOf(owner.query("select system.cli_grant_server_admin('nobody@example.com')"))).toBe("DX404");
  const { rows } = await owner.query("select system.cli_grant_server_admin($1) as id", [` ${u.toUpperCase()}@EXAMPLE.COM `]);
  expect(rows[0].id).toBe(u);
  expect(await admins()).toEqual([u]);
  const events = await owner.query("select user_id, action, via, by_user_id from system.server_admin_events");
  expect(events.rows).toEqual([{ user_id: u, action: "grant", via: "cli", by_user_id: null }]);
});

test("only a Server admin lists accounts, and sees account fields only", async () => {
  const stranger = await newUser();
  expect(await codeOf(app.query("select * from system.list_accounts($1)", [stranger]))).toBe("DX403");
  const a = await claimedBy();
  const { rows } = await app.query("select * from system.list_accounts($1)", [a]);
  expect(Object.keys(rows[0]).sort()).toEqual(["created_at", "email", "email_verified", "server_admin", "user_id"]);
  expect(rows.find((r) => r.user_id === a)).toMatchObject({ email: `${a}@example.com`, email_verified: true, server_admin: true });
  expect(rows.find((r) => r.user_id === stranger)).toMatchObject({ server_admin: false });
});

test("is_server_admin answers for one account", async () => {
  const a = await claimedBy();
  const other = await newUser();
  const ask = async (id: string) => (await app.query("select system.is_server_admin($1) as r", [id])).rows[0].r;
  expect(await ask(a)).toBe(true);
  expect(await ask(other)).toBe(false);
});
