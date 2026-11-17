// SPDX-License-Identifier: AGPL-3.0-only
// generate through the real AI SDK against a fake provider over real HTTP, as the app role.
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import { appClient, insertAuthUser } from "../../../../../test/db";
import { withBudget } from "../ledger/index";
import type { Keys } from "./adapters/keys";
import * as repo from "./adapters/repo";
import type { Price } from "./domain/cost";
import type { Candidate, Provider, Route } from "./domain/routes-check";
import { createModels, type ModelRequest } from "./index";
import { anthropicText, anthropicTool, fakeProvider, openRouterText, testKeys } from "./test-provider";


const API_KEY = "sk-test-do-not-leak";
const NOW = new Date("2026-11-15T12:00:00Z");
// 1,000 input and 100 output tokens cost 3,000 + 1,500 micro-dollars here.
const price: Price = { input: 3_000_000n, output: 15_000_000n, cacheRead: 300_000n, cacheWrite: 3_750_000n };
const main: Candidate = { provider: "anthropic", model: "main-20260101", maxOutputTokens: 100, price, evalRef: "evals/x" };
const cheap: Candidate = { ...main, model: "cheap-20260101", price: { ...price, output: 0n, input: 0n, cacheWrite: 0n } };
const ROUTES: Record<string, Route> = {
  plain: { candidates: [main] },
  stepping: { candidates: [main], stepDown: [cheap] },
  fallback: { candidates: [main, { ...main, model: "second-20260101" }] },
  optout_detect: { candidates: [main] },
  // The SDK asks for native JSON only for a model id it knows.
  typed: { candidates: [{ ...main, model: "claude-haiku-5-5" }] },
};

let c: Awaited<ReturnType<typeof appClient>>;
const fake = fakeProvider();
beforeAll(async () => {
  c = await appClient();
});
afterAll(async () => {
  await c.end();
  await fake.stop();
});

async function q(ws: string, text: string, params: unknown[] = []) {
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

async function newWorkspace() {
  const org = crypto.randomUUID();
  const ws = crypto.randomUUID();
  await q(ws, "insert into organizations (id, name, created_at) values ($1, 'O', now())", [org]);
  await q(ws, "insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())", [ws, org]);
  return ws;
}

const cloud = (over: Partial<Parameters<typeof createModels>[0]> = {}) =>
  createModels({
    deployment: "cloud",
    routes: ROUTES,
    keys: testKeys(API_KEY),
    baseURLs: { anthropic: fake.url },
    now: () => NOW,
    runGate: async () => ({ live: true, tainted: false }),
    ...over,
  });

/** A self-host install with a key for each named provider, without going through the vault. */
const selfHost = (providers: Provider[], over: Partial<Parameters<typeof createModels>[0]> = {}) => {
  const keys: Keys = {
    available: async () => new Set(providers),
    withKey: async (_ws, _p, fn) => fn(API_KEY),
    kindOf: (p) => (p === "openrouter" ? "openrouter" : "byok_api_key"),
  };
  return cloud({ deployment: "self_host", keys, ...over });
};

const request = (ws: string, over: Partial<ModelRequest> = {}): ModelRequest => ({
  workspaceId: ws,
  purpose: "plain",
  idempotencyKey: crypto.randomUUID(),
  parts: [{ role: "user", kind: "definition", text: "hello" }],
  ...over,
});
const call = async (ws: string, id: string | null) => (await q(ws, "select * from model_calls where id = $1", [id]))[0];
const run = (over = {}) => ({ id: crypto.randomUUID(), claimToken: "1", costCapMicros: 1_000_000n, attempt: 0, ...over });

test("a call runs through the SDK and leaves one row with model, tokens and cost", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => anthropicText("OK"));
  const r = await cloud().generate(request(ws));
  expect(r).toMatchObject({ ok: true, output: "OK", trust: "trusted", toolCalls: [] });
  const row = await call(ws, r.callId);
  expect(row).toMatchObject({
    status: "completed",
    provider: "anthropic",
    requested_model: "main-20260101",
    resolved_model: "served-model",
    credential_kind: "cloud_contract",
    input_tokens: 1000,
    output_tokens: 100,
    cost_micros: "4500",
    cost_status: "estimated",
    over_reserved: true,
  });
  expect(row.route_hash).toMatch(/^[0-9a-f]{64}$/);
});

test("the row and reservation exist before the provider is called", async () => {
  const ws = await newWorkspace();
  let during: Record<string, unknown>[] = [];
  const models = cloud({
    dispatch: async () => {
      during = await q(ws, "select m.status, b.status as hold from model_calls m join budget_reservations b on b.id = m.reservation_id");
      return { ok: false, family: "configuration", definite: true };
    },
  });
  await models.generate(request(ws));
  expect(during).toEqual([{ status: "dispatched", hold: "held" }]);
});

