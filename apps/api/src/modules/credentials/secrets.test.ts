// SPDX-License-Identifier: AGPL-3.0-only
// The secret store against Postgres as the app role: V1, V2, V6, V8 to V10, V17, useSecret.
import { afterAll, expect, test } from "vitest";
import { masterRootKey } from "./adapters/crypto";
import { createVault, resolverOf } from "./application/secrets";
import { vaultDb } from "./test-helpers";
import { useSecret } from "./use-secret";

const vault = createVault({ rootKey: masterRootKey(Buffer.alloc(32, 7)), now: () => new Date() });
const resolve = resolverOf(vault);
const { q, newUser, addMember, newWorkspace, events, close } = vaultDb();
afterAll(close);

const SAMPLES = {
  api_key: { value: { key: "sk-live-abcdef123456" }, meta: {} },
  header: { value: { value: "Bearer tok-abcdef123456" }, meta: { headerName: "Authorization" } },
  basic: { value: { password: "pw-abcdef123456" }, meta: { username: "a@example.com" } },
  secret: { value: { value: "whsec-abcdef123456" }, meta: {} },
} as const;

async function make(ws: string, actor: string, kind: keyof typeof SAMPLES = "api_key", scope: "workspace" | "user" = "workspace") {
  const r = await vault.create({ workspaceId: ws, actorUserId: actor, scope, kind, key: `k-${crypto.randomUUID()}`, name: "N", ...SAMPLES[kind] });
  if (!r.ok) throw new Error(r.reason);
  return r.credential;
}

test("V1, V5: every kind is stored sealed, resolves to its value, and no response carries it", async () => {
  const { ws, owner } = await newWorkspace();
  for (const kind of Object.keys(SAMPLES) as (keyof typeof SAMPLES)[]) {
    const cred = await make(ws, owner, kind);
    const secret = Object.values(SAMPLES[kind].value)[0]!;
    expect(JSON.stringify(cred), kind).not.toContain(secret);
    expect(cred).not.toHaveProperty("ciphertext");
    const [row] = await q(ws, "select ciphertext, nonce, meta from credentials where id = $1", [cred.id]);
    const stored = Buffer.concat([row.ciphertext, row.nonce]);
    for (const enc of ["utf8", "base64", "hex"] as const) {
      expect(stored.toString(enc), `${kind} ${enc}`).not.toContain(secret);
      expect(stored.toString("latin1"), `${kind} ${enc}`).not.toContain(Buffer.from(secret).toString(enc));
    }
    expect(JSON.stringify(row.meta)).not.toContain(secret);
    expect(await resolve(ws, cred.id, "model_call")).toEqual({ kind, ...SAMPLES[kind] });
  }
});

test("V6: a bad value or secret-looking meta is refused and stores nothing; oauth2 needs the connect flow", async () => {
  const { ws, owner } = await newWorkspace();
  const base = { workspaceId: ws, actorUserId: owner, scope: "workspace" as const, key: "k", name: "N" };
  expect(await vault.create({ ...base, kind: "api_key", value: { key: "" }, meta: {} })).toMatchObject({ ok: false, reason: "bad_value" });
  expect(await vault.create({ ...base, kind: "api_key", value: { key: "x" }, meta: { token: "t" } })).toMatchObject({ ok: false, reason: "bad_meta" });
  expect(await vault.create({ ...base, kind: "oauth2", value: {}, meta: {} })).toMatchObject({ ok: false, reason: "oauth2_needs_connect" });
  expect(await q(ws, "select 1 from credentials")).toHaveLength(0);
  expect(await q(ws, "select 1 from workspace_keys")).toHaveLength(0);
});

test("a key is unique among a Workspace's live secrets, and free again once deleted", async () => {
  const { ws, owner } = await newWorkspace();
  const first = await make(ws, owner);
  const again = { workspaceId: ws, actorUserId: owner, scope: "workspace" as const, kind: "api_key" as const, key: first.key, name: "N", ...SAMPLES.api_key };
  expect(await vault.create(again)).toMatchObject({ ok: false, reason: "duplicate_key" });
  await vault.remove({ workspaceId: ws, id: first.id, actorUserId: owner });
  expect(await vault.create(again)).toMatchObject({ ok: true });
});

test("V8: rotate compares the version, replaces the value and writes a rotate event", async () => {
  const { ws, owner } = await newWorkspace();
  const cred = await make(ws, owner);
  const value = { key: "sk-rotated" };
  expect(await vault.rotate({ workspaceId: ws, id: cred.id, version: cred.version + 1, value, actorUserId: owner })).toMatchObject({
    ok: false,
    reason: "stale_version",
  });
  const r = await vault.rotate({ workspaceId: ws, id: cred.id, version: cred.version, value, actorUserId: owner });
  if (!r.ok) throw new Error(r.reason);
  expect(r.credential.version).toBe(cred.version + 1);
  expect(r.credential.lastRotatedAt).toBeInstanceOf(Date);
  expect(await resolve(ws, cred.id, "model_call")).toEqual({ kind: "api_key", value, meta: {} });
  expect((await events(ws, cred.id)).map((e) => e.consumer)).toEqual(["create", "rotate", "model_call"]);
});

