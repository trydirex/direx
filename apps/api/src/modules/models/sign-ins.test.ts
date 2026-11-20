// SPDX-License-Identifier: AGPL-3.0-only
// Who a sign-in serves, which AI a call uses, and what a person sees when a sign-in stops working.
// Real vault and database as the app role, fake CLIs on PATH, so CI needs no subscription.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { appClient, insertAuthUser } from "../../../../../test/db";
import { createVault, rootKeyFromEnv } from "../credentials/index";
import { createKeys, signInFor } from "./adapters/keys";
import * as repo from "./adapters/repo";
import { failureOf, resetOf } from "./adapters/runtime/envelope";
import { useCodexBinaryForTests } from "./adapters/runtime/codex";
import { startLogin } from "./adapters/runtime/login";
import { adapterBlocked, ADAPTERS, withCliAdapters } from "./adapters/runtime/registry";
import { sandboxStatus } from "./adapters/runtime/sandbox";
import { parseSignInLink, parseSignInToken } from "./adapters/runtime/setup-token-parse";
import type { Dispatch, DispatchResult } from "./adapters/sdk";
import { beginSignIn, chooseAdapter, chooseForAgent, finishSignIn, listAdapters, modelSignInKind, removeSignIn, signInNeeds, SIGN_IN_ITEM_KIND, testAdapter } from "./application/sign-ins";
import { changeSettings } from "./application/settings";
import type { Candidate } from "./domain/routes-check";
import { fakeCli, pathWithoutRealClis } from "./fake-cli";
import { createModels } from "./index";

const PATH = pathWithoutRealClis(process.env.PATH);
process.env.PATH = PATH;
// Codex is found through its test parameter, never PATH (DX-R-0036-003); null is "not installed".
const codexIn = (dir: string | null) => useCodexBinaryForTests(dir === null ? null : join(dir, "codex"));
codexIn(null);
afterEach(() => {
  process.env.PATH = PATH;
  codexIn(null);
});

const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "00".repeat(31) + "ad" }), now: () => new Date() });
let db: Awaited<ReturnType<typeof appClient>>;
beforeAll(async () => {
  db = await appClient();
});
afterAll(async () => {
  await db.end();
});
async function q(ws: string, sql: string, params: unknown[] = []) {
  await db.query("begin");
  try {
    await db.query("select set_config('app.workspace_id', $1, true)", [ws]);
    const r = await db.query(sql, params);
    await db.query("commit");
    return r.rows;
  } catch (e) {
    await db.query("rollback");
    throw e;
  }
}
async function setup() {
  const ws = crypto.randomUUID();
  const org = crypto.randomUUID();
  await q(ws, "insert into organizations (id, name, created_at) values ($1, 'O', now())", [org]);
  await q(ws, "insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())", [ws, org]);
  const user = crypto.randomUUID();
  const other = crypto.randomUUID();
  await insertAuthUser(user);
  await insertAuthUser(other);
  for (const id of [user, other]) await q(ws, "insert into workspace_members (workspace_id, user_id, role, created_at) values ($1, $2, 'admin', now())", [ws, id]);
  return { ws, user, other };
}

const now = new Date();
async function addSignIn(ws: string, provider: "claude_code" | "codex", owner: string | null, by: string, value: string) {
  const made = await vault.create({ workspaceId: ws, actorUserId: by, scope: owner ? "user" : "workspace", kind: "secret", key: `cli.${provider}.${owner ?? "shared"}`, name: "sign-in", meta: {}, value: { value } });
  if (!made.ok) throw new Error(made.reason);
  await repo.insertCliSignIn(ws, provider, owner, made.credential.id, by, now);
  return made.credential.id;
}

const usage = { noCacheTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 3, outputTokens: 4, reasoningTokens: 1 };
const fine = (text = "fine"): DispatchResult => ({ ok: true, text, output: undefined, toolCalls: [], usage, resolvedModel: "served" });
const API: Candidate = { provider: "anthropic", model: "pinned-model", maxOutputTokens: 100, price: null, evalRef: null };
const ROUTED: Candidate = { provider: "claude_code", model: "claude-sonnet-5-5", maxOutputTokens: 100, price: null, evalRef: "routed.json" };
const routes = { plain: { candidates: [API] }, routed: { candidates: [ROUTED, API] }, optout_detect: { candidates: [API] }, connection_test: { candidates: [API] } };
function models(dispatch: Dispatch, deployment: "self_host" | "cloud" = "self_host", outcome?: (ws: string, p: string, a: string | undefined, w: boolean) => Promise<void>) {
  return createModels({ deployment, routes, keys: createKeys({ deployment, vault: () => vault, signInOutcome: outcome }), dispatch, runGate: async () => ({ live: true, tainted: false }) });
}
const ask = (ws: string, over: { purpose?: string; actorUserId?: string; agent?: string } = {}) => ({
  workspaceId: ws,
  purpose: "plain",
  idempotencyKey: crypto.randomUUID(),
  parts: [{ role: "user" as const, kind: "definition", text: "hi" }],
  ...over,
});
const recording = () => {
  const seen: { provider: string; model: string; apiKey: string }[] = [];
  const dispatch: Dispatch = async (r) => {
    seen.push({ provider: r.provider, model: r.model, apiKey: r.apiKey });
    return fine();
  };
  return { seen, dispatch };
};

