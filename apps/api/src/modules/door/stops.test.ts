// SPDX-License-Identifier: AGPL-3.0-only
// When a token's creator stops being an Owner or Admin, each of their live tokens gets one audit row
// and the remaining Owners and Admins one email naming them (ADR 0032 rules 005 and 011, Q9).
import { beforeAll, expect, test } from "vitest";
import { adminEmails, logMailer, type Mail } from "../identity/index";
import { seedWorkspace, setRole, tokenAudit } from "./fixtures/members";
import { createStops, createTokens } from "./index";

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
