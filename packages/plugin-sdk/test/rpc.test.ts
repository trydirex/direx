// SPDX-License-Identifier: MIT
import { expect, test } from "vitest";
import { definePlugin, runWorker } from "../src/index";
import { LineTooLong, parseMessage, readLines, RPC_ERRORS, RpcError } from "../src/host";

const bytes = (s: string) => new TextEncoder().encode(s);
const streamOf = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  });
const collect = async (s: ReadableStream<Uint8Array>, max?: number) => {
  const out: string[] = [];
  for await (const l of readLines(s, max)) out.push(l);
  return out;
};

test("lines split across chunks are joined; blank lines are skipped", async () => {
  expect(await collect(streamOf(bytes('{"a":'), bytes('1}\n\n{"b":2}\n')))).toEqual(['{"a":1}', '{"b":2}']);
});

test("a line over the limit fails instead of waiting for more bytes", async () => {
  await expect(collect(streamOf(bytes("x".repeat(20))), 10)).rejects.toThrow(LineTooLong);
  await expect(collect(streamOf(bytes(`${"x".repeat(20)}\n`)), 10)).rejects.toThrow(LineTooLong);
});

test("invalid JSON and non-JSON-RPC lines are rejected with their codes", () => {
  const code = (l: string) => {
    try {
      parseMessage(l);
      return 0;
    } catch (e) {
      return (e as RpcError).code;
    }
  };
  expect(code("{nope")).toBe(RPC_ERRORS.parse);
  expect(code('{"id":1,"method":"x"}')).toBe(RPC_ERRORS.invalidRequest);
  expect(code('{"jsonrpc":"2.0","id":1}')).toBe(RPC_ERRORS.invalidRequest);
  expect(parseMessage('{"jsonrpc":"2.0","id":1,"result":null}')).toMatchObject({ id: 1 });
});

const plugin = definePlugin({
  manifest: {
    id: "com.example.echo",
    apiVersion: 1,
    version: "1.0.0",
    minHostVersion: "0.1.0",
    trust: "third_party",
    connections: [{ key: "none", auth: "none" }],
    egress: { hosts: [] },
    capabilities: [{ kind: "effect", name: "echo.send", connection: "none", dedupe: "blind", risk: "low", reachesPerson: false }],
  },
  effects: {
    "echo.send": {
      prepare: async (input) => ({ spec: input, preview: "echo" }),
      execute: async (spec, ctx) => {
        ctx.log("sending");
        await new Promise((r) => setTimeout(r, 20));
        return { kind: "sent", providerRef: `${ctx.workspaceId}:${JSON.stringify(spec)}` };
      },
    },
  },
});

/** A worker on in-memory pipes: send() writes a request line, out holds parsed replies. */
function worker() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({ start: (c) => void (ctrl = c) });
  const out: Record<string, unknown>[] = [];
  const done = runWorker(plugin, { input, write: (l) => void out.push(JSON.parse(l)) });
  let id = 0;
  const send = (method: string, params: unknown = {}) => {
    ctrl.enqueue(bytes(`${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })}\n`));
    return id;
  };
  const reply = async (n: number) => {
    for (let i = 0; i < 200; i++) {
      const r = out.find((m) => m.id === n);
      if (r) return r;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`no reply to ${n}`);
  };
  return { send, reply, out, done, end: () => ctrl.close() };
}

const W = "00000000-0000-4000-8000-00000000000a";

test("a call before initialize is refused; after it, the call runs bound to that workspace", async () => {
  const w = worker();
  const early = w.send("execute", { capability: "echo.send", spec: 1, idempotencyKey: "k", credential: null });
  expect(await w.reply(early)).toMatchObject({ error: { message: "not initialized" } });
  expect(await w.reply(w.send("initialize", { apiVersion: 1, hostVersion: "0.1.0", workspaceId: W }))).toMatchObject({
    result: { manifest: { id: "com.example.echo" } },
  });
  const r = await w.reply(w.send("execute", { capability: "echo.send", spec: { a: 1 }, idempotencyKey: "k", credential: null }));
  expect(r).toMatchObject({ result: { kind: "sent", providerRef: `${W}:{"a":1}` } });
  expect(w.out).toContainEqual({ jsonrpc: "2.0", method: "log", params: { level: "info", message: "sending" } });
  w.end();
  await w.done;
});

test("a second workspace on the same process is refused", async () => {
  const w = worker();
  await w.reply(w.send("initialize", { workspaceId: W }));
  const other = await w.reply(w.send("initialize", { workspaceId: "00000000-0000-4000-8000-00000000000b" }));
  expect(other).toMatchObject({ error: { message: "this process is bound to another workspace" } });
  w.end();
  await w.done;
});

test("unknown methods and bad params get their JSON-RPC codes", async () => {
  const w = worker();
  await w.reply(w.send("initialize", { workspaceId: W }));
  expect(await w.reply(w.send("credentials.resolve", { key: "x" }))).toMatchObject({
    error: { code: RPC_ERRORS.methodNotFound },
  });
  expect(await w.reply(w.send("execute", { capability: "echo.send" }))).toMatchObject({
    error: { code: RPC_ERRORS.invalidParams },
  });
  w.end();
  await w.done;
});

test("health answers while an execute is in flight, and shutdown waits for it", async () => {
  const w = worker();
  await w.reply(w.send("initialize", { workspaceId: W }));
  const exec = w.send("execute", { capability: "echo.send", spec: 1, idempotencyKey: "k", credential: null });
  const health = w.send("health");
  expect(await w.reply(health)).toMatchObject({ result: { status: "ok" } });
  expect(w.out.find((m) => m.id === exec)).toBeUndefined();
  const stop = w.send("shutdown");
  await w.done;
  const order = w.out.filter((m) => "id" in m).map((m) => m.id);
  expect(order.indexOf(exec)).toBeLessThan(order.indexOf(stop));
});
