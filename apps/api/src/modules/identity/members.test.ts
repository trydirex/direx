// SPDX-License-Identifier: AGPL-3.0-only
// Members, invites, audit and step-up (I6 to I10), all through the routes.
import { afterEach, expect, test, vi } from "vitest";
import { createBoss } from "../../jobs/boss";
import { testIdentity } from "./test-auth";

const { signIn, call, createOrg, inviteToken, addMember, outbox } = testIdentity();
const MIN = 60_000;

afterEach(() => {
  vi.useRealTimers();
});

async function invite(cookie: string, workspaceId: string, role = "marketer", email = `${crypto.randomUUID()}@example.com`) {
  const res = await call(`/api/w/${workspaceId}/invites`, cookie, { method: "POST", body: { email, role } });
  return { res, email };
}
const accept = (cookie: string, workspaceId: string, token: string) =>
  call("/api/invites/accept", cookie, { method: "POST", body: { workspaceId, token } });

test("I6, I7: an invite is accepted once, by its own email, into its own Workspace", async () => {
  const owner = await signIn();
  const { workspace } = await createOrg(owner);
  const { res, email } = await invite(owner, workspace.id, "contributor");
  expect(res.status).toBe(201);
  const token = inviteToken(email);

  const stranger = await signIn();
  expect((await accept(stranger, workspace.id, token)).status).toBe(403);
  const other = await createOrg(stranger);
  expect((await accept(stranger, other.workspace.id, token)).status).toBe(404);

  const invitee = await signIn(email.toUpperCase());
  const ok = await accept(invitee, workspace.id, token);
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ workspace: { id: workspace.id, role: "contributor" } });
  expect((await call(`/api/w/${workspace.id}`, invitee)).status).toBe(200);
  expect(await (await accept(invitee, workspace.id, token)).json()).toEqual({ error: "accepted" });

  const { members } = (await (await call(`/api/w/${workspace.id}/members`, owner)).json()) as { members: { email: string; role: string }[] };
  expect(members.map((m) => m.role).sort()).toEqual(["contributor", "owner"]);
});

const preview = (cookie: string, workspaceId: string, token: string) =>
  call("/api/invites/preview", cookie, { method: "POST", body: { workspaceId, token } });

test("the invite page names the Workspace and who sent it, only for the invited address, and says when it can't be used", async () => {
  const owner = await signIn();
  const { workspace } = await createOrg(owner, "Rota");
  const { email } = await invite(owner, workspace.id);
  const token = inviteToken(email);
  const invitee = await signIn(email);

  const ok = await preview(invitee, workspace.id, token);
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { workspace: { name: string }; invitedBy: string };
  expect(body.workspace.name).toBe("Rota marketing");
  // A magic-link sign-up has no name yet, so the inviter shows as their email.
  const me = (await (await call("/api/me", owner)).json()) as { user: { name: string; email: string } };
  expect(body.invitedBy).toBe(me.user.name || me.user.email);

  expect((await preview(invitee, workspace.id, "0".repeat(64))).status).toBe(404);
  expect(await (await preview(await signIn(), workspace.id, token)).json()).toEqual({ error: "wrong_email" });
  expect((await call("/api/invites/preview", undefined, { method: "POST", body: { workspaceId: workspace.id, token } })).status).toBe(401);
  // Looking writes nothing: the invite still works, and afterwards the page says it was used.
  expect((await accept(invitee, workspace.id, token)).status).toBe(200);
  expect(await (await preview(invitee, workspace.id, token)).json()).toEqual({ error: "accepted" });
});

test("I6: a revoked or expired invite can't be accepted", async () => {
  const owner = await signIn();
  const { workspace } = await createOrg(owner);

  const revoked = await invite(owner, workspace.id);
  const { invite: r } = (await revoked.res.json()) as { invite: { id: string } };
  expect((await call(`/api/w/${workspace.id}/invites/${r.id}`, owner, { method: "DELETE" })).status).toBe(200);
  const a = await signIn(revoked.email);
  expect(await (await accept(a, workspace.id, inviteToken(revoked.email))).json()).toEqual({ error: "revoked" });

  const old = await invite(owner, workspace.id);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 8 * 24 * 60 * MIN);
  const b = await signIn(old.email);
  expect(await (await accept(b, workspace.id, inviteToken(old.email))).json()).toEqual({ error: "expired" });
});