test("a personal sign-in serves only its owner, and a run nobody started needs the shared one", async () => {
  const { ws, user, other } = await setup();
  await addSignIn(ws, "claude_code", user, user, "mine");
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: null, now });
  const { seen, dispatch } = recording();
  const m = models(dispatch);

  expect((await m.generate(ask(ws, { actorUserId: user }))).ok).toBe(true);
  expect(seen.at(-1)).toEqual({ provider: "claude_code", model: "claude-haiku-5-5", apiKey: "mine" });
  expect(await m.generate(ask(ws, { actorUserId: other }))).toMatchObject({ ok: false, refusal: "no_connection" });
  expect(await m.generate(ask(ws))).toMatchObject({ ok: false, refusal: "no_shared_sign_in" });

  await addSignIn(ws, "claude_code", null, user, "shared");
  expect((await m.generate(ask(ws))).ok).toBe(true);
  expect(seen.at(-1)!.apiKey).toBe("shared");
  expect((await m.generate(ask(ws, { actorUserId: other }))).ok).toBe(true);
  expect(seen.at(-1)!.apiKey).toBe("shared");
  expect((await m.generate(ask(ws, { actorUserId: user }))).ok).toBe(true);
  expect(seen.at(-1)!.apiKey).toBe("mine");

  // An owner who left stops working, and the run is refused rather than moved to the shared one.
  await q(ws, "delete from workspace_members where user_id = $1", [user]);
  expect(await m.generate(ask(ws, { actorUserId: user }))).toMatchObject({ ok: false, refusal: "credential_unavailable" });
});

test("the subscription picked with no model runs a purpose on its own routed model there, else the first", async () => {
  const { ws, user } = await setup();
  await addSignIn(ws, "claude_code", null, user, "c");
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: null, now });
  const { seen, dispatch } = recording();
  const m = models(dispatch);
  await m.generate(ask(ws, { purpose: "routed" }));
  expect(seen.at(-1)).toMatchObject({ provider: "claude_code", model: "claude-sonnet-5-5" });
  await m.generate(ask(ws));
  expect(seen.at(-1)).toMatchObject({ provider: "claude_code", model: "claude-haiku-5-5" });
});

test("signInFor prefers the person's own and never hands one person another's", () => {
  const rows = [{ provider: "codex", ownerUserId: "a" }, { provider: "codex", ownerUserId: null }, { provider: "claude_code", ownerUserId: "b" }];
  expect(signInFor(rows, "codex", "a")).toBe(rows[0]);
  expect(signInFor(rows, "codex", "b")).toBe(rows[1]);
  expect(signInFor(rows, "codex")).toBe(rows[1]);
  expect(signInFor(rows, "claude_code", "a")).toBeUndefined();
  expect(signInFor(rows, "claude_code")).toBeUndefined();
});

test("an agent's own choice wins, and clearing it goes back to the Workspace's", async () => {
  const { ws, user } = await setup();
  await addSignIn(ws, "claude_code", null, user, "c");
  await addSignIn(ws, "codex", null, user, "x");
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: "claude-sonnet-5-5", now });
  await chooseForAgent({ deployment: "self_host", workspaceId: ws, actorUserId: user, agent: "brand_reader", adapter: "codex", model: "gpt-6-sol", now });
  const { seen, dispatch } = recording();
  const m = models(dispatch);

  await m.generate(ask(ws, { agent: "brand_reader" }));
  expect(seen.at(-1)).toMatchObject({ provider: "codex", model: "gpt-6-sol" });
  await m.generate(ask(ws, { agent: "plan_drafter" }));
  expect(seen.at(-1)).toMatchObject({ provider: "claude_code", model: "claude-sonnet-5-5" });
  await chooseForAgent({ deployment: "self_host", workspaceId: ws, actorUserId: user, agent: "brand_reader", adapter: null, model: null, now });
  await m.generate(ask(ws, { agent: "brand_reader" }));
  expect(seen.at(-1)).toMatchObject({ provider: "claude_code" });
});

