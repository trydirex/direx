// SPDX-License-Identifier: AGPL-3.0-only
// Reads an uploaded plugin's manifest the only trustworthy way: by running it (ADR 0026 rule 005).
// It runs in the sandbox with no network at all, a Workspace id that belongs to nobody and no
// credential, outside the process pool, for at most 10 seconds and one line of output.
import { parseManifest, type Manifest } from "@direx/plugin-sdk";
import { encode, MAX_LINE_BYTES, parseMessage, readLines } from "@direx/plugin-sdk/host";
import { spawnSandboxed } from "../../models";

export const PROBE_MS = 10_000;

export type ProbeResult = { ok: true; manifest: Manifest } | { ok: false; reason: string };

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string | null> {
  for await (const line of readLines(stream, MAX_LINE_BYTES)) return line;
  return null;
}

export async function probePlugin(file: string, opts: { hostVersion: string; timeoutMs?: number }): Promise<ProbeResult> {
  const started = await spawnSandboxed({ file, egressHosts: [], onStderr: () => {} });
  if (!started.ok) return started;
  const p = started.process;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    p.write(encode({ jsonrpc: "2.0", id: 1, method: "initialize", params: { apiVersion: 1, hostVersion: opts.hostVersion, workspaceId: crypto.randomUUID() } }));
    const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), opts.timeoutMs ?? PROBE_MS)));
    const line = await Promise.race([firstLine(p.stdout).catch(() => null), timeout]);
    if (line === "timeout") return { ok: false, reason: `it didn't answer within ${(opts.timeoutMs ?? PROBE_MS) / 1000} seconds` };
    if (line === null) return { ok: false, reason: "it exited without answering" };
    let m;
    try {
      m = parseMessage(line);
    } catch {
      return { ok: false, reason: "its first line isn't JSON-RPC" };
    }
    if (!("id" in m) || m.id !== 1 || !("result" in m)) return { ok: false, reason: "it didn't answer initialize" };
    const parsed = parseManifest((m.result as { manifest?: unknown } | null)?.manifest);
    return parsed.ok ? { ok: true, manifest: parsed.manifest } : { ok: false, reason: `its manifest is invalid: ${parsed.errors.join("; ")}` };
  } finally {
    clearTimeout(timer);
    p.kill("SIGKILL");
    await p.exited;
  }
}