test("I6: inviting the same email again, in any case, resends the one pending invite with a new link", async () => {
  const owner = await signIn();
  const { workspace } = await createOrg(owner);
  const first = await invite(owner, workspace.id, "viewer");
  expect(first.res.status).toBe(201);
  const { invite: created, resent } = (await first.res.json()) as { invite: { id: string }; resent: boolean };
  expect(resent).toBe(false);
  const oldToken = inviteToken(first.email);

  const again = await invite(owner, workspace.id, "marketer", first.email.toUpperCase());
  expect(again.res.status).toBe(200);
  expect(await again.res.json()).toMatchObject({ resent: true, invite: { id: created.id, email: first.email, role: "marketer" } });
  expect(outbox.filter((m) => m.to === first.email)).toHaveLength(2);

  const { invites } = (await (await call(`/api/w/${workspace.id}/invites`, owner)).json()) as { invites: { email: string; role: string }[] };
  expect(invites.map((i) => [i.email, i.role])).toEqual([[first.email, "marketer"]]);
  const invitee = await signIn(first.email);
  expect((await accept(invitee, workspace.id, oldToken)).status).toBe(404);
  expect(await (await accept(invitee, workspace.id, inviteToken(first.email))).json()).toEqual({ workspace: { id: workspace.id, role: "marketer" } });
});

test("I8: each route checks its permission", async () => {
  const owner = await signIn();
  const { workspace } = await createOrg(owner);
  const w = workspace.id;
  const admin = await addMember(owner, w, "admin");
  const marketer = await addMember(owner, w, "marketer");
  const contributor = await addMember(owner, w, "contributor");
  const viewer = await addMember(owner, w, "viewer");

  expect((await call(`/api/w/${w}/members`, viewer.cookie)).status).toBe(200);
  expect((await invite(viewer.cookie, w)).res.status).toBe(403);
  expect((await invite(marketer.cookie, w)).res.status).toBe(403);
  expect((await invite(admin.cookie, w, "marketer")).res.status).toBe(201);
  expect(await (await invite(admin.cookie, w, "owner")).res.json()).toEqual({ error: "admin_cannot_manage_owner" });
  expect((await call(`/api/w/${w}/invites`, marketer.cookie)).status).toBe(403);
  expect((await call(`/api/w/${w}/audit`, contributor.cookie)).status).toBe(403);

  const patch = (cookie: string, userId: string, role: string) =>
    call(`/api/w/${w}/members/${userId}`, cookie, { method: "PATCH", body: { role } });
  expect((await patch(contributor.cookie, viewer.userId, "marketer")).status).toBe(403);
  expect((await patch(admin.cookie, viewer.userId, "marketer")).status).toBe(200);
  const ownerId = ((await (await call("/api/me", owner)).json()) as { user: { id: string } }).user.id;
  expect(await (await patch(admin.cookie, ownerId, "admin")).json()).toEqual({ error: "admin_cannot_manage_owner" });
  expect(await (await patch(owner, ownerId, "admin")).json()).toEqual({ error: "last_owner" });
  expect((await call(`/api/w/${w}/members/${ownerId}`, owner, { method: "DELETE" })).status).toBe(409);

  expect((await call(`/api/w/${w}`, admin.cookie, { method: "DELETE" })).status).toBe(403);
  expect((await call(`/api/w/${w}`, owner, { method: "DELETE" })).status).toBe(200);
  expect((await call(`/api/w/${w}`, owner)).status).toBe(404);
});