test("a model off the short list is refused, and changing settings keeps the choice", async () => {
  const { ws, user } = await setup();
  expect(await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "codex", model: "made-up", now })).toBe("unknown_model");
  expect(await chooseForAgent({ deployment: "self_host", workspaceId: ws, actorUserId: user, agent: "a", adapter: "codex", model: "made-up", now })).toBe("unknown_model");
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "codex", model: "gpt-6-sol", now });
  await changeSettings({ deployment: "self_host", workspaceId: ws, actorUserId: user, monthlyBudgetMicros: 5_000_000n, allowUnpriced: false, now });
  expect(await repo.adapterChoice(ws)).toEqual({ adapter: "codex", model: "gpt-6-sol" });
});

test("a safety purpose ignores the picker, and a picked AI never falls back", async () => {
  const { ws, user } = await setup();
  await addSignIn(ws, "claude_code", null, user, "c");
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: null, now });
  const { seen, dispatch } = recording();
  const m = models(dispatch);
  expect(await m.generate(ask(ws, { purpose: "optout_detect" }))).toMatchObject({ ok: false, refusal: "no_connection" });
  expect(seen).toEqual([]);

  // A picked CLI with no sign-in is refused, though an API key is connected for the route.
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "codex", model: null, now });
  const key = await vault.create({ workspaceId: ws, actorUserId: user, scope: "workspace", kind: "api_key", key: "k", name: "k", meta: {}, value: { key: "api" } });
  if (!key.ok) throw new Error(key.reason);
  await repo.setConnection(ws, "anthropic", key.credential.id, user, now);
  expect(await m.generate(ask(ws))).toMatchObject({ ok: false, refusal: "no_shared_sign_in" });
  expect(seen).toEqual([]);
});

test("cloud refuses all of it and never reads a choice", async () => {
  const { ws, user } = await setup();
  const d = "cloud" as const;
  expect(await listAdapters(d, ws, user)).toBe("cloud_managed");
  expect(await chooseAdapter({ deployment: d, workspaceId: ws, actorUserId: user, adapter: "codex", model: null, now })).toBe("cloud_managed");
  expect(await chooseForAgent({ deployment: d, workspaceId: ws, actorUserId: user, agent: "a", adapter: "codex", model: null, now })).toBe("unknown_adapter");
  expect(await beginSignIn({ deployment: d, workspaceId: ws, userId: user, provider: "codex", shared: true })).toEqual({ ok: false, reason: "cloud_managed" });
  expect(await removeSignIn({ deployment: d, vault: () => vault, workspaceId: ws, provider: "codex", ownerUserId: null, actorUserId: user })).toBe("cloud_managed");
  expect(await testAdapter({ deployment: d, models: models(recording().dispatch, d), workspaceId: ws, userId: user, provider: "codex" })).toEqual({ ok: false, reason: "cloud_managed" });

  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "codex", model: null, now });
  const { seen, dispatch } = recording();
  expect(await models(dispatch, d).generate(ask(ws))).toMatchObject({ ok: false, refusal: "no_connection" });
  expect(seen).toEqual([]);
});

test("a refreshed sign-in is saved to the vault, and calls on one sign-in run one at a time", async () => {
  const { ws, user } = await setup();
  await addSignIn(ws, "codex", null, user, "first");
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "codex", model: null, now });
  let running = 0;
  let most = 0;
  const seen: string[] = [];
  const dispatch: Dispatch = async (r) => {
    most = Math.max(most, ++running);
    seen.push(r.apiKey);
    await Bun.sleep(10);
    await r.replaceKey!(`${r.apiKey}+`);
    running--;
    return fine();
  };
  const m = models(dispatch);
  await Promise.all([m.generate(ask(ws)), m.generate(ask(ws))]);
  expect(most).toBe(1);
  expect(seen).toEqual(["first", "first+"]);
  await m.generate(ask(ws));
  expect(seen.at(-1)).toBe("first++");
});

test("two sign-ins don't wait for each other", async () => {
  const { ws, user, other } = await setup();
  await addSignIn(ws, "codex", user, user, "a");
  await addSignIn(ws, "codex", other, other, "b");
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "codex", model: null, now });
  let running = 0;
  let most = 0;
  // Each call waits for the other to arrive, so a slow runner can't make them miss each
  // other. If sign-ins were serialised, the first gives up after a second and most stays 1.
  let bothIn!: () => void;
  const both = new Promise<void>((resolve) => (bothIn = resolve));
  const dispatch: Dispatch = async () => {
    most = Math.max(most, ++running);
    if (running === 2) bothIn();
    await Promise.race([both, Bun.sleep(1000)]);
    running--;
    return fine();
  };
  const m = models(dispatch);
  await Promise.all([m.generate(ask(ws, { actorUserId: user })), m.generate(ask(ws, { actorUserId: other }))]);
  expect(most).toBe(2);
});

