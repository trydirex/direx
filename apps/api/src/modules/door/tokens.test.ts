// SPDX-License-Identifier: AGPL-3.0-only
// External tokens through the application, against the database: made once, listed without the
// secret, revoked by anyone, and accepted only while live, in their own Workspace, with their creator
// still an Owner or Admin (ADR 0032 rules 005 and 011).
import { beforeAll, expect, test } from "vitest";
import { seedWorkspace, setRole, tokenAudit } from "./fixtures/members";
import { createTokens } from "./index";

const W = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const owner = crypto.randomUUID();
const admin = crypto.randomUUID();
const viewer = crypto.randomUUID();
let clock = new Date("2026-11-16T09:00:00Z");
const tokens = createTokens({ maxDays: null, now: () => clock });
const input = { name: "Zapier", days: 30, readers: ["read_changes"], kinds: ["fact_proposal"] };

beforeAll(async () => {
  await seedWorkspace(W, owner);
  await seedWorkspace(OTHER, crypto.randomUUID());
  await setRole(W, admin, "admin");
  await setRole(W, viewer, "viewer");
});

async function made(by = owner, i = input) {
  const r = await tokens.create(W, i, by);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

test("create refuses a bad name, lifetime, reader or kind, each with its own reason", async () => {
  expect(await tokens.create(W, { ...input, name: "  " }, owner)).toEqual({ ok: false, reason: "bad_name" });
  expect(await tokens.create(W, { ...input, name: "x".repeat(61) }, owner)).toEqual({ ok: false, reason: "bad_name" });
  expect(await tokens.create(W, { ...input, days: 180 }, owner)).toEqual({ ok: false, reason: "bad_lifetime" });
  expect(await tokens.create(W, { ...input, readers: ["read_vault"] }, owner)).toEqual({ ok: false, reason: "unknown_reader" });
  expect(await tokens.create(W, { ...input, kinds: ["action_proposal"] }, owner)).toEqual({ ok: false, reason: "unknown_kind" });
  expect(await tokens.create(W, { ...input, kinds: ["rule_proposal"] }, owner)).toEqual({ ok: false, reason: "unknown_kind" });
});

test("a self-hosted operator's longer lifetime is offered and accepted", async () => {
  const longer = createTokens({ maxDays: 365, now: () => clock });
  expect(longer.lifetimes()).toEqual([7, 30, 90, 180, 365]);
  const r = await longer.create(W, { ...input, days: 365 }, owner);
  expect(r.ok && r.expiresAt.toISOString()).toBe("2027-11-16T09:00:00.000Z");
});

test("the token comes back once; the list never holds it or its hash", async () => {
  const r = await made();
  expect(r.token).toMatch(/^dxt_[A-Za-z0-9_-]{43}$/);
  expect(r.expiresAt.toISOString()).toBe("2026-12-16T09:00:00.000Z");
  const listed = await tokens.list(W);
  const row = listed.find((t) => t.id === r.id)!;
  expect(row).toMatchObject({ name: "Zapier", hint: r.token.slice(4, 8), readers: ["read_changes"], kinds: ["fact_proposal"], createdBy: owner, state: "live" });
  expect(JSON.stringify(listed)).not.toContain(r.token.slice(4));
  expect(Object.keys(row)).not.toContain("tokenHash");
});

test("a live token verifies as its own caller, with no user, role or sign-in", async () => {
  const r = await made();
  expect(await tokens.verify(W, r.token)).toEqual({ tokenId: r.id, workspaceId: W, name: "Zapier", readers: ["read_changes"], kinds: ["fact_proposal"] });
});

test("a wrong, malformed or other Workspace's token finds nothing", async () => {
  const r = await made();
  expect(await tokens.verify(W, r.token.slice(0, -1) + (r.token.endsWith("A") ? "B" : "A"))).toBeNull();
  expect(await tokens.verify(W, "Bearer " + r.token)).toBeNull();
  expect(await tokens.verify(OTHER, r.token)).toBeNull();
  expect(await tokens.verify("not-a-workspace", r.token)).toBeNull();
});

test("any Member revokes, once; revoking again changes nothing", async () => {
  const r = await made();
  expect(await tokens.revoke(W, r.id, viewer)).toBe(true);
  expect(await tokens.revoke(W, r.id, owner)).toBe(true);
  expect(await tokens.verify(W, r.token)).toBeNull();
  expect((await tokens.list(W)).find((t) => t.id === r.id)).toMatchObject({ state: "revoked", revokedBy: viewer });
  expect(await tokens.revoke(W, crypto.randomUUID(), viewer)).toBe(false);
  expect(await tokens.revoke(W, "nope", viewer)).toBe(false);
  expect((await tokenAudit(W)).filter((a) => a.tokenId === r.id)).toEqual([
    { event: "external_token.created", tokenId: r.id, actor: owner, stepUp: true },
    { event: "external_token.revoked", tokenId: r.id, actor: viewer, stepUp: false },
  ]);
});

test("an expired token stops", async () => {
  const r = await made();
  const was = clock;
  clock = new Date(r.expiresAt.getTime());
  try {
    expect(await tokens.verify(W, r.token)).toBeNull();
    expect((await tokens.list(W)).find((t) => t.id === r.id)?.state).toBe("expired");
  } finally {
    clock = was;
  }
});

test("a token stops while its creator isn't an Owner or Admin, and starts again when they are", async () => {
  const r = await made(admin);
  expect(await tokens.verify(W, r.token)).not.toBeNull();
  await setRole(W, admin, "marketer");
  expect(await tokens.verify(W, r.token)).toBeNull();
  expect((await tokens.list(W)).find((t) => t.id === r.id)?.state).toBe("stopped");
  await setRole(W, admin, null);
  expect(await tokens.verify(W, r.token)).toBeNull();
  await setRole(W, admin, "admin");
  expect(await tokens.verify(W, r.token)).not.toBeNull();
});

test("a use is recorded at most once a minute", async () => {
  const r = await made();
  const used = async () => (await tokens.list(W)).find((t) => t.id === r.id)?.lastUsedAt?.toISOString();
  const was = clock;
  try {
    await tokens.verify(W, r.token);
    expect(await used()).toBe(was.toISOString());
    clock = new Date(was.getTime() + 59_000);
    await tokens.verify(W, r.token);
    expect(await used()).toBe(was.toISOString());
    clock = new Date(was.getTime() + 61_000);
    await tokens.verify(W, r.token);
    expect(await used()).toBe(clock.toISOString());
  } finally {
    clock = was;
  }
});
