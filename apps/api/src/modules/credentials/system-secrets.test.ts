// SPDX-License-Identifier: AGPL-3.0-only
// The deployment's secrets: the command, startup, and what keeps Workspaces away from them.
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { runSecretsCommand } from "../../secrets";
import { loadDeployment, mediaS3Url, refuseRetiredEnv } from "../../startup";
import { createVault, rootKeyFromEnv } from "./index";
import { ensureSystemWorkspace, listSystemSecrets, readSystemSecret, setSystemSecret, suppressionHasher, SYSTEM_WORKSPACE_ID } from "./system-secrets";

const KEY = "ab".repeat(32);
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: KEY }), now: () => new Date() });
const VALUE = "smtp://user:do-not-print@mail.example.com";

let c: Awaited<ReturnType<typeof appClient>>;
beforeAll(async () => {
  c = await appClient();
  await ensureSystemWorkspace();
});
afterAll(() => c.end());

async function asWorkspace(ws: string, text: string, params: unknown[] = []) {
  await c.query("begin");
  try {
    await c.query("select set_config('app.workspace_id', $1, true)", [ws]);
    const r = await c.query(text, params);
    await c.query("commit");
    return r.rows;
  } catch (e) {
    await c.query("rollback");
    throw e;
  }
}

type Checked = { url: string; from: string; testTo?: string };
/** The mail check, offline: records each call and logs in when `ok`. */
const fakeCheck = (ok = true, calls: Checked[] = []) => async (url: string, from: string, testTo?: string) => {
  calls.push({ url, from, testTo });
  return ok ? { ok: true as const } : { ok: false as const, line: "mail.example.com refused the login for user" };
};

const run = async (args: string[], stdin = "", deps: Parameters<typeof runSecretsCommand>[4] = { checkSmtp: fakeCheck(), env: {} }) => {
  const lines: string[] = [];
  const code = await runSecretsCommand(args, async () => stdin, vault, (l) => lines.push(l), deps);
  return { code, text: lines.join("\n") };
};

test("the command stores a value from stdin and never prints it", async () => {
  const set = await run(["set", "smtp.url"], `${VALUE}\n`);
  expect(set.code).toBe(0);
  expect(set.text).not.toContain("do-not-print");
  const list = await run(["list"]);
  expect(list.text).toMatch(/smtp\.url: set, last changed/);
  expect(list.text).toContain("provider.openai: not set");
  expect(list.text).not.toContain("do-not-print");
  expect(await readSystemSecret(vault, "smtp.url", "startup")).toBe(VALUE);
});

test("smtp.url is stored only when the mail check passes; other names skip it", async () => {
  const calls: Checked[] = [];
  const refused = await run(["set", "smtp.url"], "smtp://user:do-not-print@other.example.com\n", { checkSmtp: fakeCheck(false, calls), env: {} });
  expect(refused).toEqual({ code: 1, text: "mail.example.com refused the login for user" });
  expect(calls).toEqual([{ url: "smtp://user:do-not-print@other.example.com", from: "", testTo: undefined }]);
  expect(await readSystemSecret(vault, "smtp.url", "startup")).toBe(VALUE);
  expect((await run(["set", "social_app.checktest"], "id:sk-m", { checkSmtp: fakeCheck(false, calls), env: {} })).code).toBe(0);
  expect(await readSystemSecret(vault, "social_app.checktest", "startup")).toBe("id:sk-m");
  expect(calls).toHaveLength(1);
  expect((await run(["set", "social_app.checktest", "--parts"], "x")).code).toBe(2);
});

test("--parts encodes the user name and password into the URL it checks and stores", async () => {
  const pass = "a b@c/d%e:f";
  const calls: Checked[] = [];
  const set = await run(["set", "smtp.url", "--parts"], `smtp.example.com\n587\nme@example.com\n${pass}\ntls\n`, { checkSmtp: fakeCheck(true, calls), env: {} });
  expect(set.code).toBe(0);
  expect(set.text).not.toContain(pass);
  const stored = (await readSystemSecret(vault, "smtp.url", "startup"))!;
  expect(calls[0]!.url).toBe(stored);
  const url = new URL(stored);
  expect([url.protocol, url.hostname, url.port, url.search]).toEqual(["smtp:", "smtp.example.com", "587", "?requireTLS=true"]);
  expect(decodeURIComponent(url.username)).toBe("me@example.com");
  expect(decodeURIComponent(url.password)).toBe(pass);
  await run(["set", "smtp.url", "--parts"], `smtp.resend.com\n465\nresend\nre_key\nany\n`, { checkSmtp: fakeCheck(true, calls), env: {} });
  expect(await readSystemSecret(vault, "smtp.url", "startup")).toBe("smtps://resend:re_key@smtp.resend.com:465");
  for (const bad of ["smtp.example.com\n587\nu\np\n", "smtp.example.com\nport\nu\np\nany", "a.com/x\n25\nu\np\nany", "h\n25\nu\np\nany\nextra"]) {
    const r = await run(["set", "smtp.url", "--parts"], bad);
    expect(r).toEqual({ code: 2, text: expect.stringMatching(/^--parts reads five lines/) });
  }
  await run(["set", "smtp.url"], VALUE);
});