test("I9: membership changes are audited with their actor", async () => {
  const owner = await signIn();
  const { workspace } = await createOrg(owner);
  const m = await addMember(owner, workspace.id, "viewer");
  await call(`/api/w/${workspace.id}/members/${m.userId}`, owner, { method: "PATCH", body: { role: "marketer" } });
  await call(`/api/w/${workspace.id}/members/${m.userId}`, owner, { method: "DELETE" });

  const { entries } = (await (await call(`/api/w/${workspace.id}/audit`, owner)).json()) as {
    entries: { event: string; actorUserId: string | null; fromRole: string | null; toRole: string | null; stepUp: boolean }[];
  };
  expect(entries.map((e) => e.event).reverse()).toEqual([
    "workspace.created",
    "invite.created",
    "member.added",
    "invite.accepted",
    "member.role_changed",
    "member.removed",
  ]);
  expect(entries.every((e) => e.actorUserId)).toBe(true);
  expect(entries[1]).toMatchObject({ fromRole: "viewer", toRole: "marketer", stepUp: true });
});

test("I10: elevated actions need a sign-in in the last 10 minutes, and a session refresh doesn't count", async () => {
  const owner = await signIn();
  const { workspace } = await createOrg(owner);
  const m = await addMember(owner, workspace.id, "viewer");
  const patch = (cookie: string) =>
    call(`/api/w/${workspace.id}/members/${m.userId}`, cookie, { method: "PATCH", body: { role: "marketer" } });

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 11 * MIN);
  expect(await (await patch(owner)).json()).toEqual({ error: "step_up_required" });

  // Past Better Auth's one-day updateAge, reading the session refreshes it.
  vi.setSystemTime(Date.now() + 2 * 24 * 60 * MIN);
  expect((await call(`/api/w/${workspace.id}`, owner)).status).toBe(200);
  expect(await (await patch(owner)).json()).toEqual({ error: "step_up_required" });

  const ownerEmail = ((await (await call("/api/me", owner)).json()) as { user: { email: string } }).user.email;
  const fresh = await signIn(ownerEmail);
  expect((await patch(fresh)).status).toBe(200);
});

test("deleting a Workspace cancels its queued jobs and leaves another Workspace's (ADR 0030 rule 007)", async () => {
  const owner = await signIn();
  const [a, b] = [(await createOrg(owner)).workspace.id, (await createOrg(owner, "Other")).workspace.id];
  const boss = createBoss({ consume: false });
  await boss.start();
  try {
    await boss.createQueue("identity_soft_delete");
    const later = { startAfter: new Date(Date.now() + 60 * MIN) };
    const mine = await boss.send("identity_soft_delete", { workspaceId: a }, later);
    const theirs = await boss.send("identity_soft_delete", { workspaceId: b }, later);
    expect((await call(`/api/w/${a}`, owner, { method: "DELETE" })).status).toBe(200);
    expect((await boss.getJobById("identity_soft_delete", mine!))?.state).toBe("cancelled");
    expect((await boss.getJobById("identity_soft_delete", theirs!))?.state).toBe("created");
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
});

test("a role change or removal tells onMemberChange after it commits, and a failing one still answers 200", async () => {
  const told = vi.fn((..._: unknown[]) => Promise.reject(new Error("mail is down")));
  const site = testIdentity({ onMemberChange: told });
  const owner = await site.signIn();
  const { workspace } = await site.createOrg(owner);
  const w = workspace.id;
  const admin = await site.addMember(owner, w, "admin");
  const at = `/api/w/${w}/members/${admin.userId}`;

  vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect((await site.call(at, owner, { method: "PATCH", body: { role: "marketer" } })).status).toBe(200);
  expect(told).toHaveBeenLastCalledWith(w, admin.userId, "admin", "marketer");
  const members = (await (await site.call(`/api/w/${w}/members`, owner)).json()) as { members: { userId: string; role: string }[] };
  expect(members.members.find((m) => m.userId === admin.userId)?.role).toBe("marketer");

  // No change, and a refused change, tell nothing.
  expect((await site.call(at, owner, { method: "PATCH", body: { role: "marketer" } })).status).toBe(200);
  expect((await site.call(at, admin.cookie, { method: "PATCH", body: { role: "owner" } })).status).toBe(403);
  expect(told).toHaveBeenCalledTimes(1);

  expect((await site.call(at, owner, { method: "DELETE" })).status).toBe(200);
  expect(told).toHaveBeenLastCalledWith(w, admin.userId, "marketer", null);
  expect(console.error).toHaveBeenCalledWith("after a membership change", expect.any(Error));
});
