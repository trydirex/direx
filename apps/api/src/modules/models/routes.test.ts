// SPDX-License-Identifier: AGPL-3.0-only
// The whole path over HTTP on self-host: an Admin stores a key in the real vault, connects
// it, tests it against a fake provider, and sees the call. Then who may do what, and cloud.
import { afterAll, afterEach, expect, test, vi } from "vitest";
import { createVault, credentialRoutes, rootKeyFromEnv } from "../credentials/index";
import { setSystemSecret, SYSTEM_WORKSPACE_ID } from "../credentials/system-secrets";
import { createIdentity, logMailer, type Mail } from "../identity/index";
import { codexBinary, useCodexBinaryForTests } from "./adapters/runtime/codex";
import { createModels, modelRoutes, type Deployment } from "./index";
import { routesFor } from "./purposes";
import { anthropicText, fakeProvider } from "./test-provider";

const SECRET = "sk-real-looking-key";
const fake = fakeProvider();
afterAll(() => fake.stop());
afterEach(() => vi.useRealTimers());

const vault = createVault({
  rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "00".repeat(31) + "de" }),
  now: () => new Date(),
  providers: [],
  callbackUrl: "http://direx.test/api/connections/callback",
});

function testIdentity() {
  const outbox: Mail[] = [];
  const { routes, auth } = createIdentity(() => ({
    baseURL: "http://localhost:3000",
    secret: "test-secret-that-is-at-least-32-characters",
    devMode: true,
    mailer: logMailer(outbox),
  }));
  const call = (path: string, cookie?: string, init: { method?: string; body?: unknown } = {}) =>
    routes.request(path, {
      method: init.method ?? "GET",
      headers: { ...(cookie && { cookie }), ...(init.body !== undefined && { "content-type": "application/json" }) },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
  const lastUrl = (email: string, pattern: RegExp) => [...outbox].reverse().find((m) => m.to === email && pattern.test(m.text))!.text.match(pattern)!;
  async function signIn(email = `${crypto.randomUUID()}@example.com`): Promise<string> {
    expect((await call("/api/auth/sign-in/magic-link", undefined, { method: "POST", body: { email, callbackURL: "/" } })).status).toBe(200);
    const verified = await routes.request(lastUrl(email, /https?:\/\/\S+/)[0]);
    return verified.headers.get("set-cookie")!.split(";")[0]!;
  }
  async function createOrg(cookie: string) {
    const res = await call("/api/orgs", cookie, { method: "POST", body: { name: "Acme", workspaceName: "Acme marketing" } });
    expect(res.status).toBe(201);
    return (await res.json()) as { workspace: { id: string } };
  }
  async function addMember(inviterCookie: string, workspaceId: string, role: string) {
    const email = `${crypto.randomUUID()}@example.com`;
    expect((await call(`/api/w/${workspaceId}/invites`, inviterCookie, { method: "POST", body: { email, role } })).status).toBe(201);
    const cookie = await signIn(email);
    const token = lastUrl(email, /\/invite\/[0-9a-f-]+\/([0-9a-f]{64})/)[1];
    expect((await call("/api/invites/accept", cookie, { method: "POST", body: { workspaceId, token } })).status).toBe(200);
    return { cookie };
  }
  return { routes, auth, signIn, call, createOrg, addMember };
}

function appFor(deployment: Deployment) {
  const t = testIdentity();
  const models = createModels({
    deployment,
    routes: routesFor(deployment),
    vault: () => vault,
    baseURLs: { anthropic: fake.url },
  });
  t.routes.route("/", credentialRoutes({ auth: t.auth, vault: () => vault, baseURL: () => "http://direx.test" }));
  t.routes.route("/", modelRoutes({ needs: { open: async () => {}, clear: async () => {} }, models: () => models, vault: () => vault, deployment: () => deployment }));
  return t;
}

await setSystemSecret(vault, "provider.anthropic", "direx-own-key");

const selfHost = appFor("self_host");
const cloud = appFor("cloud");

async function workspace(t = selfHost) {
  const cookie = await t.signIn();
  const { workspace } = await t.createOrg(cookie);
  return { cookie, ws: workspace.id, base: `/api/w/${workspace.id}` };
}

async function addKey(cookie: string, base: string, over: Record<string, unknown> = {}) {
  const res = await selfHost.call(`${base}/credentials`, cookie, {
    method: "POST",
    body: { scope: "workspace", kind: "api_key", key: `k${crypto.randomUUID()}`, name: "Anthropic key", meta: {}, value: { key: SECRET }, ...over },
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { credential: { id: string } }).credential.id;
}

test("connect a key, test it, and see the call and its cost, with no key in any response", async () => {
  const { cookie, base } = await workspace();
  const id = await addKey(cookie, base);
  const put = await selfHost.call(`${base}/models/connections/anthropic`, cookie, { method: "PUT", body: { credentialId: id } });
  expect(put.status).toBe(200);

  fake.respondWith(() => anthropicText("OK", { input_tokens: 10, output_tokens: 2 }));
  const before = fake.received.length;
  const tested = await selfHost.call(`${base}/models/connections/anthropic/test`, cookie, { method: "POST" });
  const result = (await tested.json()) as { ok: boolean; reason: string | null };
  expect(result).toMatchObject({ ok: true, reason: null });
  expect(fake.received.length).toBe(before + 1);
  expect(fake.received.at(-1)!.headers.get("x-api-key")).toBe(SECRET);

  const list = await (await selfHost.call(`${base}/models/connections`, cookie)).text();
  expect(JSON.parse(list).providers).toContainEqual({ provider: "anthropic", connected: true, credentialId: id, credentialName: "Anthropic key" });

  const calls = await (await selfHost.call(`${base}/models/calls`, cookie)).text();
  expect(JSON.parse(calls).calls[0]).toMatchObject({ purpose: "connection_test", model: "claude-haiku-5-5", status: "completed", inputTokens: 10, outputTokens: 2, costStatus: "estimated" });

  const usage = await (await selfHost.call(`${base}/models/usage`, cookie)).text();
  expect(JSON.parse(usage).rows).toEqual([{ purpose: "connection_test", model: "claude-haiku-5-5", calls: 1, costMicros: "2" }]);
  for (const body of [list, calls, usage]) expect(body).not.toContain(SECRET);

  const events = await (await selfHost.call(`${base}/credentials/${id}/events`, cookie)).json() as { events: { consumer: string }[] };
  expect(events.events.map((e) => e.consumer)).toContain("model_call");
});

test("only an active Workspace API key can be connected", async () => {
  const { cookie, base } = await workspace();
  const put = (credentialId: string) => selfHost.call(`${base}/models/connections/anthropic`, cookie, { method: "PUT", body: { credentialId } });
  const mine = await addKey(cookie, base, { scope: "user" });
  const other = await addKey(cookie, base, { kind: "secret", value: { value: "x" } });
  for (const id of [mine, other, crypto.randomUUID()]) {
    const res = await put(id);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "credential_not_usable" });
  }
});

test("disconnecting a key makes the next test say so", async () => {
  const { cookie, base } = await workspace();
  await selfHost.call(`${base}/models/connections/anthropic`, cookie, { method: "PUT", body: { credentialId: await addKey(cookie, base) } });
  await selfHost.call(`${base}/models/connections/anthropic`, cookie, { method: "DELETE" });
  const r = await selfHost.call(`${base}/models/connections/anthropic/test`, cookie, { method: "POST" });
  expect(await r.json()).toMatchObject({ ok: false, reason: "no_connection" });
});

test("testing one provider never falls through to another", async () => {
  const { cookie, base } = await workspace();
  await selfHost.call(`${base}/models/connections/anthropic`, cookie, { method: "PUT", body: { credentialId: await addKey(cookie, base) } });
  const r = await selfHost.call(`${base}/models/connections/openai/test`, cookie, { method: "POST" });
  expect(await r.json()).toMatchObject({ ok: false, reason: "no_connection" });
});

test("settings write a revision each change, and any finite budget is allowed on self-host", async () => {
  const { cookie, base } = await workspace();
  const url = `${base}/models/settings`;
  expect(await (await selfHost.call(url, cookie)).json()).toEqual({ monthlyBudgetMicros: "50000000", allowUnpriced: false });
  const next = { monthlyBudgetMicros: "900000000", allowUnpriced: true };
  expect((await selfHost.call(url, cookie, { method: "PUT", body: next })).status).toBe(200);
  expect(await (await selfHost.call(url, cookie)).json()).toEqual(next);
  expect((await selfHost.call(url, cookie, { method: "PUT", body: { ...next, monthlyBudgetMicros: "0" } })).status).toBe(409);
});

test("cloud may lower the budget but not raise it, and refuses keys and the unpriced opt-in", async () => {
  const { cookie, base } = await workspace(cloud);
  const url = `${base}/models/settings`;
  expect(await (await cloud.call(url, cookie)).json()).toEqual({ monthlyBudgetMicros: "15000000", allowUnpriced: false });
  const put = (b: object) => cloud.call(url, cookie, { method: "PUT", body: b });
  expect((await put({ monthlyBudgetMicros: "5000000", allowUnpriced: false })).status).toBe(200);
  expect((await put({ monthlyBudgetMicros: "15000000", allowUnpriced: false })).status).toBe(200);
  expect(await (await put({ monthlyBudgetMicros: "15000001", allowUnpriced: false })).json()).toEqual({ error: "budget_not_allowed" });
  expect(await (await put({ monthlyBudgetMicros: "5000000", allowUnpriced: true })).json()).toEqual({ error: "unpriced_not_allowed" });

  const connect = await cloud.call(`${base}/models/connections/anthropic`, cookie, { method: "PUT", body: { credentialId: crypto.randomUUID() } });
  expect(await connect.json()).toEqual({ error: "cloud_managed" });
  const list = (await (await cloud.call(`${base}/models/connections`, cookie)).json()) as { deployment: string; providers: { provider: string; connected: boolean }[] };
  expect(list.deployment).toBe("cloud");
  expect(list.providers.map((p) => p.provider)).not.toContain("openrouter");
  expect(list.providers).toContainEqual({ provider: "anthropic", connected: true, credentialId: null, credentialName: null });
});

test("a Marketer reads usage but cannot touch settings or keys; a stale sign-in needs step-up", async () => {
  const { cookie, ws, base } = await workspace();
  const marketer = await selfHost.addMember(cookie, ws, "marketer");
  expect((await selfHost.call(`${base}/models/usage`, marketer.cookie)).status).toBe(200);
  expect((await selfHost.call(`${base}/models/calls`, marketer.cookie)).status).toBe(200);
  const denied = [
    selfHost.call(`${base}/models/settings`, marketer.cookie, { method: "PUT", body: { monthlyBudgetMicros: "1", allowUnpriced: false } }),
    selfHost.call(`${base}/models/connections/anthropic`, marketer.cookie, { method: "PUT", body: { credentialId: crypto.randomUUID() } }),
    selfHost.call(`${base}/models/connections/anthropic`, marketer.cookie, { method: "DELETE" }),
    selfHost.call(`${base}/models/connections/anthropic/test`, marketer.cookie, { method: "POST" }),
  ];
  for (const r of await Promise.all(denied)) expect(r.status).toBe(403);

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 11 * 60_000);
  const stale = await selfHost.call(`${base}/models/settings`, cookie, { method: "PUT", body: { monthlyBudgetMicros: "1", allowUnpriced: false } });
  expect(stale.status).toBe(403);
  expect(await stale.json()).toEqual({ error: "step_up_required" });
});

