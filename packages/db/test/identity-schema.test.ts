// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of the identity tables, as direx_app.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { withSystem, withWorkspace, WorkspacePurging } from "../src/index";
import { organizations, workspaceAudit, workspaceInvites, workspaceMembers, workspaces } from "../src/schema";
import { competitors } from "../src/schema-competitors";
import { withUser } from "../src/user";
import { appClient, insertAuthUser, ownerClient } from "../../../test/db";

let c: pg.Client;
const now = new Date();

function pgCode(e: unknown): string | undefined {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code ?? err.cause?.code;
}

async function newUser() {
  const id = crypto.randomUUID();
  await insertAuthUser(id);
  return id;
}

// The create-Organization path: everything under withWorkspace(the new id), no RETURNING
// on the Organization, since it only becomes readable once its Workspace exists.
async function newWorkspace(owner: string) {
  const orgId = crypto.randomUUID();
  const id = crypto.randomUUID();
  await withWorkspace(id, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: now });
    await tx.insert(workspaces).values({ id, orgId, name: "W", createdAt: now });
    await tx.insert(workspaceMembers).values({ workspaceId: id, userId: owner, role: "owner", createdAt: now });
  });
  return { id, orgId };
}

beforeAll(async () => {
  c = await appClient();
});
afterAll(() => c.end());

test("a new Workspace's workspace_id is its id, and its Organization is readable through it", async () => {
  const u = await newUser();
  const w = await newWorkspace(u);
  const [row] = await withWorkspace(w.id, (tx) => tx.select().from(workspaces));
  expect(row!.workspaceId).toBe(w.id);
  const orgs = await withWorkspace(w.id, (tx) => tx.select().from(organizations));
  expect(orgs.map((o) => o.id)).toEqual([w.orgId]);
});

test("outside any context, no Workspace, member or Organization is visible", async () => {
  const u = await newUser();
  await newWorkspace(u);
  for (const t of ["workspaces", "workspace_members", "organizations", "workspace_invites", "workspace_audit"])
    expect((await c.query(`select * from ${t}`)).rowCount, t).toBe(0);
});

test("a Workspace row can't be written for another workspace id", async () => {
  const u = await newUser();
  const { orgId } = await newWorkspace(u);
  const write = withWorkspace(crypto.randomUUID(), (tx) =>
    tx.insert(workspaces).values({ id: crypto.randomUUID(), orgId, name: "x", createdAt: now }),
  );
  await expect(write).rejects.toSatisfy((e) => pgCode(e) === "42501");
});

test("a Workspace can be renamed but never moved into another Organization, and the app can't write deleted_at", async () => {
  const u = await newUser();
  const w = await newWorkspace(u);
  const other = await newWorkspace(u);
  await withWorkspace(w.id, (tx) => tx.update(workspaces).set({ name: "Renamed" }));
  const [row] = await withWorkspace(w.id, (tx) => tx.select().from(workspaces));
  expect(row!.name).toBe("Renamed");
  const move = withWorkspace(w.id, (tx) => tx.update(workspaces).set({ orgId: other.orgId }));
  await expect(move).rejects.toSatisfy((e) => pgCode(e) === "42501");
  const [after] = await withWorkspace(w.id, (tx) => tx.select().from(workspaces));
  expect(after!.orgId).toBe(w.orgId);
  // ADR 0030 rule 003: a backdated deletion could reach the purge before its 30 days.
  const backdate = withWorkspace(w.id, (tx) => tx.update(workspaces).set({ deletedAt: new Date(0) }));
  await expect(backdate).rejects.toSatisfy((e) => pgCode(e) === "42501");
  expect((await withWorkspace(w.id, (tx) => tx.select().from(workspaces)))[0]!.deletedAt).toBeNull();
});

test("the app can't insert a Workspace already deleted or purging, or delete a Workspace or an Organization", async () => {
  const u = await newUser();
  const w = await newWorkspace(u);
  for (const born of [{ deletedAt: new Date(0) }, { purgingAt: new Date(0) }]) {
    const id = crypto.randomUUID();
    const insert = withWorkspace(id, (tx) => tx.insert(workspaces).values({ id, orgId: w.orgId, name: "Early", createdAt: now, ...born }));
    await expect(insert).rejects.toSatisfy((e) => pgCode(e) === "23514");
  }
  await expect(withWorkspace(w.id, (tx) => tx.delete(workspaces))).rejects.toSatisfy((e) => pgCode(e) === "42501");
  await expect(withWorkspace(w.id, (tx) => tx.delete(organizations))).rejects.toSatisfy((e) => pgCode(e) === "42501");
  await expect(c.query("delete from person_eligibility")).rejects.toSatisfy((e) => pgCode(e) === "42501");
  expect(await withWorkspace(w.id, (tx) => tx.select({ id: workspaces.id }).from(workspaces))).toEqual([{ id: w.id }]);
});

