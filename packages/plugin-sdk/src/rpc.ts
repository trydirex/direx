// SPDX-License-Identifier: MIT

// JSON-RPC 2.0 over newline-delimited JSON, shared by the plugin worker and the host.
// One message per line; a line longer than MAX_LINE_BYTES is an error, not a wait.

export const RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export const MAX_LINE_BYTES = 1024 * 1024;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class LineTooLong extends Error {
  constructor(max: number) {
    super(`a message line is longer than ${max} bytes`);
  }
}

type Id = number | string;
export type RpcRequest = { jsonrpc: "2.0"; id: Id; method: string; params?: unknown };
export type RpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
export type RpcResponse =
  | { jsonrpc: "2.0"; id: Id; result: unknown }
  | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string; data?: unknown } };
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export const encode = (m: RpcMessage): string => `${JSON.stringify(m)}\n`;

/** Parses one line. Throws RpcError when it is not JSON or not a JSON-RPC 2.0 message. */
export function parseMessage(line: string): RpcMessage {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    throw new RpcError(RPC_ERRORS.parse, "invalid JSON");
  }
  if (typeof m !== "object" || m === null || (m as { jsonrpc?: unknown }).jsonrpc !== "2.0") {
    throw new RpcError(RPC_ERRORS.invalidRequest, "not a JSON-RPC 2.0 message");
  }
  const o = m as Record<string, unknown>;
  const idOk = typeof o.id === "number" || typeof o.id === "string";
  if (typeof o.method === "string") {
    if ("id" in o && !idOk) throw new RpcError(RPC_ERRORS.invalidRequest, "bad id");
    return o as RpcRequest | RpcNotification;
  }
  if (idOk && ("result" in o || isError(o.error))) return o as RpcResponse;
  throw new RpcError(RPC_ERRORS.invalidRequest, "neither a request nor a response");
}

function isError(e: unknown): boolean {
  return typeof e === "object" && e !== null && typeof (e as { code?: unknown }).code === "number";
}

export const isRequest = (m: RpcMessage): m is RpcRequest => "method" in m && "id" in m;
export const isNotification = (m: RpcMessage): m is RpcNotification => "method" in m && !("id" in m);

/** Yields each complete line of a byte stream. Throws LineTooLong past maxBytes. */
export async function* readLines(
  stream: ReadableStream<Uint8Array>,
  maxBytes = MAX_LINE_BYTES,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = new Uint8Array(0);
  for await (const chunk of stream) {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf);
    next.set(chunk, buf.length);
    buf = next;
    let nl: number;
    while ((nl = buf.indexOf(10)) >= 0) {
      if (nl > maxBytes) throw new LineTooLong(maxBytes);
      const line = decoder.decode(buf.subarray(0, nl));
      buf = buf.subarray(nl + 1);
      if (line.trim()) yield line;
    }
    if (buf.length > maxBytes) throw new LineTooLong(maxBytes);
  }
}