test("another Workspace's member gets 404 on every model route", async () => {
  const { base } = await workspace();
  const outsider = await selfHost.signIn();
  const routes: [string, string][] = [
    ["GET", "connections"],
    ["PUT", "connections/anthropic"],
    ["DELETE", "connections/anthropic"],
    ["POST", "connections/anthropic/test"],
    ["GET", "settings"],
    ["PUT", "settings"],
    ["GET", "usage"],
    ["GET", "calls"],
  ];
  for (const [method, path] of routes) {
    expect((await selfHost.call(`${base}/models/${path}`, outsider, { method, ...(method === "PUT" ? { body: {} } : {}) })).status).toBe(404);
  }
});

test("a bad month or body is a 400", async () => {
  const { cookie, base } = await workspace();
  expect((await selfHost.call(`${base}/models/usage?month=2026-13`, cookie)).status).toBe(400);
  expect((await selfHost.call(`${base}/models/settings`, cookie, { method: "PUT", body: { monthlyBudgetMicros: "-1", allowUnpriced: false } })).status).toBe(400);
  expect((await selfHost.call(`${base}/models/connections/mystery/test`, cookie, { method: "POST" })).status).toBe(400);
});

test("a cloud call uses Direx's key from the vault, on record, and a rotation applies to the next call", async () => {
  const { cookie, base } = await workspace(cloud);
  fake.respondWith(() => anthropicText("OK", { input_tokens: 10, output_tokens: 2 }));
  const test1 = await cloud.call(`${base}/models/connections/anthropic/test`, cookie, { method: "POST" });
  expect(await test1.json()).toMatchObject({ ok: true });
  expect(fake.received.at(-1)!.headers.get("x-api-key")).toBe("direx-own-key");
  const calls = (await (await cloud.call(`${base}/models/calls`, cookie)).json()) as { calls: unknown[] };
  expect(calls.calls[0]).toMatchObject({ status: "completed" });

  const [row] = (await vault.list(SYSTEM_WORKSPACE_ID)).filter((c) => c.key === "provider.anthropic");
  expect((await vault.events(SYSTEM_WORKSPACE_ID, row!.id)).map((e) => e.consumer)).toContain("model_call");

  await setSystemSecret(vault, "provider.anthropic", "direx-rotated-key");
  await cloud.call(`${base}/models/connections/anthropic/test`, cookie, { method: "POST" });
  expect(fake.received.at(-1)!.headers.get("x-api-key")).toBe("direx-rotated-key");
  await setSystemSecret(vault, "provider.anthropic", "direx-own-key");
});

