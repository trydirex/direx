// SPDX-License-Identifier: AGPL-3.0-only
// When a token's creator stops being an Owner or Admin, each of their live tokens gets one audit row
// and the remaining Owners and Admins one email naming them (ADR 0032 rules 005 and 011, Q9). Last,
// the same through the app main.ts builds, where a role change or removal in Members does it.
import { beforeAll, expect, test } from "vitest";
import { app } from "../../main";
import { adminEmails, logMailer, type Mail } from "../identity/index";
import { TEST_SECRET, testIdentity } from "../identity/test-auth";
import { seedWorkspace, setRole, tokenAudit } from "./fixtures/members";
import { createStops, createTokens } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
process.env.DIREX_MASTER_KEY = "11".repeat(32);

const W = crypto.randomUUID();
const owner = crypto.randomUUID();
const at = new Date("2026-11-16T09:00:00Z");
const tokens = createTokens({ maxDays: null, now: () => at });
const outbox: Mail[] = [];
const stopped = createStops({ mailer: logMailer(outbox), adminEmails, now: () => at });

beforeAll(() => seedWorkspace(W, owner));

async function adminWith(...names: string[]) {
  const admin = crypto.randomUUID();
  await setRole(W, admin, "admin");
  const ids: string[] = [];
  for (const name of names) {
    const r = await tokens.create(W, { name, days: 7, readers: ["read_changes"], kinds: [] }, admin);
    if (!r.ok) throw new Error(r.reason);
    ids.push(r.id);
  }
  return { admin, ids };
}
const stopsFor = async (ids: string[]) => (await tokenAudit(W)).filter((a) => ids.includes(a.tokenId!) && a.event === "external_token.stopped");

test("a demoted Admin's live tokens each get one stop row, and the Owners and Admins one email naming them", async () => {
  const { admin, ids } = await adminWith("Zapier", "Nightly script");
  const revoked = await tokens.create(W, { name: "Old", days: 7, readers: [], kinds: [] }, admin);
  if (!revoked.ok) throw new Error(revoked.reason);
  await tokens.revoke(W, revoked.id, owner);
  outbox.length = 0;

  await setRole(W, admin, "marketer");
  await stopped(W, admin, "admin", "marketer");

  // Both tokens are made at the same instant, so the order between them isn't fixed.
  const byToken = (a: { tokenId: string | null }, b: { tokenId: string | null }) => a.tokenId!.localeCompare(b.tokenId!);
  expect((await stopsFor([...ids, revoked.id])).sort(byToken)).toEqual(ids.map((tokenId) => ({ event: "external_token.stopped", tokenId, actor: null, stepUp: false })).sort(byToken));
  expect(outbox.map((m) => m.to)).toEqual(await adminEmails(W));
  expect(outbox[0]!.subject).toBe("2 External tokens stopped working");
  expect(outbox[0]!.text).toContain('"Zapier"');
  expect(outbox[0]!.text).toContain('"Nightly script"');
  expect(outbox[0]!.text).not.toContain('"Old"');
});

test("a removal stops tokens the same way", async () => {
  const { admin, ids } = await adminWith("CRM sync");
  outbox.length = 0;
  await setRole(W, admin, null);
  await stopped(W, admin, "admin", null);
  expect(await stopsFor(ids)).toHaveLength(1);
  expect(outbox[0]!.subject).toBe("An External token stopped working");
});

test("nothing is written or sent when the member keeps the permission, never had it, or has no live tokens", async () => {
  const { admin, ids } = await adminWith("Kept");
  outbox.length = 0;
  await setRole(W, admin, "owner");
  await stopped(W, admin, "admin", "owner");
  await stopped(W, admin, "marketer", "contributor");
  await stopped(W, crypto.randomUUID(), "admin", null);
  expect(await stopsFor(ids)).toEqual([]);
  expect(outbox).toEqual([]);
});

test("in the app main.ts builds, demoting or removing a token's maker in Members stops their tokens", async () => {
  const site = testIdentity();
  const owner = await site.signIn();
  const w = (await site.createOrg(owner, "Stops")).workspace.id;
  const live = createTokens({ maxDays: null });
  const made = async (userId: string) => {
    const r = await live.create(w, { name: "Script", days: 7, readers: ["read_changes"], kinds: [] }, userId);
    if (!r.ok) throw new Error(r.reason);
    return r;
  };
  const stoppedIn = async (id: string) => (await tokenAudit(w)).filter((a) => a.tokenId === id && a.event === "external_token.stopped");
  const send = (path: string, method: string, body?: unknown) =>
    app.request(path, { method, headers: { cookie: owner, ...(body !== undefined && { "content-type": "application/json" }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });

  for (const [how, request] of [
    ["demoted", (userId: string) => send(`/api/w/${w}/members/${userId}`, "PATCH", { role: "marketer" })],
    ["removed", (userId: string) => send(`/api/w/${w}/members/${userId}`, "DELETE")],
  ] as const) {
    const admin = await site.addMember(owner, w, "admin");
    const t = await made(admin.userId);
    expect(await live.verify(w, t.token), how).not.toBeNull();
    expect((await request(admin.userId)).status, how).toBe(200);
    expect(await stoppedIn(t.id), how).toHaveLength(1);
    expect(await live.verify(w, t.token), how).toBeNull();
  }
});