test("token counts a CLI didn't report are recorded as unknown, not zero", async () => {
  const { ws, user } = await setup();
  await addSignIn(ws, "claude_code", null, user, "c");
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: null, now });
  const r = await models(async () => ({ ok: true, text: "x", output: undefined, toolCalls: [], usage: { ...usage, tokensUnknown: true }, resolvedModel: "s" })).generate(ask(ws));
  const [row] = await q(ws, "select input_tokens, output_tokens, cost_micros, cost_status from model_calls where id = $1", [r.callId]);
  expect(row).toEqual({ input_tokens: null, output_tokens: null, cost_micros: "0", cost_status: "subscription" });
});

test("a limit waits until the time the CLI gives, else an hour", () => {
  const at = new Date("2026-10-30T10:00:00Z");
  const limit = (s: string) => failureOf(`You've hit your limit ${s}`, at);
  expect(limit("· resets 3pm (UTC)")).toMatchObject({ family: "provider_quota", retryNotBefore: new Date("2026-10-30T15:00:00Z") });
  expect(limit("· resets 9am (UTC)")).toMatchObject({ retryNotBefore: new Date("2026-10-31T09:00:00Z") });
  expect(limit("resets at 3:30pm (America/New_York)")).toMatchObject({ retryNotBefore: new Date("2026-10-30T19:30:00Z") });
  expect(limit(`{"resets_in_seconds":120}`)).toMatchObject({ retryNotBefore: new Date("2026-10-30T10:02:00Z") });
  expect(limit("")).toMatchObject({ retryNotBefore: new Date("2026-10-30T11:00:00Z") });
  // Not believable: fall back rather than sleep for a year or retry at once.
  expect(resetOf(`"resets_at":${Math.floor(at.getTime() / 1000) + 365 * 86_400}`, at)).toBeNull();
  expect(resetOf(`"resets_at":${Math.floor(at.getTime() / 1000) - 60}`, at)).toBeNull();
  expect(resetOf("resets 13pm", at)).toBeNull();
});

test("signed out, not installed and a blocked sandbox each say which", async () => {
  expect(failureOf("Not logged in. Please run /login")).toMatchObject({ family: "configuration", reason: "signed_out" });
  process.env.PATH = "/nonexistent";
  const dispatch = withCliAdapters(async () => fine());
  const req = { provider: "codex" as const, model: "m", apiKey: "k", messages: [], tools: [], maxOutputTokens: 1, abortSignal: AbortSignal.timeout(5000) };
  expect(await dispatch(req)).toMatchObject({ family: "configuration", reason: "not_installed" });
  expect(await adapterBlocked(ADAPTERS[1]!)).toBe("not_installed");
  process.env.PATH = PATH;
  const status = await sandboxStatus();
  codexIn(fakeCli("codex", "signed_out"));
  const blocked = await adapterBlocked(ADAPTERS[1]!);
  if (status.ok) {
    expect(blocked).toBeNull();
    expect(await dispatch(req)).toMatchObject({ family: "configuration", reason: "signed_out" });
  } else {
    expect(blocked).toBe(status.reason);
    expect(await dispatch(req)).toMatchObject({ family: "configuration", reason: status.reason });
  }
});

test("one Needs you entry per sign-in, cleared when the sign-in works again", async () => {
  const { ws, user } = await setup();
  await addSignIn(ws, "claude_code", null, user, "c");
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: null, now });
  const created: { kind: string; title: string }[] = [];
  const cancelled: string[] = [];
  const needs = signInNeeds(() => ({
    createItem: async (_ws, a) => {
      created.push({ kind: a.kind, title: a.details.title });
      return { ok: true, item: { id: crypto.randomUUID() } };
    },
    cancel: async (_ws, id) => void cancelled.push(id),
  }));
  let signedOut = true;
  const m = models(async () => (signedOut ? { ok: false, family: "configuration", definite: true, reason: "signed_out" } : fine()), "self_host", needs.outcome);

  expect(await m.generate(ask(ws))).toMatchObject({ ok: false, errorFamily: "configuration", reason: "signed_out" });
  await m.generate(ask(ws));
  expect(created).toEqual([{ kind: SIGN_IN_ITEM_KIND, title: "Sign in to Claude Code again" }]);
  expect((await repo.cliSignIns(ws))[0]!.needsItemId).not.toBeNull();
  const listed = await listAdapters("self_host", ws, user);
  if (listed === "cloud_managed") throw new Error("self-host");
  expect(listed.adapters[0]).toMatchObject({ shared: true, signedOut: true, evaluated: false });

  signedOut = false;
  expect((await m.generate(ask(ws))).ok).toBe(true);
  expect(cancelled).toHaveLength(1);
  expect((await repo.cliSignIns(ws))[0]!.needsItemId).toBeNull();
  await m.generate(ask(ws));
  expect(cancelled).toHaveLength(1);
  expect(await modelSignInKind()[SIGN_IN_ITEM_KIND]!.apply()).toEqual({ ok: true });
});