test("withWorkspace refuses a Workspace the purge has marked, and only that one", async () => {
  const u = await newUser();
  const [w, other] = [await newWorkspace(u), await newWorkspace(u)];
  const owner = await ownerClient();
  try {
    await owner.query("update workspaces set deleted_at = now(), purging_at = now() where id = $1", [w.id]);
  } finally {
    await owner.end();
  }
  await expect(withWorkspace(w.id, (tx) => tx.select().from(workspaces))).rejects.toBeInstanceOf(WorkspacePurging);
  expect(await withWorkspace(other.id, (tx) => tx.select({ id: workspaces.id }).from(workspaces))).toEqual([{ id: other.id }]);
  // The mark is the owner's: the app can't set or clear it.
  await expect(withWorkspace(other.id, (tx) => tx.update(workspaces).set({ purgingAt: new Date() }))).rejects.toSatisfy((e) => pgCode(e) === "42501");
});

const softDelete = (inWorkspace: string, workspaceId: string, actor: string) =>
  withWorkspace(inWorkspace, async (tx) => (await tx.execute<{ done: boolean }>(sql`select system.soft_delete_workspace(${workspaceId}::uuid, ${actor}::uuid) as done`)).rows[0]!.done);

test("soft delete stamps the database's time once, records who did it, and refuses another Workspace", async () => {
  const u = await newUser();
  const w = await newWorkspace(u);
  const other = await newWorkspace(u);
  await expect(softDelete(w.id, other.id, u)).rejects.toSatisfy((e) => pgCode(e) === "DX404");

  const before = (await c.query("select now() as t")).rows[0].t as Date;
  expect(await softDelete(w.id, w.id, u)).toBe(true);
  const [row] = await withWorkspace(w.id, (tx) => tx.select().from(workspaces));
  expect(row!.deletedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());
  expect(await softDelete(w.id, w.id, u)).toBe(false);
  expect((await withWorkspace(w.id, (tx) => tx.select().from(workspaces)))[0]!.deletedAt).toEqual(row!.deletedAt);

  const events = await withWorkspace(w.id, (tx) => tx.select().from(workspaceAudit).where(eq(workspaceAudit.event, "workspace.deleted")));
  expect(events).toMatchObject([{ actorUserId: u, stepUp: true, at: row!.deletedAt }]);
  expect((await withWorkspace(other.id, (tx) => tx.select().from(workspaces)))[0]!.deletedAt).toBeNull();
});

test("withWorkspace sees only that Workspace's members; withUser only the user's own", async () => {
  const [u, v] = [await newUser(), await newUser()];
  const w1 = await newWorkspace(u);
  const w2 = await newWorkspace(v);
  await withWorkspace(w2.id, (tx) =>
    tx.insert(workspaceMembers).values({ workspaceId: w2.id, userId: u, role: "viewer", createdAt: now }),
  );

  const inW1 = await withWorkspace(w1.id, (tx) => tx.select().from(workspaceMembers));
  expect(inW1.map((m) => m.userId)).toEqual([u]);

  const mine = await withUser(u, (tx) => tx.select().from(workspaceMembers));
  expect(mine.map((m) => m.workspaceId).sort()).toEqual([w1.id, w2.id].sort());
  expect(mine.every((m) => m.userId === u)).toBe(true);

  const ws = await withUser(u, (tx) => tx.select().from(workspaces));
  expect(ws.map((w) => w.id).sort()).toEqual([w1.id, w2.id].sort());
  const orgs = await withUser(v, (tx) => tx.select().from(organizations));
  expect(orgs.map((o) => o.id)).toEqual([w2.orgId]);
});

test("withWorkspace can't add a member to another Workspace; withUser can't write at all", async () => {
  const u = await newUser();
  const w1 = await newWorkspace(u);
  const w2 = await newWorkspace(u);
  const cross = withWorkspace(w1.id, (tx) =>
    tx.insert(workspaceMembers).values({ workspaceId: w2.id, userId: u, role: "admin", createdAt: now }),
  );
  await expect(cross).rejects.toSatisfy((e) => pgCode(e) === "42501");

  const own = withUser(u, (tx) =>
    tx.insert(workspaceMembers).values({ workspaceId: w1.id, userId: u, role: "admin", createdAt: now }),
  );
  await expect(own).rejects.toSatisfy((e) => pgCode(e) === "25006");
  const update = withUser(u, (tx) =>
    tx.update(workspaceMembers).set({ role: "viewer" }).where(eq(workspaceMembers.userId, u)),
  );
  await expect(update).rejects.toSatisfy((e) => pgCode(e) === "25006");
});

