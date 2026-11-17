// SPDX-License-Identifier: MIT
import { afterEach, expect, test, vi } from "vitest";
import { plugin } from "../examples/hello/plugin";
import { invoke } from "../src/host";

const ctx = { workspaceId: "w1", log: () => undefined };
const call = (credential: unknown) => ({ capability: "hello.ping", spec: { message: "hi" }, idempotencyKey: "k-1", credential });
afterEach(() => vi.restoreAllMocks());

test("the hello example is a third-party plugin that reaches only its one host", () => {
  expect(plugin.manifest.trust).toBe("third_party");
  expect(plugin.manifest.egress.hosts).toEqual(["api.example.com"]);
  expect(plugin.manifest.connections).toEqual([{ key: "hello", auth: "api_key" }]);
});

test("prepare turns the input into the spec a person approves, with a default message", async () => {
  expect(await invoke(plugin, "prepare", { capability: "hello.ping", input: { message: "hi" } }, ctx)).toEqual({ spec: { message: "hi" }, preview: 'Send "hi" to Hello' });
  expect(await invoke(plugin, "prepare", { capability: "hello.ping", input: null }, ctx)).toMatchObject({ spec: { message: "hello" } });
});

test("execute sends the approved spec and the key to that host only", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "p-1" }));
  expect(await invoke(plugin, "execute", call({ kind: "api_key", key: " k1 " }), ctx)).toEqual({ kind: "sent", providerRef: "p-1" });
  expect(fetch).toHaveBeenCalledWith("https://api.example.com/v1/ping", {
    method: "POST",
    headers: { authorization: "Bearer k1", "content-type": "application/json" },
    body: JSON.stringify({ message: "hi" }),
  });
});

test("execute refuses without a key, and says when the host refuses the key or fails", async () => {
  await expect(invoke(plugin, "execute", call(null), ctx)).rejects.toThrow("add its API key");
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("no", { status: 401 })).mockResolvedValueOnce(new Response("busy", { status: 503 }));
  expect(await invoke(plugin, "execute", call({ kind: "api_key", key: "k" }), ctx)).toMatchObject({ kind: "refused", permanent: true, credentialRejected: true });
  expect(await invoke(plugin, "execute", call({ kind: "api_key", key: "k" }), ctx)).toMatchObject({ kind: "refused", retryable: true, detail: "Hello answered 503" });
});