test("--test-to reaches the check with DIREX_MAIL_FROM, and is refused without it", async () => {
  const calls: Checked[] = [];
  const env = { DIREX_MAIL_FROM: "Direx <signin@example.com>" };
  expect((await run(["set", "smtp.url", "--test-to", "me@example.com"], VALUE, { checkSmtp: fakeCheck(true, calls), env })).code).toBe(0);
  expect(calls).toEqual([{ url: VALUE, from: env.DIREX_MAIL_FROM, testTo: "me@example.com" }]);
  const noFrom = await run(["set", "smtp.url", "--test-to", "me@example.com"], VALUE, { checkSmtp: fakeCheck(true, calls), env: {} });
  expect(noFrom.code).toBe(2);
  expect(noFrom.text).toMatch(/DIREX_MAIL_FROM, which isn't set/);
  expect(calls).toHaveLength(1);
  expect((await run(["set", "smtp.url", "--test-to"], VALUE)).code).toBe(2);
});

test("the command refuses an unknown name, a value as an argument and an empty value", async () => {
  expect((await run(["set", "my.secret"], "x")).code).toBe(2);
  const asArgument = await run(["set", "provider.openai", "sk-on-the-command-line"], "x");
  expect(asArgument.code).toBe(2);
  expect(asArgument.text).not.toContain("sk-on-the-command-line");
  expect((await run(["set", "provider.openai"], "\n")).code).toBe(2);
  expect((await listSystemSecrets(vault)).map((r) => r.name)).not.toContain("provider.openai");
});

test("setting again replaces the value; ifMissing keeps the first", async () => {
  await setSystemSecret(vault, "provider.google", "one");
  await setSystemSecret(vault, "provider.google", "two");
  expect(await readSystemSecret(vault, "provider.google", "model_call")).toBe("two");
  await setSystemSecret(vault, "provider.google", "three", { ifMissing: true });
  expect(await readSystemSecret(vault, "provider.google", "model_call")).toBe("two");
});

test("a value is sealed, and each read is on record", async () => {
  await setSystemSecret(vault, "provider.anthropic", "sk-sealed-value");
  await readSystemSecret(vault, "provider.anthropic", "model_call");
  const rows = await asWorkspace(SYSTEM_WORKSPACE_ID, "select id, encode(ciphertext, 'escape') as sealed from credentials where key = 'provider.anthropic'");
  expect(rows[0].sealed).not.toContain("sk-sealed-value");
  const events = await vault.events(SYSTEM_WORKSPACE_ID, rows[0].id);
  expect(events.map((e) => e.consumer)).toEqual(expect.arrayContaining(["create", "model_call"]));
});

test("another Workspace's transaction cannot see a system credential", async () => {
  await setSystemSecret(vault, "provider.openrouter", "sk-x");
  const other = crypto.randomUUID();
  expect(await asWorkspace(other, "select 1 from credentials where key like 'provider.%'")).toEqual([]);
  const row = (await listSystemSecrets(vault)).find((r) => r.name === "provider.openrouter");
  expect(row).toBeDefined();
});

test("the system Workspace has no members and starting twice changes nothing", async () => {
  await ensureSystemWorkspace();
  expect(await asWorkspace(SYSTEM_WORKSPACE_ID, "select 1 from workspace_members")).toEqual([]);
  expect(await asWorkspace(SYSTEM_WORKSPACE_ID, "select id from workspaces")).toEqual([{ id: SYSTEM_WORKSPACE_ID }]);
});

test("only the system Workspace may have a credential with no creator", async () => {
  const org = crypto.randomUUID();
  const ws = crypto.randomUUID();
  await asWorkspace(ws, "insert into organizations (id, name, created_at) values ($1, 'O', now())", [org]);
  await asWorkspace(ws, "insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())", [ws, org]);
  await asWorkspace(ws, "insert into workspace_keys (workspace_id, key_version, wrapped_dek, root_key_id, created_at) values ($1, 1, '\\x00', 'r', now())", [ws]);
  await expect(
    asWorkspace(
      ws,
      `insert into credentials (workspace_id, scope, kind, key, name, ciphertext, nonce, key_version, created_at, updated_at)
       values ($1, 'workspace', 'secret', 'k', 'n', '\\x00', '\\x00', 1, now(), now())`,
      [ws],
    ),
  ).rejects.toThrow(/credentials_created_by_check/);
});

const prod = { NODE_ENV: "production", DIREX_MASTER_KEY: KEY, DIREX_MAIL_FROM: "a@example.com" };

test("each retired variable refuses the start outside dev and test, naming the command", () => {
  const names: Record<string, string> = {
    ANTHROPIC_API_KEY: "provider.anthropic",
    OPENAI_API_KEY: "provider.openai",
    GOOGLE_GENERATIVE_AI_API_KEY: "provider.google",
    OPENROUTER_API_KEY: "provider.openrouter",
    DIREX_AUTH_SECRET: "auth.secret",
    DIREX_SMTP_URL: "smtp.url",
    DIREX_GOOGLE_CLIENT_SECRET: "signin.google",
    DIREX_MICROSOFT_CLIENT_SECRET: "signin.microsoft",
  };
  for (const [variable, name] of Object.entries(names)) {
    expect(() => refuseRetiredEnv({ NODE_ENV: "production", [variable]: "x" })).toThrow(new RegExp(`${variable}.*secrets\\.ts set ${name}`));
    expect(() => refuseRetiredEnv({ NODE_ENV: "development", [variable]: "x" })).not.toThrow();
  }
});

test("a production start needs smtp.url, generates auth.secret once, and reuses it", async () => {
  const config = await loadDeployment(prod, () => {});
  const first = await readSystemSecret(vault, "auth.secret", "startup");
  expect(first).toHaveLength(64);
  expect(config.secret).toBe(first);
  expect((await loadDeployment(prod, () => {})).secret).toBe(first);
});

test("a production start takes a sign-in client secret from the vault only, and shows the button once both halves are there", async () => {
  const withId = { ...prod, DIREX_GOOGLE_CLIENT_ID: "google-id", DIREX_MICROSOFT_CLIENT_ID: "microsoft-id" };
  const before = await loadDeployment(withId, () => {});
  expect(before.google).toBeUndefined();
  expect(before.microsoft).toBeUndefined();
  expect((await run(["set", "signin.google"], "google-secret-do-not-print")).text).not.toContain("do-not-print");
  const after = await loadDeployment(withId, () => {});
  expect(after.google).toEqual({ clientId: "google-id", clientSecret: "google-secret-do-not-print" });
  expect(after.microsoft).toBeUndefined();
  expect((await loadDeployment(prod, () => {})).google).toBeUndefined();
});

test("a production start with no smtp.url refuses and names the command", async () => {
  const rows = await asWorkspace(SYSTEM_WORKSPACE_ID, "select id from credentials where key = 'smtp.url'");
  const r = await vault.remove({ workspaceId: SYSTEM_WORKSPACE_ID, id: rows[0].id, actorUserId: null, stepUp: true });
  expect(r.ok).toBe(true);
  await expect(loadDeployment(prod, () => {})).rejects.toThrow(/secrets\.ts set smtp\.url/);
});

test("media.s3 is null until set, then read at start; the list says it is set, never what it is", async () => {
  expect(await mediaS3Url(prod)).toBeNull();
  const url = "https://AK:keep-this-out@r2.example.com/media?region=auto";
  expect((await run(["set", "media.s3"], `${url}\n`)).code).toBe(0);
  expect(await mediaS3Url(prod)).toBe(url);
  const listed = await run(["list"]);
  expect(listed.text).toMatch(/media\.s3: set, last changed/);
  expect(listed.text).not.toContain("keep-this-out");
  const rows = await asWorkspace(SYSTEM_WORKSPACE_ID, "select id from credentials where key = 'media.s3'");
  expect((await vault.remove({ workspaceId: SYSTEM_WORKSPACE_ID, id: rows[0].id, actorUserId: null, stepUp: true })).ok).toBe(true);
});

test("suppression.key is made once, by the purge, keyed hashes are stable and lower-cased, and no command replaces it", async () => {
  expect(await suppressionHasher(vault)()).toBeNull();
  const hash = (await suppressionHasher(vault)(true))!;
  const again = (await suppressionHasher(vault)(true))!;
  expect(hash(" Gone@Example.com ")).toMatch(/^[0-9a-f]{64}$/);
  expect(again("gone@example.com")).toBe(hash(" Gone@Example.com "));
  expect(hash("other@example.com")).not.toBe(hash("gone@example.com"));
  const refused = await run(["set", "suppression.key"], "attacker-chosen\n");
  expect(refused.code).toBe(2);
  expect(refused.text).toMatch(/made by the first Workspace purge and never changes/);
  expect((await suppressionHasher(vault)())!("gone@example.com")).toBe(hash("gone@example.com"));
});