test("V9: a user secret whose owner left resolves to null with a refused event", async () => {
  const { ws, owner } = await newWorkspace();
  const member = await newUser();
  await addMember(ws, member);
  const cred = await make(ws, member, "api_key", "user");
  expect(cred.ownerUserId).toBe(member);
  expect(await resolve(ws, cred.id, "model_call")).not.toBeNull();
  await q(ws, "delete from workspace_members where user_id = $1", [member]);
  expect(await resolve(ws, cred.id, "model_call")).toBeNull();
  expect((await events(ws, cred.id)).at(-1)).toEqual({ consumer: "model_call", outcome: "refused", error_code: "owner_left" });
  expect(owner).not.toBe(member);
});

test("V10: delete nulls the ciphertext, resolve returns null and the history stays", async () => {
  const { ws, owner } = await newWorkspace();
  const cred = await make(ws, owner);
  expect(await vault.remove({ workspaceId: ws, id: cred.id, actorUserId: owner })).toEqual({ ok: true });
  const [row] = await q(ws, "select ciphertext, nonce, deleted_at from credentials where id = $1", [cred.id]);
  expect(row).toMatchObject({ ciphertext: null, nonce: null });
  expect(row.deleted_at).toBeInstanceOf(Date);
  expect(await resolve(ws, cred.id, "model_call")).toBeNull();
  expect(await vault.remove({ workspaceId: ws, id: cred.id, actorUserId: owner })).toMatchObject({ reason: "missing" });
  expect(await events(ws, cred.id)).toEqual([
    { consumer: "create", outcome: "ok", error_code: null },
    { consumer: "delete", outcome: "ok", error_code: null },
    { consumer: "model_call", outcome: "refused", error_code: "deleted" },
  ]);
});

test("V2: a ciphertext copied to another row, here or in another Workspace, does not decrypt", async () => {
  const a = await newWorkspace();
  const b = await newWorkspace();
  const src = await make(a.ws, a.owner);
  const sameWs = await make(a.ws, a.owner);
  const otherWs = await make(b.ws, b.owner);
  const [row] = await q(a.ws, "select ciphertext, nonce from credentials where id = $1", [src.id]);
  for (const [ws, id] of [[a.ws, sameWs.id], [b.ws, otherWs.id]] as const) {
    await q(ws, "update credentials set ciphertext = $1, nonce = $2 where id = $3", [row.ciphertext, row.nonce, id]);
    expect(await resolve(ws, id, "execute")).toBeNull();
    expect((await events(ws, id)).at(-1)).toEqual({ consumer: "execute", outcome: "error", error_code: "decrypt_failed" });
  }
});

test("V17: each resolve writes one event; an id this Workspace does not hold returns null", async () => {
  const a = await newWorkspace();
  const b = await newWorkspace();
  const cred = await make(a.ws, a.owner);
  for (let i = 0; i < 3; i++) await resolve(a.ws, cred.id, "query");
  expect(await events(a.ws, cred.id)).toHaveLength(4);
  expect(await resolve(b.ws, cred.id, "query")).toBeNull();
  expect(await resolve(a.ws, crypto.randomUUID(), "query")).toBeNull();
  expect(await events(a.ws, cred.id)).toHaveLength(4);
});

test("useSecret hands the value to fn only, and skips fn when the credential cannot be used", async () => {
  const { ws, owner } = await newWorkspace();
  const cred = await make(ws, owner);
  expect(await useSecret(vault, ws, cred.id, "model_call", async (v) => ("key" in v ? v.key.length : 0))).toBe(20);
  await vault.remove({ workspaceId: ws, id: cred.id, actorUserId: owner });
  let called = false;
  expect(await useSecret(vault, ws, cred.id, "model_call", async () => (called = true))).toBeNull();
  expect(called).toBe(false);
});

test("two concurrent first writes in a Workspace share one data key", async () => {
  const { ws, owner } = await newWorkspace();
  const fresh = createVault({ rootKey: masterRootKey(Buffer.alloc(32, 7)), now: () => new Date() });
  const made = await Promise.all([0, 1].map(() => fresh.create({ workspaceId: ws, actorUserId: owner, scope: "workspace", kind: "api_key", key: crypto.randomUUID(), name: "N", ...SAMPLES.api_key })));
  expect(made.every((m) => m.ok)).toBe(true);
  expect(await q(ws, "select key_version from workspace_keys")).toEqual([{ key_version: 1 }]);
  for (const m of made) if (m.ok) expect(await resolve(ws, m.credential.id, "query")).not.toBeNull();
});