test("a failure that isn't about the sign-in opens no entry", async () => {
  const { ws, user } = await setup();
  await addSignIn(ws, "claude_code", null, user, "c");
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: null, now });
  const outcome = vi.fn(async () => {});
  await models(async () => ({ ok: false, family: "configuration", definite: true, reason: "This needs bubblewrap" }), "self_host", outcome).generate(ask(ws));
  await models(async () => ({ ok: false, family: "provider_quota", definite: true }), "self_host", outcome).generate(ask(ws));
  expect(outcome).not.toHaveBeenCalled();
});

test("the Test button passes when nothing comes back, and fails when the file does", async () => {
  const { ws, user } = await setup();
  await addSignIn(ws, "codex", null, user, "x");
  codexIn(fakeCli("codex", "success"));
  const status = await sandboxStatus();
  const run = (dispatch: Dispatch) => testAdapter({ deployment: "self_host", models: models(dispatch), workspaceId: ws, userId: user, provider: "codex" });
  if (!status.ok) {
    expect(await run(async () => fine())).toEqual({ ok: false, reason: status.reason });
    return;
  }
  expect(await run(async () => fine("I can't read files."))).toEqual({ ok: true, reason: null });
  let calls = 0;
  const refuses: Dispatch = async () => (++calls === 1 ? fine() : { ok: false, family: "model_refusal", usage: null });
  expect(await run(refuses)).toEqual({ ok: true, reason: null });
  const leaks: Dispatch = async (r) => {
    const file = /read (\S+) and/.exec(r.messages[0]!.content)?.[1];
    return fine(file ? await Bun.file(file).text() : "OK");
  };
  expect(await run(leaks)).toEqual({ ok: false, reason: "file_visible" });
  expect(await run(async () => ({ ok: false, family: "configuration", definite: true, reason: "signed_out" }))).toEqual({ ok: false, reason: "signed_out" });
  codexIn(null);
  expect(await run(async () => fine())).toEqual({ ok: false, reason: "not_installed" });
  // No sign-in at all is a refusal, named.
  process.env.PATH = `${fakeCli("claude", "success")}:${PATH}`;
  expect(await testAdapter({ deployment: "self_host", models: models(async () => fine()), workspaceId: ws, userId: user, provider: "claude_code" })).toEqual({ ok: false, reason: "no_connection" });
});

const CHALLENGE = "c".repeat(43);
const STATE = "s".repeat(24);
const LINK = `https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redirect_uri=${encodeURIComponent("https://platform.claude.com/oauth/code/callback")}&scope=user%3Ainference&code_challenge=${CHALLENGE}&code_challenge_method=S256&state=${STATE}`;
const TOKEN = `sk-ant-oat01-${"m".repeat(40)}`;
const screen = (link = LINK) => `Browser didn't open? Use the url below to sign in\n\n${link}\n\nPaste code here if prompted >`;
const success = (token = TOKEN) => `Your OAuth token (valid for 1 year):\n\n${token}\n\nStore this token securely. You won't be able to see it again.`;

test("the parsers take only the exact shapes", () => {
  expect(parseSignInLink(screen())).toBe(LINK);
  expect(parseSignInLink(`\u001b[1m${screen()}\u001b[0m`)).toBe(LINK);
  expect(parseSignInLink(screen().replace(LINK, `${LINK.slice(0, 60)}\n${LINK.slice(60)}`))).toBe(LINK);
  for (const bad of [LINK.replace("claude.com", "claude.com.evil.test"), LINK.replace("S256", "plain"), `${LINK}#x`, LINK.replace("state=", "state=sk-ant-"), `${LINK}&state=${STATE}`]) {
    expect(parseSignInLink(screen(bad))).toBeNull();
  }
  expect(parseSignInLink(LINK)).toBeNull();
  expect(parseSignInLink(screen().replace("Paste code here if prompted", "Something else"))).toBeNull();

  expect(parseSignInToken(success())).toBe(TOKEN);
  expect(parseSignInToken(success().replaceAll("\n", "\r"))).toBe(TOKEN);
  expect(parseSignInToken(success(`${TOKEN.slice(0, 20)}\n${TOKEN.slice(20)}`))).toBe(TOKEN);
  expect(parseSignInToken(TOKEN)).toBeNull();
  expect(parseSignInToken(success("sk-ant-api03-nope"))).toBeNull();
  expect(parseSignInToken(success(`${TOKEN} extra`))).toBeNull();
  expect(parseSignInToken(`${success()}\n${success()}`)).toBeNull();
});

function fakeBin(name: string, script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "direx-fake-cli-"));
  writeFileSync(join(dir, name), `#!/bin/bash\n${script}\n`);
  chmodSync(join(dir, name), 0o755);
  return dir;
}
const fakeClaudeLogin = (token = TOKEN) =>
  fakeBin("claude", `[ "$1" = "setup-token" ] || exit 9\nprintf '%s\\n' 'Use the url below to sign in' '' '${LINK}' '' 'Paste code here if prompted >'\nread -r code\n[ "$code" = "browser-code" ] || { echo 'bad code'; exit 1; }\nprintf '%s\\n' 'Your OAuth token (valid for 1 year):' '' '${token}' '' "Store this token securely. You won't be able to see it again."`);