test("no member of any Workspace reaches the system Workspace", async () => {
  const { cookie } = await workspace();
  const base = `/api/w/${SYSTEM_WORKSPACE_ID}`;
  for (const path of ["", "/credentials", "/models/connections", "/models/usage", "/members"]) {
    expect((await selfHost.call(`${base}${path}`, cookie)).status, path).toBe(404);
  }
  const mine = (await (await selfHost.call("/api/me/workspaces", cookie)).json()) as { workspaces: { id: string }[] };
  expect(mine.workspaces.map((w) => w.id)).not.toContain(SYSTEM_WORKSPACE_ID);
});

test("every test finds a stub that always fails before any real CLI", () => {
  for (const name of ["claude", "codex"]) expect(Bun.which(name, { PATH: process.env.PATH ?? "" })).toContain("direx-no-real-cli-");
  // Codex isn't looked up on PATH, so its stub is handed in too (DX-R-0036-003).
  expect(codexBinary()).toContain("direx-no-real-cli-");
});

test("the picker over HTTP: who may do what, a choice saved, a missing CLI named, and cloud refused", async () => {
  const { cookie, ws, base } = await workspace();
  const marketer = await selfHost.addMember(cookie, ws, "marketer");
  const choose = { method: "PUT", body: { adapter: "codex", model: "gpt-6-sol" } };

  for (const denied of [
    selfHost.call(`${base}/models/adapter`, marketer.cookie, choose),
    selfHost.call(`${base}/models/agents/brand_reader/adapter`, marketer.cookie, choose),
    selfHost.call(`${base}/models/adapters/codex/sign-in/shared`, marketer.cookie, { method: "POST" }),
    selfHost.call(`${base}/models/adapters/codex/sign-in/shared`, marketer.cookie, { method: "DELETE" }),
  ]) {
    expect((await denied).status).toBe(403);
  }

  expect((await selfHost.call(`${base}/models/adapter`, cookie, choose)).status).toBe(200);
  const saved = await selfHost.call(`${base}/models/agents/brand_reader/adapter`, cookie, { method: "PUT", body: { adapter: "claude_code", model: null } });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ ok: true, suspendedRules: 0 });
  expect((await selfHost.call(`${base}/models/adapter`, cookie, { method: "PUT", body: { adapter: "codex", model: "made-up" } })).status).toBe(409);

  const path = process.env.PATH;
  const shippedCodex = codexBinary();
  process.env.PATH = "/nonexistent";
  useCodexBinaryForTests(null);
  try {
    const list = (await (await selfHost.call(`${base}/models/adapters`, marketer.cookie)).json()) as { choice: unknown; agents: unknown[]; adapters: { id: string; blocked: string | null; shared: boolean }[] };
    expect(list.choice).toEqual({ adapter: "codex", model: "gpt-6-sol", evaluated: false });
    expect(list.agents).toEqual([{ agent: "brand_reader", adapter: "claude_code", model: null, evaluated: false }]);
    expect(list.adapters.map((a) => [a.id, a.blocked, a.shared])).toEqual([["claude_code", "not_installed", false], ["codex", "not_installed", false]]);

    const started = await selfHost.call(`${base}/models/adapters/codex/sign-in/personal`, marketer.cookie, { method: "POST" });
    expect(started.status).toBe(409);
    expect(await started.json()).toEqual({ error: "not_installed" });
    const tested = await selfHost.call(`${base}/models/adapters/codex/test`, marketer.cookie, { method: "POST" });
    expect(await tested.json()).toEqual({ ok: false, reason: "not_installed" });
  } finally {
    process.env.PATH = path;
    useCodexBinaryForTests(shippedCodex);
  }
  const finish = await selfHost.call(`${base}/models/sign-ins/${crypto.randomUUID()}/finish`, marketer.cookie, { method: "POST", body: { code: "x" } });
  expect(await finish.json()).toEqual({ error: "not_found" });
  const removed = await selfHost.call(`${base}/models/adapters/codex/sign-in/personal`, marketer.cookie, { method: "DELETE" });
  expect(await removed.json()).toEqual({ error: "not_found" });

  const onCloud = await workspace(cloud);
  for (const r of [
    cloud.call(`${onCloud.base}/models/adapters`, onCloud.cookie),
    cloud.call(`${onCloud.base}/models/adapter`, onCloud.cookie, choose),
    cloud.call(`${onCloud.base}/models/adapters/codex/sign-in/shared`, onCloud.cookie, { method: "POST" }),
  ]) {
    const res = await r;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "cloud_managed" });
  }
  // Cloud takes an agent's choice only from its route with a passing eval, which nothing vouches for here.
  for (const [body, error] of [
    [{ adapter: "codex", model: "gpt-6-sol" }, "unknown_adapter"],
    [{ adapter: "anthropic", model: "claude-haiku-5-5" }, "not_evaluated"],
  ] as const) {
    const res = await cloud.call(`${onCloud.base}/models/agents/plan_drafter/adapter`, onCloud.cookie, { method: "PUT", body });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error });
  }
});