test("no prompt or response text reaches any column, on success or failure", async () => {
  const ws = await newWorkspace();
  const marker = "MARKER-7f3a";
  const parts = [{ role: "user" as const, kind: "inbound_message", text: marker, ref: { kind: "email", id: "e1" } }];
  fake.respondWith(() => anthropicText(marker));
  const ok = await cloud().generate(request(ws, { parts }));
  fake.respondWith(() => new Response(marker, { status: 500 }));
  const bad = await cloud().generate(request(ws, { parts }));
  for (const r of [ok, bad]) expect(JSON.stringify(await call(ws, r.callId))).not.toContain(marker);
  expect((await call(ws, ok.callId)).untrusted_sources).toEqual([{ kind: "email", id: "e1" }]);
});

test("a repeated key is refused with the first call's id and makes no dispatch", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => anthropicText("OK"));
  const req = request(ws);
  const first = await cloud().generate(req);
  const before = fake.received.length;
  const again = await cloud().generate(req);
  expect(again).toEqual({ ok: false, callId: first.callId, refusal: "duplicate" });
  expect(fake.received.length).toBe(before);
});

test("a key that was only refused may run again once the limit clears", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => anthropicText("OK"));
  const req = request(ws);
  const tiny = run({ costCapMicros: 1n });
  expect(await cloud().generate({ ...req, run: tiny })).toMatchObject({ refusal: "run_cap" });
  expect(await cloud().generate({ ...req, run: { ...tiny, costCapMicros: 1_000_000n } })).toMatchObject({ ok: true });
  expect(await q(ws, "select status, refusal from model_calls")).toEqual([{ status: "completed", refusal: null }]);
});

test("the API key appears in no row or result, even when the provider echoes it", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => new Response(`bad key ${API_KEY}`, { status: 401 }));
  const r = await cloud().generate(request(ws));
  expect(r).toMatchObject({ ok: false, errorFamily: "configuration" });
  expect(JSON.stringify(r)).not.toContain(API_KEY);
  expect(JSON.stringify(await call(ws, r.callId))).not.toContain(API_KEY);
});

const effect = { name: "send", description: "x", class: "effect" as const, inputSchema: z.object({}) };
const lookup = { name: "lookup", description: "x", class: "read" as const, inputSchema: z.object({ q: z.string() }) };
const inbound = [{ role: "user" as const, kind: "inbound_message", text: "hi" }];

test("an untrusted call with an effect tool is refused and recorded, and nothing is sent", async () => {
  const ws = await newWorkspace();
  const before = fake.received.length;
  const r = await cloud().generate(request(ws, { parts: inbound, tools: [lookup, effect] }));
  expect(r).toMatchObject({ ok: false, refusal: "effect_tool_on_untrusted" });
  expect((await call(ws, r.callId)).refusal).toBe("effect_tool_on_untrusted");
  expect(fake.received.length).toBe(before);
});

test("an untrusted call offers only read tools, records them, and its output is untrusted", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => anthropicTool("lookup", { q: "x" }));
  const r = await cloud().generate(request(ws, { parts: inbound, tools: [lookup] }));
  expect(r).toMatchObject({ ok: true, trust: "untrusted", toolCalls: [{ toolName: "lookup", input: { q: "x" } }] });
  const sent = fake.received.at(-1)!.body.tools as { name: string }[];
  expect(sent.map((t) => t.name)).toEqual(["lookup"]);
  const row = await call(ws, r.callId);
  expect(row.tools_offered).toEqual(["lookup"]);
  expect(row.trust).toBe("untrusted");
});

test("trusted parts in a run the gate reports tainted make an untrusted call", async () => {
  const ws = await newWorkspace();
  const models = cloud({ runGate: async () => ({ live: true, tainted: true }) });
  const r = await models.generate(request(ws, { tools: [effect], run: run() }));
  expect(r).toMatchObject({ refusal: "effect_tool_on_untrusted" });
});

test("a part with an unlisted kind makes the call untrusted", async () => {
  const ws = await newWorkspace();
  const r = await cloud().generate(request(ws, { parts: [{ role: "user", kind: "brand_new", text: "x" }], tools: [effect] }));
  expect(r).toMatchObject({ refusal: "effect_tool_on_untrusted" });
});