test("a Codex sign-in finds its link and code through the colours it prints them in", async () => {
  const { ws, user } = await setup();
  const coloured = fakeBin("codex", `printf '1. Open this link\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n2. Enter this code\\n   \\033[94mABC-DEFG\\033[0m\\n'\nsleep 1\nexit 1`);
  codexIn(coloured);
  const started = await beginSignIn({ deployment: "self_host", workspaceId: ws, userId: user, provider: "codex", shared: true });
  if (!started.ok) throw new Error(started.reason);
  expect(started).toMatchObject({ link: "https://auth.openai.com/codex/device", userCode: "ABC-DEFG" });
  expect(await finishSignIn({ vault: () => vault, workspaceId: ws, userId: user, id: started.id, code: null, now, clearNeeds: async () => {} })).toBe("no_token");
});

test("a code the CLI rejects ends the sign-in at once, without waiting for a token", async () => {
  const { ws, user } = await setup();
  const rejecting = fakeBin("claude", `[ "$1" = "setup-token" ] || exit 9\nprintf '%s\\n' 'Use the url below to sign in' '' '${LINK}' '' 'Paste code here if prompted >'\nread -r code\necho "OAuth error: That code wasn't accepted."\nsleep 90`);
  process.env.PATH = `${rejecting}:${PATH}`;
  const started = await beginSignIn({ deployment: "self_host", workspaceId: ws, userId: user, provider: "claude_code", shared: true });
  if (!started.ok) throw new Error(started.reason);
  const began = Date.now();
  expect(await finishSignIn({ vault: () => vault, workspaceId: ws, userId: user, id: started.id, code: "browser-code", now, clearNeeds: async () => {} })).toBe("no_token");
  expect(Date.now() - began).toBeLessThan(5_000);
  expect(await repo.cliSignIns(ws)).toEqual([]);
});

test("a Claude Code sign-in stores the token in the vault and shows only the link", async () => {
  const { ws, user, other } = await setup();
  process.env.PATH = `${fakeClaudeLogin()}:${PATH}`;
  const logged = vi.spyOn(console, "log");
  const errored = vi.spyOn(console, "error");
  const started = await beginSignIn({ deployment: "self_host", workspaceId: ws, userId: user, provider: "claude_code", shared: true });
  if (!started.ok) throw new Error(started.reason);
  expect(started.link).toBe(LINK);
  const finish = (userId: string, code: string | null, id = started.id) => finishSignIn({ vault: () => vault, workspaceId: ws, userId, id, code, now, clearNeeds: async () => {} });
  expect(await finish(other, "browser-code")).toBe("not_found");
  expect(await finish(user, "not a code; stop")).toBe("bad_code");
  expect(await finish(user, "browser-code")).toBeNull();
  expect(await finish(user, "browser-code")).toBe("not_found");

  const [row] = await repo.cliSignIns(ws);
  expect(row).toMatchObject({ provider: "claude_code", ownerUserId: null });
  const meta = await vault.find(ws, row!.credentialId);
  expect(JSON.stringify(meta)).not.toContain(TOKEN);
  const { seen, dispatch } = recording();
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: null, now });
  const r = await models(dispatch).generate(ask(ws));
  expect(seen.at(-1)!.apiKey).toBe(TOKEN);
  const [call] = await q(ws, "select * from model_calls where id = $1", [r.callId]);
  for (const output of [JSON.stringify(call), JSON.stringify(logged.mock.calls), JSON.stringify(errored.mock.calls)]) expect(output).not.toContain(TOKEN);

  // Signing in again replaces the value and keeps the one row.
  const newer = `sk-ant-oat01-${"n".repeat(40)}`;
  process.env.PATH = `${fakeClaudeLogin(newer)}:${PATH}`;
  const again = await beginSignIn({ deployment: "self_host", workspaceId: ws, userId: user, provider: "claude_code", shared: true });
  if (!again.ok) throw new Error(again.reason);
  const cleared: unknown[] = [];
  expect(await finishSignIn({ vault: () => vault, workspaceId: ws, userId: user, id: again.id, code: "browser-code", now, clearNeeds: async (...a) => void cleared.push(a) })).toBeNull();
  expect(await repo.cliSignIns(ws)).toHaveLength(1);
  expect(cleared).toHaveLength(1);
  await models(dispatch).generate(ask(ws));
  expect(seen.at(-1)!.apiKey).toBe(newer);

  expect(await removeSignIn({ deployment: "self_host", vault: () => vault, workspaceId: ws, provider: "claude_code", ownerUserId: null, actorUserId: user })).toBeNull();
  expect(await repo.cliSignIns(ws)).toHaveLength(0);
  expect(await removeSignIn({ deployment: "self_host", vault: () => vault, workspaceId: ws, provider: "claude_code", ownerUserId: null, actorUserId: user })).toBe("not_found");
}, 30_000);