test("the audit takes exactly one actor and is append-only", async () => {
  const u = await newUser();
  const w = await newWorkspace(u);
  const row = { workspaceId: w.id, event: "member.added", at: now };
  await withWorkspace(w.id, (tx) => tx.insert(workspaceAudit).values({ ...row, actorUserId: u }));
  for (const actors of [{}, { actorUserId: u, actorSystem: "test" }]) {
    const bad = withWorkspace(w.id, (tx) => tx.insert(workspaceAudit).values({ ...row, ...actors }));
    await expect(bad).rejects.toSatisfy((e) => pgCode(e) === "23514");
  }
  const upd = withWorkspace(w.id, (tx) => tx.update(workspaceAudit).set({ event: "x" }));
  await expect(upd).rejects.toSatisfy((e) => pgCode(e) === "42501");
  const del = withWorkspace(w.id, (tx) => tx.delete(workspaceAudit));
  await expect(del).rejects.toSatisfy((e) => pgCode(e) === "42501");
});

test("a Workspace holds one pending invite per email; a withdrawn or used one doesn't count", async () => {
  const u = await newUser();
  const w = await newWorkspace(u);
  const invite = (email: string, extra: { revokedAt?: Date; acceptedAt?: Date } = {}) =>
    withWorkspace(w.id, (tx) =>
      tx.insert(workspaceInvites).values({ workspaceId: w.id, email, role: "viewer", tokenHash: crypto.randomUUID(), invitedBy: u, expiresAt: now, createdAt: now, ...extra }),
    );
  await invite("a@example.com", { revokedAt: now });
  await invite("a@example.com", { acceptedAt: now });
  await invite("a@example.com");
  await expect(invite("a@example.com")).rejects.toSatisfy((e) => pgCode(e) === "23505");
  await invite("b@example.com");
});

test("the one-pending-invite migration withdraws all but the newest pending invite, and audits it", async () => {
  const sql = readFileSync(join(import.meta.dirname, "../migrations/0132_invites_one_pending.sql"), "utf8");
  const dedupe = sql.split("--> statement-breakpoint")[0]!;
  const t = await appClient();
  try {
    // Temp tables shadow the real ones for this connection only.
    await t.query("create temp table workspace_invites (id int, workspace_id int, email text, created_at int, accepted_at timestamptz, revoked_at timestamptz)");
    await t.query("create temp table workspace_audit (workspace_id int, event text, subject_email text, actor_system text, at timestamptz)");
    await t.query(`insert into workspace_invites values
      (1, 1, 'a', 1, null, null), (2, 1, 'a', 3, null, null), (3, 1, 'a', 2, null, null),
      (4, 1, 'a', 9, now(), null), (5, 2, 'a', 1, null, null), (6, 1, 'b', 1, null, null)`);
    await t.query(dedupe);
    const { rows } = await t.query("select id from workspace_invites where revoked_at is null and accepted_at is null order by id");
    expect(rows.map((r) => r.id)).toEqual([2, 5, 6]);
    const audit = await t.query("select workspace_id, event, subject_email, actor_system from workspace_audit");
    expect(audit.rows).toEqual([
      { workspace_id: 1, event: "invite.revoked", subject_email: "a", actor_system: "system" },
      { workspace_id: 1, event: "invite.revoked", subject_email: "a", actor_system: "system" },
    ]);
  } finally {
    await t.end();
  }
});

test("withUser rejects a user id that is not a uuid", () => {
  expect(() => withUser("nope", async () => 1)).toThrow(/uuid/);
});

test("the sweeps that find work across Workspaces skip a deleted one", async () => {
  const u = await newUser();
  const [gone, live] = [await newWorkspace(u), await newWorkspace(u)];
  for (const w of [gone, live])
    await withWorkspace(w.id, (tx) =>
      tx.insert(competitors).values({ workspaceId: w.id, name: "Rival", landingUrl: "https://rival.example", createdBy: u, createdAt: now, updatedAt: now }),
    );
  const found = async () => (await withSystem((tx) => tx.execute<{ workspace_id: string }>(sql`select workspace_id from system.competitor_workspaces()`))).rows.map((r) => r.workspace_id);
  expect(await found()).toEqual(expect.arrayContaining([gone.id, live.id]));
  await softDelete(gone.id, gone.id, u);
  expect(await found()).not.toContain(gone.id);
  expect(await found()).toContain(live.id);
});