test("a request that names a model, a key or a trust level fails validation", async () => {
  const ws = await newWorkspace();
  // @ts-expect-error callers cannot name a model
  await expect(cloud().generate({ ...request(ws), model: "x" })).rejects.toThrow();
  // @ts-expect-error callers cannot pass a credential
  await expect(cloud().generate({ ...request(ws), credentialId: "x" })).rejects.toThrow();
  // @ts-expect-error callers cannot state trust
  await expect(cloud().generate(request(ws, { parts: [{ role: "user", kind: "definition", text: "x", trust: "trusted" }] }))).rejects.toThrow();
  // @ts-expect-error parts cannot be a raw prompt string
  await expect(cloud().generate(request(ws, { parts: "hello" }))).rejects.toThrow();
});

test("typed output comes back parsed", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => anthropicText(JSON.stringify({ answer: 42 })));
  const r = await cloud().generate(request(ws, { purpose: "typed", output: z.object({ answer: z.number() }) }));
  expect(r).toMatchObject({ ok: true, output: { answer: 42 } });
});

test("output that fails its schema is charged and returned as a refusal family", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => anthropicText(JSON.stringify({ wrong: true })));
  const r = await cloud().generate(request(ws, { purpose: "typed", output: z.object({ answer: z.number() }) }));
  expect(r).toMatchObject({ ok: false, errorFamily: "model_refusal" });
  expect(await call(ws, r.callId)).toMatchObject({ status: "failed", cost_micros: "4500", cost_status: "estimated" });
});

test("a run past its remaining cap is refused before dispatch, counting earlier calls", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => anthropicText("OK"));
  const id = crypto.randomUUID();
  // Worst case of "hello" and an empty tool list: 4 tokens at $3.75 per million, 100 at $15.
  expect(await cloud().generate(request(ws, { run: run({ id, costCapMicros: 1_514n }) }))).toMatchObject({ refusal: "run_cap" });
  expect(await cloud().generate(request(ws, { run: run({ id, costCapMicros: 1_515n }) }))).toMatchObject({ ok: true });
  // The success settled at 4,500, so nothing is left under a 5,000 cap.
  const before = fake.received.length;
  expect(await cloud().generate(request(ws, { run: run({ id, costCapMicros: 5_000n }) }))).toMatchObject({ refusal: "run_cap" });
  expect(fake.received.length).toBe(before);
});

test("a run whose claim is stale is refused before reserving", async () => {
  const ws = await newWorkspace();
  const models = cloud({ runGate: async () => ({ live: false, tainted: false }) });
  expect(await models.generate(request(ws, { run: run() }))).toMatchObject({ refusal: "stale_claim" });
  expect(await q(ws, "select 1 from budget_reservations")).toEqual([]);
});

const setSettings = async (ws: string, micros: bigint, allowUnpriced = false) => {
  const user = crypto.randomUUID();
  await insertAuthUser(user);
  await q(ws, "insert into model_settings_revisions (workspace_id, monthly_budget_micros, allow_unpriced, changed_by, created_at) values ($1, $2, $3, $4, now())", [ws, micros.toString(), allowUnpriced, user]);
};
const spend = (ws: string, micros: bigint) =>
  withBudget(ws, async (b) => {
    const id = await b.hold("model", micros, NOW);
    await b.settle(id, micros, NOW);
  });

test("cloud past the budget steps down, showing the new route hash; with none it stops", async () => {
  const ws = await newWorkspace();
  await setSettings(ws, 10_000n);
  await spend(ws, 9_000n);
  fake.respondWith(() => anthropicText("OK"));
  const stepped = await cloud().generate(request(ws, { purpose: "stepping" }));
  expect(await cloud().generate(request(ws))).toMatchObject({ refusal: "budget_stop" });
  const row = await call(ws, stepped.callId);
  expect(row.requested_model).toBe("cheap-20260101");
  expect(stepped).toMatchObject({ routeHash: row.route_hash });
});

test("cloud stops past twice the budget, even with a step-down", async () => {
  const ws = await newWorkspace();
  await setSettings(ws, 10_000n);
  await spend(ws, 20_000n);
  const routes: Record<string, Route> = { stepping: { candidates: [main], stepDown: [{ ...cheap, price }] } };
  expect(await cloud({ routes }).generate(request(ws, { purpose: "stepping" }))).toMatchObject({ refusal: "budget_stop" });
});

test("self-host stops at the budget, even with a cheaper route", async () => {
  const ws = await newWorkspace();
  await setSettings(ws, 1_000n);
  await spend(ws, 1_000n);
  const before = fake.received.length;
  expect(await selfHost(["anthropic"]).generate(request(ws, { purpose: "stepping" }))).toMatchObject({ refusal: "budget_stop" });
  expect(fake.received.length).toBe(before);
});