test("a Codex device login stores auth.json, and a personal one belongs to its owner", async () => {
  const { ws, user } = await setup();
  codexIn(fakeBin("codex", `[ "$*" = "login --device-auth" ] || exit 9\necho 'Open https://auth.openai.com/codex/device and enter ABCD-EFGH'\necho '{"tokens":"device"}' > "$CODEX_HOME/auth.json"`));
  const started = await beginSignIn({ deployment: "self_host", workspaceId: ws, userId: user, provider: "codex", shared: false });
  if (!started.ok) throw new Error(started.reason);
  expect(started).toMatchObject({ link: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" });
  expect(await finishSignIn({ vault: () => vault, workspaceId: ws, userId: user, id: started.id, code: null, now, clearNeeds: async () => {} })).toBeNull();
  expect((await repo.cliSignIns(ws))[0]).toMatchObject({ provider: "codex", ownerUserId: user });
  const { seen, dispatch } = recording();
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "codex", model: null, now });
  await models(dispatch).generate(ask(ws, { actorUserId: user }));
  expect(seen.at(-1)!.apiKey.trim()).toBe('{"tokens":"device"}');
}, 30_000);

test("a login with no CLI, or that never shows a link, stops cleanly", async () => {
  const { ws, user } = await setup();
  process.env.PATH = "/nonexistent";
  expect(await startLogin("claude_code")).toEqual({ ok: false, reason: "not_installed" });
  expect(await beginSignIn({ deployment: "self_host", workspaceId: ws, userId: user, provider: "codex", shared: true })).toEqual({ ok: false, reason: "not_installed" });
  process.env.PATH = `${fakeBin("claude", "echo nothing useful")}:${PATH}`;
  expect(await startLogin("claude_code")).toEqual({ ok: false, reason: "no_link" });
}, 40_000);

test("a choice with no passing eval calls back in its transaction, on self-host only; a passing one doesn't", async () => {
  const { ws, user } = await setup();
  const called: (string | "all")[] = [];
  const onUnevaluated = async (_tx: unknown, agent: string) => called.push(agent) && 3;
  expect(await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: null, now, onUnevaluated })).toEqual({ suspendedRules: 3 });
  expect(await chooseForAgent({ deployment: "self_host", workspaceId: ws, actorUserId: user, agent: "brand_reader", adapter: "claude_code", model: null, now, onUnevaluated })).toEqual({ suspendedRules: 3 });
  expect(called).toEqual(["all", "brand_reader"]);
  expect(await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: "claude-sonnet-5-5", now, onUnevaluated, evaluated: () => true })).toEqual({ suspendedRules: 0 });
  await chooseAdapter({ deployment: "cloud", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: null, now, onUnevaluated });
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: null, model: null, now, onUnevaluated });
  expect(await chooseForAgent({ deployment: "self_host", workspaceId: ws, actorUserId: user, agent: "brand_reader", adapter: null, model: null, now, onUnevaluated })).toEqual({ suspendedRules: 0 });
  expect(called).toHaveLength(2);
  await expect(chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: null, now, onUnevaluated: async () => { throw new Error("rolled back"); } })).rejects.toThrow("rolled back");
});

test("an agent's choice is unevaluated without a model, or when the eval covers another agent or model", async () => {
  const { ws, user } = await setup();
  const called: string[] = [];
  const onUnevaluated = async (_tx: unknown, agent: string) => called.push(agent);
  const evaluated = (agent: string, adapter: string, model: string) => agent === "plan_drafter" && adapter === "claude_code" && model === "claude-haiku-5-5";
  const pick = (agent: string, model: string | null) => chooseForAgent({ deployment: "self_host", workspaceId: ws, actorUserId: user, agent, adapter: "claude_code", model, now, onUnevaluated, evaluated });
  await pick("plan_drafter", "claude-haiku-5-5");
  expect(called).toEqual([]);
  await pick("plan_drafter", null);
  await pick("plan_drafter", "claude-sonnet-5-5");
  await pick("brand_reader", "claude-haiku-5-5");
  expect(called).toEqual(["plan_drafter", "plan_drafter", "brand_reader"]);
  const listed = await listAdapters("self_host", ws, user, evaluated);
  if (listed === "cloud_managed") throw new Error("self-host lists");
  expect(listed.agents.map((a) => [a.agent, a.evaluated]).sort()).toEqual([["brand_reader", false], ["plan_drafter", false]]);
});

