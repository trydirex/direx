// SPDX-License-Identifier: AGPL-3.0-only
// Replacing the root key, against a real database. One deployment row per test database, so
// these run in order: a replacement, then the ways one is refused.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { runReplaceRootKey } from "../../secrets";
import { masterRootKey, rootKeyFromEnv, type RootKey } from "./adapters/crypto";
import { createVault, resolverOf } from "./application/secrets";
import { ensureRootKey, replaceRootKey, rootKeyProblem } from "./index";
import { vaultDb } from "./test-helpers";

const { q, newWorkspace, close } = vaultDb();
afterAll(close);

const OLD = { DIREX_MASTER_KEY: "ab".repeat(32) };
const newFile = join(mkdtempSync(join(tmpdir(), "direx-replace-")), "keys", "new.key");
const NEW = { DIREX_MASTER_KEY_FILE: newFile };
const vaultOf = (rootKey: RootKey) => createVault({ rootKey, now: () => new Date() });
const recorded = async () => (await q(crypto.randomUUID(), "select root_key_id from deployment_root_key"))[0]?.root_key_id;

async function seal(rootKey: RootKey, secret: string) {
  const { ws, owner } = await newWorkspace();
  const r = await vaultOf(rootKey).create({ workspaceId: ws, actorUserId: owner, scope: "workspace", kind: "api_key", key: "k", name: "N", value: { key: secret }, meta: {} });
  if (!r.ok) throw new Error(r.reason);
  return { ws, id: r.credential.id };
}

const run = async (args: string[], env: Record<string, string>) => {
  const lines: string[] = [];
  const code = await runReplaceRootKey(args, env, (l) => lines.push(l));
  return { code, text: lines.join("\n") };
};

test("without exactly one file it prints the usage and changes nothing", async () => {
  const old = await ensureRootKey(OLD);
  expect((await run([], OLD)).code).toBe(2);
  expect((await run([newFile, "extra"], OLD)).text).toContain("usage: secrets replace-root-key");
  expect(await recorded()).toBe(old.id);
  expect(() => statSync(newFile)).toThrow();
});

test("it generates the new key, rewraps every Workspace, and only the new key opens the vault afterwards", async () => {
  const old = rootKeyFromEnv(OLD);
  const a = await seal(old, "first-value");
  const b = await seal(old, "second-value");
  await vaultOf(old).approvalKeys(a.ws);

  const done = await run([newFile], OLD);
  expect(done.code).toBe(0);
  expect(done.text).toContain("Workspaces rewrapped: 2");
  expect(done.text).toContain(newFile);
  expect(statSync(newFile).mode & 0o777).toBe(0o600);
  expect(done.text).not.toContain(readFileSync(newFile, "utf8").trim());
  expect(done.text).not.toContain(OLD.DIREX_MASTER_KEY);

  const next = rootKeyFromEnv(NEW);
  expect(await recorded()).toBe(next.id);
  expect(await rootKeyProblem(NEW)).toBeNull();
  const resolve = resolverOf(vaultOf(next));
  expect((await resolve(a.ws, a.id, "model_call"))?.value).toEqual({ key: "first-value" });
  expect((await resolve(b.ws, b.id, "model_call"))?.value).toEqual({ key: "second-value" });
  expect((await vaultOf(next).approvalKeys(a.ws)).current.id).toMatch(/^ak-/);

  await expect(ensureRootKey(OLD)).rejects.toThrow(next.id);
  await expect(resolverOf(vaultOf(old))(a.ws, a.id, "model_call")).rejects.toThrow(/wrapped by root key/);
});

test("the old key can't run it twice, and a key can't replace itself", async () => {
  const again = await run([newFile], OLD);
  expect(again.code).toBe(1);
  expect(again.text).toContain("Root key not replaced: this deployment runs with root key");
  const self = await run([newFile], NEW);
  expect(self.code).toBe(1);
  expect(self.text).toContain("already in use");
});

test("a run that stopped partway is finished by running it again", async () => {
  const current = rootKeyFromEnv(NEW);
  const third = masterRootKey(Buffer.alloc(32, 3));
  const waiting = await seal(current, "waiting-value");
  // What an earlier, interrupted run left behind: one Workspace already under the next key.
  const moved = await seal(third, "moved-value");
  expect(await replaceRootKey(current, third)).toBe(3);
  expect(await recorded()).toBe(third.id);
  const resolve = resolverOf(vaultOf(third));
  expect((await resolve(waiting.ws, waiting.id, "model_call"))?.value).toEqual({ key: "waiting-value" });
  expect((await resolve(moved.ws, moved.id, "model_call"))?.value).toEqual({ key: "moved-value" });
});

test("a data key made under the old key during the run refuses the change, and a second run finishes it", async () => {
  const current = masterRootKey(Buffer.alloc(32, 3));
  const fourth = masterRootKey(Buffer.alloc(32, 4));
  let late: Awaited<ReturnType<typeof seal>> | undefined;
  // A server still running with the old key stores a first credential while the rewrap is underway.
  const racing: RootKey = { ...fourth, wrap: async (dek, ws) => ((late ??= await seal(current, "late-value")), fourth.wrap(dek, ws)) };
  await expect(replaceRootKey(current, racing)).rejects.toThrow("Stop the API and the worker");
  expect(await recorded()).toBe(current.id);
  expect(await replaceRootKey(current, fourth)).toBe(1);
  expect((await resolverOf(vaultOf(fourth))(late!.ws, late!.id, "model_call"))?.value).toEqual({ key: "late-value" });
});

test("a Workspace under some other root key stops it, named, with the record unchanged", async () => {
  const current = masterRootKey(Buffer.alloc(32, 4));
  const orphan = await seal(masterRootKey(Buffer.alloc(32, 9)), "orphan-value");
  const refusal = replaceRootKey(current, masterRootKey(Buffer.alloc(32, 5)));
  await expect(refusal).rejects.toThrow(orphan.ws);
  await expect(refusal).rejects.toThrow("remove the Workspace if it was a test");
  expect(await recorded()).toBe(current.id);
});

test("verifying a webhook signature records a webhook access, and the secret never leaves", async () => {
  const { createHmac } = await import("node:crypto");
  const root = masterRootKey(Buffer.alloc(32, 4));
  const vault = vaultOf(root);
  const { ws, owner } = await newWorkspace();
  const made = await vault.create({ workspaceId: ws, actorUserId: owner, scope: "workspace", kind: "secret", key: "hook", name: "Hook", value: { value: "whsec-abcdef123456" }, meta: {} });
  if (!made.ok) throw new Error(made.reason);
  const body = new TextEncoder().encode("{}");
  const good = createHmac("sha256", "whsec-abcdef123456").update(body).digest("hex");
  expect(await vault.verifyHmac(ws, made.credential.id, body, good)).toBe(true);
  expect(await vault.verifyHmac(ws, made.credential.id, body, "0".repeat(64))).toBe(false);
  expect(await vault.verifyHmac(ws, made.credential.id, body, "not-hex")).toBe(false);
  const rows = await q(ws, "select consumer, outcome from credential_access_events where credential_id = $1 and consumer = 'webhook'", [made.credential.id]);
  expect(rows).toEqual([{ consumer: "webhook", outcome: "ok" }, { consumer: "webhook", outcome: "ok" }]);
});
