// SPDX-License-Identifier: MIT

// The worker side of an out-of-process plugin: reads JSON-RPC requests from stdin,
// answers on stdout. A plugin's entry file is `await runWorker(definePlugin({...}))`.
import { Readable } from "node:stream";
import { invoke, type Plugin } from "./define";
import { errorData, PluginError } from "./errors";
import { encode, isRequest, parseMessage, RPC_ERRORS, RpcError, readLines, type RpcMessage, type RpcRequest } from "./rpc";
import { SDK_VERSION } from "./version";

export type WorkerIo = { input: ReadableStream<Uint8Array>; write: (line: string) => void };

/**
 * Serves one host until it sends shutdown or closes stdin. Calls run concurrently, so
 * health answers while an execute is in flight. Without io it uses stdin and stdout and
 * exits the process when done.
 */
export async function runWorker(plugin: Plugin, io?: WorkerIo): Promise<void> {
  const { input, write } = io ?? {
    input: Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
    write: (line: string) => void process.stdout.write(line),
  };
  const send = (m: RpcMessage) => write(encode(m));
  const log = (message: string) => send({ jsonrpc: "2.0", method: "log", params: { level: "info", message } });
  const inflight = new Set<Promise<void>>();
  let workspaceId: string | null = null;

  const answer = async (m: RpcRequest, run: () => Promise<unknown>) => {
    try {
      send({ jsonrpc: "2.0", id: m.id, result: (await run()) ?? null });
    } catch (e) {
      const code = e instanceof RpcError ? e.code : RPC_ERRORS.internal;
      // The host reads data, never the message (ADR 0028 rule 002).
      const data = e instanceof PluginError ? errorData(e) : { reason: code === RPC_ERRORS.invalidParams ? "invalid_params" : "failed" };
      send({ jsonrpc: "2.0", id: m.id, error: { code, message: e instanceof Error ? e.message : String(e), data } });
    }
  };

  for await (const line of readLines(input)) {
    let m: RpcMessage;
    try {
      m = parseMessage(line);
    } catch {
      continue; // the host only sends well-formed requests; anything else is ignored
    }
    if (!isRequest(m)) continue;

    if (m.method === "shutdown") {
      await Promise.allSettled(inflight);
      await answer(m, async () => ({}));
      break;
    }
    if (m.method === "initialize") {
      const ws = (m.params as { workspaceId?: unknown } | undefined)?.workspaceId;
      await answer(m, async () => {
        if (typeof ws !== "string") throw new RpcError(RPC_ERRORS.invalidParams, "initialize needs a workspaceId");
        if (workspaceId !== null && workspaceId !== ws) {
          throw new RpcError(RPC_ERRORS.invalidRequest, "this process is bound to another workspace");
        }
        workspaceId = ws;
        return { manifest: plugin.manifest, sdkVersion: SDK_VERSION };
      });
      continue;
    }
    if (m.method === "health") {
      await answer(m, async () => ({ status: "ok" }));
      continue;
    }
    const ws = workspaceId;
    const req = m;
    const p: Promise<void> = answer(req, async () => {
      if (ws === null) throw new RpcError(RPC_ERRORS.invalidRequest, "not initialized");
      return invoke(plugin, req.method, req.params, { workspaceId: ws, log });
    }).finally(() => inflight.delete(p));
    inflight.add(p);
  }

  await Promise.allSettled(inflight);
  if (!io) process.exit(0);
}
