// SPDX-License-Identifier: AGPL-3.0-only
// Organizations, the Workspace list and the request context (I4, I5, the 404 rule).
import { expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { testIdentity } from "./test-auth";

const { signIn, call, createOrg, addMember } = testIdentity();

test("I4: a signed-in user creates an Organization and becomes Owner of its first Workspace", async () => {
  const cookie = await signIn();
  const created = await createOrg(cookie);
  expect(created.workspace.role).toBe("owner");

  const ws = await call(`/api/w/${created.workspace.id}`, cookie);
  expect(ws.status).toBe(200);
  expect(await ws.json()).toEqual({ workspace: { id: created.workspace.id, name: "Acme marketing", role: "owner" } });
});

test("I5: /api/me/workspaces lists exactly the caller's Workspaces", async () => {
  const [a, b] = [await signIn(), await signIn()];
  const a1 = await createOrg(a, "Alpha");
  const a2 = await createOrg(a, "Beta");
  await createOrg(b, "Other");

  const res = await call("/api/me/workspaces", a);
  const { workspaces } = (await res.json()) as { workspaces: { id: string; role: string; organization: { name: string } }[] };
  expect(workspaces.map((w) => w.id).sort()).toEqual([a1.workspace.id, a2.workspace.id].sort());
  expect(workspaces.map((w) => w.organization.name).sort()).toEqual(["Alpha", "Beta"]);
  expect(workspaces.every((w) => w.role === "owner")).toBe(true);
});

test("/api/me/deleted-workspaces lists only the caller's deleted Workspaces where they are Owner, until the purge starts", async () => {
  const [a, b] = [await signIn(), await signIn()];
  const live = await createOrg(a, "Live");
  const gone = await createOrg(a, "Gone");
  const purging = await createOrg(a, "Purging");
  const theirs = await createOrg(b, "Theirs");
  // An Admin of a deleted Workspace does not get its export, so it is not listed for them.
  const admin = await addMember(a, gone.workspace.id, "admin");
  for (const [cookie, id] of [[a, gone.workspace.id], [a, purging.workspace.id], [b, theirs.workspace.id]] as const)
    expect((await call(`/api/w/${id}`, cookie, { method: "DELETE" })).status).toBe(200);
  const db = await ownerClient();
  await db.query(`update workspaces set purging_at = now() where id = $1`, [purging.workspace.id]).finally(() => db.end());

  const res = await call("/api/me/deleted-workspaces", a);
  expect(res.status).toBe(200);
  const { workspaces } = (await res.json()) as { workspaces: { id: string; name: string; organization: { name: string }; deletedAt: string; purgeFrom: string }[] };
  expect(workspaces.map((w) => w.id)).toEqual([gone.workspace.id]);
  const [w] = workspaces;
  expect(w!.name).toBe("Gone marketing");
  expect(w!.organization.name).toBe("Gone");
  expect(Date.now() - Date.parse(w!.deletedAt)).toBeLessThan(60_000);
  expect(Date.parse(w!.purgeFrom) - Date.parse(w!.deletedAt)).toBe(30 * 86_400_000);
  expect(workspaces.map((x) => x.id)).not.toContain(live.workspace.id);

  const forAdmin = (await (await call("/api/me/deleted-workspaces", admin.cookie)).json()) as { workspaces: unknown[] };
  expect(forAdmin.workspaces).toEqual([]);
  const forB = (await (await call("/api/me/deleted-workspaces", b)).json()) as { workspaces: { id: string }[] };
  expect(forB.workspaces.map((x) => x.id)).toEqual([theirs.workspace.id]);
  expect((await call("/api/me/deleted-workspaces")).status).toBe(401);
});

test("a Workspace the caller is not a member of is 404, as is a malformed id", async () => {
  const [a, b] = [await signIn(), await signIn()];
  const theirs = await createOrg(b);
  expect((await call(`/api/w/${theirs.workspace.id}`, a)).status).toBe(404);
  expect((await call(`/api/w/${crypto.randomUUID()}`, a)).status).toBe(404);
  expect((await call("/api/w/not-a-uuid", a)).status).toBe(404);
});

test("without a session every identity route is 401", async () => {
  const b = await signIn();
  const { workspace } = await createOrg(b);
  expect((await call("/api/me/workspaces")).status).toBe(401);
  expect((await call("/api/orgs", undefined, { method: "POST", body: { name: "x", workspaceName: "y" } })).status).toBe(401);
  expect((await call(`/api/w/${workspace.id}`)).status).toBe(401);
});

test("names are required", async () => {
  const cookie = await signIn();
  const res = await call("/api/orgs", cookie, { method: "POST", body: { name: " ", workspaceName: "y" } });
  expect(res.status).toBe(400);
});
