// SPDX-License-Identifier: AGPL-3.0-only
// Reoon against a local server. Answers follow Reoon's documented fields and a real check made on
// 2026-11-02; the real API is never called here.
import { type Plugin, VERIFY_ADDRESS, VERIFY_BALANCE, verifyAddressOutput, verifyBalanceOutput } from "@direx/plugin-sdk";
import { invoke } from "../test-wire";
import { afterAll, beforeEach, expect, test } from "vitest";
import { firstPartyPlugins } from "../index";
import { createReoonPlugin, REOON_DEFAULTS } from "./plugin";

const SENTINEL = "zz-sentinel-9q4w";
const seen: { path: string; params: URLSearchParams; at: number }[] = [];
let answer: () => Response | Promise<Response>;
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    seen.push({ path: u.pathname, params: u.searchParams, at: Date.now() });
    return answer();
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen.length = 0;
});

const logged: string[] = [];
const o = { baseUrl: `http://localhost:${server.port}`, intervalMs: 0, timeoutMs: 500 };
const ask = async (p: Plugin, capability: string, input: unknown, credential: unknown = { key: SENTINEL }) =>
  ((await invoke(p, "query", { capability, input, credential }, { workspaceId: "w", log: (m) => logged.push(m) })) as { output: unknown }).output;
const verify = async (p: Plugin, email = "ana@acme.com") => verifyAddressOutput.parse(await ask(p, VERIFY_ADDRESS, { email }));
const reoon = (status: string) => () => Response.json({ email: "ana@acme.com", status, is_safe_to_send: status === "safe" });

test.each([
  ["safe", "deliverable", 1],
  ["invalid", "invalid", 1],
  ["disabled", "invalid", 1],
  ["catch_all", "catch_all", 1],
  ["unknown", "unknown", 0],
  ["disposable", "other", 1],
  ["inbox_full", "other", 1],
  ["role_account", "other", 1],
  ["spamtrap", "other", 1],
  ["a_status_added_later", "other", 1],
])("Reoon %s maps to %s and uses %d credits", async (status, result, credits) => {
  answer = reoon(status);
  expect(await verify(createReoonPlugin(o))).toEqual({ result, vendorStatus: status, credits, costMicros: 0 });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.path).toBe("/api/v1/verify");
  expect(Object.fromEntries(seen[0]!.params)).toEqual({ email: "ana@acme.com", key: SENTINEL, mode: "power" });
});

test("the price per check is configured, and an uncharged result costs nothing", async () => {
  const p = createReoonPlugin({ ...o, priceMicrosPerCredit: 800 });
  answer = reoon("safe");
  expect((await verify(p)).costMicros).toBe(800);
  answer = reoon("unknown");
  expect((await verify(p)).costMicros).toBe(0);
  expect(REOON_DEFAULTS.priceMicrosPerCredit).toBe(0);
});

test.each([
  ["a server error", () => new Response("oops", { status: 500 })],
  ["a refused key", () => Response.json({ status: "error", reason: `Invalid API key ${SENTINEL}` }, { status: 401 })],
  ["an error with a 200", () => Response.json({ status: "error", reason: "no credits left" })],
  ["a body that isn't JSON", () => new Response(`<html>${SENTINEL}</html>`)],
  ["no status", () => Response.json({ email: "ana@acme.com" })],
  ["a timeout", () => new Promise<Response>((r) => setTimeout(() => r(Response.json({ status: "safe" })), 2000))],
])("%s is a refusal: it throws, so no result is stored", async (_name, a) => {
  answer = a;
  await expect(verify(createReoonPlugin(o))).rejects.toThrow(/refused the check/);
});

test("an unreachable server is a refusal", async () => {
  const p = createReoonPlugin({ ...o, baseUrl: "http://127.0.0.1:1" });
  await expect(verify(p)).rejects.toThrow(/refused the check/);
});

test("the key never reaches an answer, an error or the log", async () => {
  logged.length = 0;
  const p = createReoonPlugin(o);
  const outputs: unknown[] = [];
  for (const a of [reoon("safe"), () => Response.json({ status: "error", reason: SENTINEL }, { status: 401 })]) {
    answer = a;
    outputs.push(await ask(p, VERIFY_ADDRESS, { email: "ana@acme.com" }).catch((e: Error) => e.message));
  }
  const errors: string[] = [];
  answer = () => Response.json({ status: "error", reason: SENTINEL }, { status: 401 });
  await ask(p, VERIFY_BALANCE, null).catch((e: Error) => errors.push(e.message));
  await ask(createReoonPlugin({ ...o, baseUrl: "http://127.0.0.1:1" }), VERIFY_BALANCE, null).catch((e: Error) => errors.push(e.message));
  expect(errors).toHaveLength(2);
  expect(JSON.stringify({ outputs, errors, logged })).not.toContain(SENTINEL);
});

test("no key or a bad input is refused before any call", async () => {
  const p = createReoonPlugin(o);
  await expect(ask(p, VERIFY_ADDRESS, { email: "ana@acme.com" }, null)).rejects.toThrow(/not connected/);
  await expect(ask(p, VERIFY_ADDRESS, { email: "ana@acme.com" }, { key: "  " })).rejects.toThrow(/not connected/);
  await expect(ask(p, VERIFY_ADDRESS, { email: "not an address" })).rejects.toThrow(/one address/);
  expect(seen).toHaveLength(0);
});

test("balance adds daily and instant credits", async () => {
  answer = () => Response.json({ api_status: "active", remaining_daily_credits: 20, remaining_instant_credits: 75, status: "success" });
  expect(verifyBalanceOutput.parse(await ask(createReoonPlugin(o), VERIFY_BALANCE, null))).toEqual({ remainingCredits: 95 });
  expect(seen[0]!.path).toBe("/api/v1/check-account-balance/");
  expect(Object.fromEntries(seen[0]!.params)).toEqual({ key: SENTINEL });
  answer = () => Response.json({ status: "error", reason: "Invalid API key" }, { status: 401 });
  await expect(ask(createReoonPlugin(o), VERIFY_BALANCE, null)).rejects.toThrow(/refused the balance check/);
});

test("checks run one at a time, spaced by the interval", async () => {
  answer = reoon("safe");
  const p = createReoonPlugin({ ...o, intervalMs: 150 });
  await Promise.all([verify(p, "a@acme.com"), verify(p, "b@acme.com"), verify(p, "c@acme.com")]);
  expect(seen.map((s) => s.params.get("email"))).toEqual(["a@acme.com", "b@acme.com", "c@acme.com"]);
  expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(140);
  expect(seen[2]!.at - seen[1]!.at).toBeGreaterThanOrEqual(140);
});

test("Reoon is a first-party plugin with two reads on one api_key connection", () => {
  const p = firstPartyPlugins().find((x) => x.manifest.id === "com.trydirex.reoon")!;
  expect(p.manifest.connections).toEqual([{ key: "reoon", auth: "api_key" }]);
  expect(p.manifest.capabilities.map((c) => [c.kind, c.name])).toEqual([
    ["query", VERIFY_ADDRESS],
    ["query", VERIFY_BALANCE],
  ]);
  expect(p.manifest.egress.hosts).toEqual(["emailverifier.reoon.com"]);
});