test("a safety purpose runs past the ceiling, and its spend still counts", async () => {
  const ws = await newWorkspace();
  await setSettings(ws, 1_000n);
  await spend(ws, 5_000n);
  fake.respondWith(() => anthropicText("OK"));
  expect(await cloud().generate(request(ws, { purpose: "optout_detect" }))).toMatchObject({ ok: true });
  expect(await withBudget(ws, (b) => b.settled("model", NOW))).toBe(9_500n);
});

test("a safety purpose stops at its daily limit, counted across the UTC day", async () => {
  const ws = await newWorkspace();
  await q(
    ws,
    `insert into model_calls (workspace_id, idempotency_key, purpose, trust, status, created_at)
     select $1, 'old' || g, 'claim_check', 'trusted', 'completed', $2::timestamptz from generate_series(1, 5000) g`,
    [ws, NOW.toISOString()],
  );
  expect(await cloud().generate(request(ws, { purpose: "optout_detect" }))).toMatchObject({ refusal: "safety_daily_cap" });
  const tomorrow = cloud({ now: () => new Date(NOW.getTime() + 86_400_000) });
  fake.respondWith(() => anthropicText("OK"));
  expect(await tomorrow.generate(request(ws, { purpose: "optout_detect" }))).toMatchObject({ ok: true });
});

const unpriced = { plain: { candidates: [{ ...main, price: null }] } };

test("a model with no price is refused on cloud, and on self-host until an Admin opts in", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => anthropicText("OK"));
  expect(await cloud({ routes: unpriced }).generate(request(ws))).toMatchObject({ refusal: "unpriced" });
  expect(await selfHost(["anthropic"], { routes: unpriced }).generate(request(ws))).toMatchObject({ refusal: "unpriced" });
  await setSettings(ws, 1_000_000n, true);
  expect(await cloud({ routes: unpriced }).generate(request(ws))).toMatchObject({ refusal: "unpriced" });
  const r = await selfHost(["anthropic"], { routes: unpriced }).generate(request(ws));
  expect(r).toMatchObject({ ok: true });
  expect(await call(ws, r.callId)).toMatchObject({ cost_status: "unpriced", cost_micros: "0", input_tokens: 1000 });
});

test("no key for any candidate is no_connection; an unknown purpose is no_route", async () => {
  const ws = await newWorkspace();
  expect(await cloud({ keys: testKeys(null) }).generate(request(ws))).toMatchObject({ refusal: "no_connection" });
  expect(await cloud().generate(request(ws, { purpose: "nope" }))).toMatchObject({ refusal: "no_route" });
});

test("a key that became unusable after the reservation releases it", async () => {
  const ws = await newWorkspace();
  const keys: Keys = { available: async () => new Set(["anthropic"]), withKey: async () => null, kindOf: () => "byok_api_key" };
  const r = await cloud({ deployment: "self_host", keys }).generate(request(ws));
  expect(r).toMatchObject({ refusal: "credential_unavailable" });
  expect(await q(ws, "select status from budget_reservations")).toEqual([{ status: "released" }]);
});

test("the SDK does not retry: a 503 is one request, returns its family and frees the hold", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => new Response("down", { status: 503 }));
  const before = fake.received.length;
  const r = await cloud().generate(request(ws));
  expect(r).toMatchObject({ ok: false, errorFamily: "transient_upstream" });
  expect(fake.received.length).toBe(before + 1);
  expect(await q(ws, "select status from budget_reservations")).toEqual([{ status: "released" }]);
});

test("a 429 returns provider_quota and when to retry", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => new Response("slow", { status: 429, headers: { "retry-after": "30" } }));
  const r = await cloud().generate(request(ws));
  expect(r).toMatchObject({ ok: false, errorFamily: "provider_quota" });
  expect("retryNotBefore" in r && r.retryNotBefore!.getTime()).toBeGreaterThan(Date.now());
});

test("a retry writes its own row and uses the next candidate", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => anthropicText("OK"));
  const id = crypto.randomUUID();
  const a = await cloud().generate(request(ws, { purpose: "fallback", run: run({ id }) }));
  const b = await cloud().generate(request(ws, { purpose: "fallback", run: run({ id, attempt: 1 }) }));
  expect((await call(ws, a.callId)).requested_model).toBe("main-20260101");
  expect(await call(ws, b.callId)).toMatchObject({ requested_model: "second-20260101", attempt: 1 });
});

