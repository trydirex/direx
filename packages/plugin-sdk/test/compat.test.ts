// SPDX-License-Identifier: MIT
// What a shipped bundle freezes (ADR 0028 rules 002 to 005): typed errors, tolerant params, the
// reported SDK version, and an author entry that holds no host internals.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import * as author from "../src/index";
import { definePlugin, PluginError, runWorker, SDK_VERSION } from "../src/index";
import { readErrorData } from "../src/host";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string; private?: boolean };
const W = "00000000-0000-4000-8000-00000000000a";
const bytes = (s: string) => new TextEncoder().encode(s);

const plugin = definePlugin({
  manifest: {
    id: "com.example.docs",
    apiVersion: 1,
    version: "1.0.0",
    minHostVersion: "0.1.0",
    trust: "third_party",
    connections: [{ key: "docs", auth: "api_key" }],
    egress: { hosts: ["api.docs.example"] },
    capabilities: [{ kind: "query", name: "docs.page_text", connection: "docs" }],
  },
  queries: {
    "docs.page_text": async (input, ctx) => {
      const what = (input as { what?: string }).what;
      if (what === "typed") throw new PluginError("rate_limited", "Docs answered 429", { status: 429, waitMs: 2000, code: "no_access" });
      if (what === "plain") throw new Error("something broke");
      return { credential: ctx.credential };
    },
  },
});

function worker() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  const out: Record<string, unknown>[] = [];
  const done = runWorker(plugin, { input, write: (l) => void out.push(JSON.parse(l)) });
  let id = 0;
  const reply = async (method: string, params: unknown) => {
    const n = ++id;
    ctrl.enqueue(bytes(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`));
    for (let i = 0; i < 200; i++) {
      const r = out.find((m) => m.id === n);
      if (r) return r as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no reply to ${n}`);
  };
  return { reply, end: async () => (ctrl.close(), await done) };
}

const key = { kind: "api_key", key: "k" };

test("initialize reports the SDK version beside the manifest, and it is package.json's", async () => {
  const w = worker();
  expect(await w.reply("initialize", { workspaceId: W })).toMatchObject({ result: { manifest: { id: "com.example.docs" }, sdkVersion: SDK_VERSION } });
  expect(SDK_VERSION).toBe(pkg.version);
  await w.end();
});

test("a PluginError's fields cross the wire as error data; any other error says failed, bad params invalid_params", async () => {
  const w = worker();
  await w.reply("initialize", { workspaceId: W });
  const typed = await w.reply("query", { capability: "docs.page_text", input: { what: "typed" }, credential: key });
  expect(typed.error).toMatchObject({ message: "Docs answered 429", data: { reason: "rate_limited", status: 429, waitMs: 2000, code: "no_access" } });
  const plain = await w.reply("query", { capability: "docs.page_text", input: { what: "plain" }, credential: key });
  expect(plain.error).toMatchObject({ message: "something broke", data: { reason: "failed" } });
  const bad = await w.reply("query", { capability: "docs.page_text", credential: key });
  expect(bad.error?.data).toEqual({ reason: "invalid_params" });
  await w.end();
});

test("a field this SDK does not know is ignored, and the handler gets the credential without its kind", async () => {
  const w = worker();
  await w.reply("initialize", { workspaceId: W });
  const r = await w.reply("query", { capability: "docs.page_text", input: {}, credential: { ...key, rotatedAt: "later" }, addedByNewerHost: true });
  expect(r.result).toEqual({ output: { credential: { key: "k" } } });
  await w.end();
});

test("a credential without a kind, or with one this SDK does not know, is invalid params", async () => {
  const w = worker();
  await w.reply("initialize", { workspaceId: W });
  for (const credential of [{ key: "k" }, { kind: "passkey", key: "k" }, { kind: "header", value: "v" }]) {
    expect((await w.reply("query", { capability: "docs.page_text", input: {}, credential })).error?.data, JSON.stringify(credential)).toEqual({ reason: "invalid_params" });
  }
  await w.end();
});

test("a host reads error data tolerantly: an unknown reason is failed with its wait kept, a bad field is dropped", () => {
  expect(readErrorData({ reason: "quota_exhausted", waitMs: 500, extra: 1 })).toEqual({ reason: "failed", waitMs: 500 });
  expect(readErrorData({ reason: "plan_required", plan: "Pro", status: "429", code: "No Access!" })).toEqual({ reason: "plan_required", plan: "Pro" });
  expect(readErrorData(undefined)).toEqual({ reason: "failed" });
  expect(readErrorData("not an object")).toEqual({ reason: "failed" });
});

test("the author entry holds only author API", () => {
  expect(Object.keys(author).sort()).toEqual([
    "MAX_EFFECT_TIMEOUT_MS",
    "MediaMismatch",
    "PLUGIN_REASONS",
    "PluginError",
    "QUERY_CODES",
    "SDK_VERSION",
    "VERIFICATION_RESULTS",
    "VERIFY_ADDRESS",
    "VERIFY_BALANCE",
    "accessToken",
    "definePlugin",
    "effectSchemas",
    "mediaLink",
    "mediaRef",
    "mediaRefs",
    "parseManifest",
    "querySchemas",
    "runWorker",
    "skipMail",
    "streamParts",
    "verifyAddressInput",
    "verifyAddressOutput",
    "verifyBalanceOutput",
  ]);
});

test("the package stays private until it is ready to publish", () => {
  expect(pkg.private).toBe(true);
});