test("every set and clear of an agent's choice leaves one revision with who did it, and a refused one leaves none", async () => {
  const { ws, user, other } = await setup();
  const base = { workspaceId: ws, agent: "plan_drafter", now };
  await chooseForAgent({ ...base, deployment: "self_host", actorUserId: user, adapter: "codex", model: "gpt-6-sol" });
  expect(await chooseForAgent({ ...base, deployment: "self_host", actorUserId: user, adapter: "codex", model: "made-up" })).toBe("unknown_model");
  expect(await chooseForAgent({ ...base, deployment: "self_host", actorUserId: user, adapter: "anthropic", model: "pinned-model" })).toBe("unknown_adapter");
  await chooseForAgent({ ...base, deployment: "self_host", actorUserId: other, adapter: null, model: null });
  await chooseForAgent({ ...base, deployment: "cloud", actorUserId: user, adapter: "anthropic", model: "pinned-model", overrideAllowed: () => true });
  expect(await repo.agentChoiceRevisions(ws, "plan_drafter")).toEqual([
    { adapter: "codex", model: "gpt-6-sol", changedBy: user },
    { adapter: null, model: null, changedBy: other },
    { adapter: "anthropic", model: "pinned-model", changedBy: user },
  ]);
  await expect(q(ws, "update agent_model_choice_revisions set agent = 'x'")).rejects.toThrow(/permission denied/);
  await expect(q(ws, "delete from agent_model_choice_revisions")).rejects.toThrow(/permission denied/);
});

test("cloud takes only a provider and model the eval vouches for", async () => {
  const { ws, user } = await setup();
  const asked: string[] = [];
  const overrideAllowed = (agent: string, provider: string, model: string) => asked.push(`${agent} ${provider} ${model}`) > 0 && model === "pinned-model";
  const base = { deployment: "cloud" as const, workspaceId: ws, actorUserId: user, agent: "plan_drafter", now, overrideAllowed };
  expect(await chooseForAgent({ ...base, adapter: "claude_code", model: "claude-haiku-5-5" })).toBe("unknown_adapter");
  expect(await chooseForAgent({ ...base, adapter: "anthropic", model: null })).toBe("not_evaluated");
  expect(await chooseForAgent({ ...base, adapter: "anthropic", model: "other-model" })).toBe("not_evaluated");
  expect(await chooseForAgent({ ...base, adapter: "anthropic", model: "pinned-model", overrideAllowed: undefined })).toBe("not_evaluated");
  expect(await chooseForAgent({ ...base, adapter: "anthropic", model: "pinned-model" })).toEqual({ suspendedRules: 0 });
  expect(asked).toEqual(["plan_drafter anthropic other-model", "plan_drafter anthropic pinned-model"]);
  expect(await repo.adapterChoice(ws, "plan_drafter")).toEqual({ adapter: "anthropic", model: "pinned-model" });
});

test("whether an agent's calls would go to a subscription follows the same pick as a call, and asks nothing of a model", async () => {
  const { ws, user } = await setup();
  const { seen, dispatch } = recording();
  const m = models(dispatch);
  // No pick: the route's API candidate, which is no subscription.
  expect(await m.runsOnSubscription(ws, { agent: "names_reader", purpose: "plain", actorUserId: user })).toBe(false);
  await addSignIn(ws, "claude_code", null, user, "c");
  await chooseAdapter({ deployment: "self_host", workspaceId: ws, actorUserId: user, adapter: "claude_code", model: "claude-sonnet-5-5", now });
  expect(await m.runsOnSubscription(ws, { agent: "names_reader", purpose: "plain", actorUserId: user })).toBe(true);
  // A safety purpose keeps its pinned route, whatever was picked.
  expect(await m.runsOnSubscription(ws, { agent: "names_reader", purpose: "optout_detect", actorUserId: user })).toBe(false);
  expect(seen).toEqual([]);
  // Cloud never routes to a subscription.
  expect(await models(dispatch, "cloud").runsOnSubscription(ws, { agent: "names_reader", purpose: "plain", actorUserId: user })).toBe(false);
});

test("Writing quality offers only models all three drafters have passed on", async () => {
  const { ws, user } = await setup();
  // Sonnet passed for every drafter; Haiku is missing the email drafter's eval.
  const evaluated = (agent: string, adapter: string, model: string) =>
    adapter === "claude_code" && (model === "claude-sonnet-5-5" || (model === "claude-haiku-5-5" && agent !== "recipient_writer"));
  const listed = await listAdapters("self_host", ws, user, evaluated);
  if (listed === "cloud_managed") throw new Error("self-host");
  expect(listed.adapters.find((a) => a.id === "claude_code")!.writing).toEqual(["claude-sonnet-5-5"]);
  expect(listed.adapters.find((a) => a.id === "codex")!.writing).toEqual([]);
});