test("an abort has no receipt, so the full hold is charged as unknown", async () => {
  const ws = await newWorkspace();
  fake.respondWith(() => new Promise<Response>(() => {}));
  const abort = new AbortController();
  const pending = cloud().generate(request(ws, { abortSignal: abort.signal }));
  setTimeout(() => abort.abort(), 50);
  const r = await pending;
  expect(r).toMatchObject({ ok: false, errorFamily: "no_receipt" });
  const row = await call(ws, r.callId);
  expect(row).toMatchObject({ status: "failed", cost_status: "unknown" });
  expect(BigInt(row.cost_micros)).toBeGreaterThan(0n);
  expect(await q(ws, "select status from budget_reservations")).toEqual([{ status: "settled" }]);
});

test("OpenRouter calls forbid fallbacks and data collection, and its reported cost counts", async () => {
  const ws = await newWorkspace();
  await setSettings(ws, 1_000_000n, true);
  fake.respondWith(() => openRouterText("OK", 0.0012));
  const routes = { plain: { candidates: [{ ...main, provider: "openrouter" as const, model: "vendor/model", price: null }] } };
  const r = await selfHost(["openrouter"], { routes, baseURLs: { openrouter: fake.url } }).generate(request(ws));
  expect(r).toMatchObject({ ok: true, output: "OK" });
  expect(fake.received.at(-1)!.body.provider).toMatchObject({ allow_fallbacks: false, data_collection: "deny" });
  expect(await call(ws, r.callId)).toMatchObject({ credential_kind: "openrouter", cost_status: "reported", cost_micros: "1200" });
  expect(await withBudget(ws, (b) => b.settled("model", NOW))).toBe(1_200n);
});

test("cloud runs an agent's choice while its eval passes, falls back and tells Admins once when it stops, and picks it up again", async () => {
  const ws = await newWorkspace();
  const admin = crypto.randomUUID();
  await insertAuthUser(admin);
  await repo.setAgentChoice(ws, "plan_drafter", "anthropic", "second-20260101", admin, NOW);
  let passing = true;
  const notices: { agent: string; model: string }[] = [];
  const models = cloud({ overrideAllowed: (_agent, _provider, model) => passing && model === "second-20260101", notifyPaused: async (_ws, p) => void notices.push(p) });
  const model = async (over: Partial<ModelRequest>) => (await call(ws, (await models.generate(request(ws, over))).callId)).requested_model;
  fake.respondWith(() => anthropicText("OK"));

  expect(await model({ purpose: "fallback", agent: "plan_drafter" })).toBe("second-20260101");
  expect(await model({ purpose: "fallback", agent: "brand_reader" })).toBe("main-20260101");
  // Not in this purpose's route, so the default runs there.
  expect(await model({ purpose: "plain", agent: "plan_drafter" })).toBe("main-20260101");
  expect(notices).toHaveLength(1);
  notices.length = 0;
  await repo.resumeChoice(ws, "plan_drafter");

  passing = false;
  expect(await model({ purpose: "fallback", agent: "plan_drafter" })).toBe("main-20260101");
  expect(await model({ purpose: "fallback", agent: "plan_drafter" })).toBe("main-20260101");
  expect(notices).toEqual([{ agent: "plan_drafter", model: "second-20260101" }]);
  expect((await repo.ownChoice(ws, "plan_drafter"))?.pausedAt).toEqual(NOW);

  passing = true;
  expect(await model({ purpose: "fallback", agent: "plan_drafter" })).toBe("second-20260101");
  expect((await repo.ownChoice(ws, "plan_drafter"))?.pausedAt).toBeNull();
  expect(notices).toHaveLength(1);
});

test("no choice reaches a safety purpose, on cloud or self-host", async () => {
  const ws = await newWorkspace();
  const admin = crypto.randomUUID();
  await insertAuthUser(admin);
  await repo.setAgentChoice(ws, "plan_drafter", "anthropic", "second-20260101", admin, NOW);
  fake.respondWith(() => anthropicText("OK"));
  const asked: string[] = [];
  const onCloud = cloud({ routes: { ...ROUTES, optout_detect: { candidates: [main, { ...main, model: "second-20260101" }] } }, overrideAllowed: () => asked.push("asked") > 0 });
  const r = await onCloud.generate(request(ws, { purpose: "optout_detect", agent: "plan_drafter" }));
  expect((await call(ws, r.callId)).requested_model).toBe("main-20260101");
  expect(asked).toEqual([]);
  await repo.setAgentChoice(ws, "plan_drafter", "codex", "gpt-6-sol", admin, NOW);
  const s = await selfHost(["anthropic"]).generate(request(ws, { purpose: "optout_detect", agent: "plan_drafter" }));
  expect((await call(ws, s.callId)).requested_model).toBe("main-20260101");
});
