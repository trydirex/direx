// SPDX-License-Identifier: AGPL-3.0-only
// The credential seam: the Action's credential id reaches the vault with its use, each
// kind reaches only the call that needs it, a kind the manifest did not declare is
// refused, and a value echoed in a refusal is redacted.
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { behavePlugin } from "./fixtures/behave-plugin";
import { parseManifest, VERIFY_BALANCE, type Manifest } from "@direx/plugin-sdk";
import { behaveManifest, keyManifest } from "./fixtures/manifest";
import { keyConnections, loadPlugins, type Credentials, type CredentialUse, type Plugins } from "./index";

const dir = join(import.meta.dirname, "fixtures");
const W = crypto.randomUUID();
const SEND = "com.example.behave/behave.send";
const TOKEN = { accessToken: "tok-secret-123", expiresAt: "2026-11-02T10:00:00Z" };
const opened: Plugins[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.close({ force: true })));
});

function inProcess(credentials: Credentials) {
  const p = loadPlugins({ sources: [{ mode: "in_process", plugin: behavePlugin }], credentials, confinement: "none", log: () => {}, onEvent: async () => {} });
  opened.push(p);
  return p;
}

test("the Action's credential id and the use reach the vault for execute, query and poll", async () => {
  const asked: [string, string | null, CredentialUse][] = [];
  const p = inProcess(async (ws, id, use) => {
    asked.push([ws, id, use]);
    return TOKEN;
  });
  await p.effects[SEND]!.execute({ do: "sent" }, { workspaceId: W, idempotencyKey: "a-1", credentialId: "c-1" });
  await p.query(W, "com.example.behave/mailbox.probe_read", { actionId: "a1", subject: "s" }, "c-2");
  await p.runPoll({ workspaceId: W, pluginId: "com.example.behave", trigger: "behave.feed", credentialId: "33333333-3333-4333-8333-333333333333" });
  expect(asked).toEqual([
    [W, "c-1", { consumer: "execute", actionId: "a-1" }],
    [W, "c-2", { consumer: "query" }],
    [W, "33333333-3333-4333-8333-333333333333", { consumer: "poll" }],
  ]);
});

test("a credential of a kind the manifest did not declare is refused, not sent", async () => {
  const p = inProcess(async () => ({ key: "sk-1" }));
  expect(await p.effects[SEND]!.execute({ do: "sent" }, { workspaceId: W, idempotencyKey: "a-1", credentialId: "c-1" })).toEqual({
    kind: "refused",
    permanent: false,
    retryable: false,
    detail: "no credential: connection svc declares oauth2, but the credential is api_key",
  });
});

test("V24: a value the plugin echoes in a refusal is redacted before the ledger sees it", async () => {
  const p = inProcess(async () => TOKEN);
  const r = await p.effects[SEND]!.execute({ do: "leak" }, { workspaceId: W, idempotencyKey: "a-1", credentialId: "c-1" });
  expect(r).toMatchObject({ kind: "refused" });
  const detail = (r as { detail: string }).detail;
  expect(detail).not.toContain(TOKEN.accessToken);
  expect(detail).toContain("[redacted]");
  expect(detail).toContain(TOKEN.expiresAt);
});

test("V19: an api_key connection gets its key only in the call that needs it, and the host never logs it", async () => {
  const logs: string[] = [];
  const p = loadPlugins({
    sources: [{ mode: "process", manifest: keyManifest, entry: join(dir, "raw-spy-key.ts"), dir }],
    credentials: async (ws) => ({ key: `key-${ws}` }),
    confinement: "external",
    log: (l) => logs.push(l),
    hostOptions: { drainMs: 200, killMs: 200 },
  });
  opened.push(p);
  await p.effects[SEND]!.execute({ do: "sent" }, { workspaceId: W, idempotencyKey: "a-1", credentialId: "c-1" });
  for (let i = 0; i < 100 && !logs.some((l) => /RECV .*"execute"/.test(l)); i++) await Bun.sleep(20);
  const init = logs.find((l) => /RECV .*"initialize"/.test(l));
  const exec = logs.find((l) => /RECV .*"execute"/.test(l));
  expect(init).toBeDefined();
  expect(init).not.toContain("key-");
  expect(exec).toContain(`"credential":{"kind":"api_key","key":"key-${W}"}`);
  expect(logs.filter((l) => !l.includes("stderr: RECV")).filter((l) => l.includes("key-"))).toEqual([]);
});

test("a connection that takes an API key is listed by its plugin's name, with its balance or profile query when it has one", () => {
  const parsed = (m: unknown): Manifest => {
    const r = parseManifest(m);
    if (!r.ok) throw new Error(r.errors.join("; "));
    return r.manifest;
  };
  const named = { ...keyManifest, name: "Behave", capabilities: [...keyManifest.capabilities, { kind: "query", name: VERIFY_BALANCE, connection: "svc" }] };
  const letter = { ...keyManifest, name: "Letter", capabilities: [...keyManifest.capabilities, { kind: "query", name: "newsletter.profile", connection: "svc" }] };
  expect(keyConnections([behaveManifest, named, keyManifest, letter].map(parsed))).toEqual([
    { connection: "svc", name: "Behave", balance: `com.example.behave/${VERIFY_BALANCE}`, profile: null },
    { connection: "svc", name: "com.example.behave", balance: null, profile: null },
    { connection: "svc", name: "Letter", balance: null, profile: "com.example.behave/newsletter.profile" },
  ]);
});

test("a typed credential reaches only the one query it is for, and the vault is never asked", async () => {
  const asked: unknown[] = [];
  const p = inProcess(async (...args) => {
    asked.push(args);
    return TOKEN;
  });
  expect(await p.queryTyped(W, "com.example.behave/mailbox.probe_read", { actionId: "a1", subject: "s" }, TOKEN)).toEqual({ found: true, folder: "inbox", headers: W, text: TOKEN.accessToken, html: null });
  expect(asked).toEqual([]);
});

test("a typed credential the plugin echoes in an error comes back redacted", async () => {
  const p = inProcess(async () => TOKEN);
  const err = await p.queryTyped(W, "com.example.behave/mailbox.probe_read", { actionId: "leak", subject: "s" }, TOKEN).catch((e: Error) => e);
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).not.toContain(TOKEN.accessToken);
  expect((err as Error).message).toContain("[redacted]");
});
