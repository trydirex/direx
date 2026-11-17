// SPDX-License-Identifier: AGPL-3.0-only
// The out-of-process plugin host: one process per plugin per workspace, started on the
// first call and stopped when idle. Two kinds of failure matter to the ledger:
//   NotStarted: nothing reached the plugin, so the provider cannot have been called.
//   CallFailed: the request was written; whether the provider acted is unknown.
import { QUERY_CODES, type Credential, type Manifest, type PluginErrorFields, type PluginReason } from "@direx/plugin-sdk";
import { encode, isNotification, isRequest, MAX_LINE_BYTES, parseMessage, readErrorData, readLines, RPC_ERRORS, type CredentialKind, type RpcMessage } from "@direx/plugin-sdk/host";
import { spawnPlugin, type PluginProcess } from "../adapters/process";
import { assertBound, atLeast, poolKey, recordCrash, stableJson } from "../domain/rules";

export class NotStarted extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
/**
 * A plugin call that failed. Read reason and the other fields; the message is for logs only
 * (ADR 0028 rule 002).
 */
export class CallFailed extends Error {
  readonly reason: PluginReason;
  readonly status?: number;
  readonly waitMs?: number;
  readonly plan?: string;
  readonly code?: string;
  constructor(message: string, data: PluginErrorFields & { reason: PluginReason } = { reason: "failed" }) {
    super(message);
    Object.assign(this, data);
    this.reason = data.reason;
  }
}

/** A credential's kind, from the fields its kind has. */
export const credentialKind = (c: Credential): CredentialKind =>
  "accessToken" in c ? "oauth2" : "key" in c ? "api_key" : "headerName" in c ? "header" : "password" in c ? "basic" : "secret";

/** Params as they go to a plugin: the credential names its kind (ADR 0028 rule 003). */
export function wireParams(params: unknown): unknown {
  if (!params || typeof params !== "object") return params;
  const c = (params as { credential?: unknown }).credential;
  if (!c || typeof c !== "object" || "kind" in c) return params;
  return { ...params, credential: { kind: credentialKind(c as Credential), ...c } };
}

/**
 * Request fields that restrict what a plugin may read or do, with the SDK version that first
 * honours each. Ignoring one would be fail-open, so a plugin that reports an older SDK, or none,
 * is not sent it (ADR 0028 rule 003).
 */
const RESTRICTING: readonly { method: string; capability?: string; inInput: boolean; field: string; since: string }[] = [
  { method: "poll", inInput: false, field: "skip", since: "0.2.0" },
  { method: "query", capability: "mail.from", inInput: true, field: "skip", since: "0.2.0" },
];

/** What a plugin at sdkVersion would not honour in this call, or null when it may be sent. */
export function unhonoured(method: string, params: unknown, sdkVersion: string | undefined): string | null {
  const p = (params ?? {}) as { capability?: unknown; input?: unknown };
  for (const r of RESTRICTING) {
    if (r.method !== method || (r.capability && p.capability !== r.capability)) continue;
    const holder = (r.inInput ? p.input : p) as Record<string, unknown> | null | undefined;
    const v = holder?.[r.field];
    if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    if (!sdkVersion || !atLeast(sdkVersion, r.since)) return `${r.field}, which needs SDK ${r.since}; the plugin reports ${sdkVersion ?? "no version"}`;
  }
  return null;
}

export type Failure = PluginErrorFields & { reason: PluginReason };

/**
 * Why a plugin call failed, from its typed fields: anything that isn't a plugin failure is
 * "failed", and a code counts only for a query whose catalogue entry lists it (ADR 0028 rule 002).
 */
export function failureOf(e: unknown, capability?: string): Failure {
  if (!(e instanceof CallFailed)) return { reason: "failed" };
  const { reason, status, waitMs, plan, code } = e;
  const listed = code !== undefined && capability !== undefined && (QUERY_CODES[capability.split("/").pop()!] ?? []).includes(code);
  return { reason, ...(status !== undefined && { status }), ...(waitMs !== undefined && { waitMs }), ...(plan !== undefined && { plan }), ...(listed && { code }) };
}

export type HostOptions = {
  initTimeoutMs: number;
  /** Under the ledger's 30 s execute timeout, so the host kills a hung plugin first. */
  callTimeoutMs: number;
  idleMs: number;
  /** After shutdown: how long in-flight calls may finish before SIGTERM. */
  drainMs: number;
  /** After SIGTERM: how long before SIGKILL. */
  killMs: number;
  crashLimit: number;
  crashWindowMs: number;
  unhealthyMs: number;
  maxLineBytes: number;
};

export const HOST_DEFAULTS: HostOptions = {
  initTimeoutMs: 10_000,
  callTimeoutMs: 25_000,
  idleMs: 10 * 60_000,
  drainMs: 10_000,
  killMs: 5_000,
  crashLimit: 3,
  crashWindowMs: 5 * 60_000,
  unhealthyMs: 5 * 60_000,
  maxLineBytes: MAX_LINE_BYTES,
};

export type ProcessPlugin = { manifest: Manifest; entry: string; dir: string };

/** Starts one plugin process. Throws with the reason when it can't, such as a sandbox that won't hold. */
export type Spawner = (plugin: ProcessPlugin, onStderr: (line: string) => void) => Promise<PluginProcess>;

const plainSpawner: Spawner = async (plugin, onStderr) => spawnPlugin(plugin.entry, plugin.dir, onStderr);

export type HostDeps = {
  confinement: "external" | "none";
  hostVersion: string;
  log: (line: string) => void;
  options?: Partial<HostOptions>;
  now?: () => number;
  /** How processes start; a plain child process unless the deployment hands in the sandbox. */
  spawn?: Spawner;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type Proc = {
  key: string;
  pluginId: string;
  workspaceId: string;
  /** Unset while the process is still being started. */
  child?: PluginProcess;
  pending: Map<number, Pending>;
  nextId: number;
  active: number;
  idle?: ReturnType<typeof setTimeout>;
  ready: Promise<void>;
  state: "starting" | "ready" | "stopping" | "dead";
  /** The SDK version the plugin reported at initialize, if any. */
  sdkVersion?: string;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createHost(deps: HostDeps) {
  const o = { ...HOST_DEFAULTS, ...deps.options };
  const now = deps.now ?? Date.now;
  const pool = new Map<string, Proc>();
  const live = new Set<Proc>();
  const crashes = new Map<string, number[]>();
  const unhealthyUntil = new Map<string, number>();

  // The process is gone: every pending call fails. Counted as a crash unless we stopped it.
  function ended(proc: Proc, why: string) {
    if (proc.state === "dead") return;
    const stopping = proc.state === "stopping";
    proc.state = "dead";
    if (pool.get(proc.key) === proc) pool.delete(proc.key);
    clearTimeout(proc.idle);
    for (const p of proc.pending.values()) p.reject(new CallFailed(why));
    proc.pending.clear();
    if (stopping) return;
    deps.log(`plugin ${proc.pluginId}: ${why}`);
    const r = recordCrash(crashes.get(proc.key) ?? [], now(), { limit: o.crashLimit, windowMs: o.crashWindowMs });
    crashes.set(proc.key, r.crashes);
    if (r.unhealthy) unhealthyUntil.set(proc.key, now() + o.unhealthyMs);
  }

  function fault(proc: Proc, why: string) {
    ended(proc, why);
    try {
      proc.child?.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  function onLine(proc: Proc, line: string) {
    let m: RpcMessage;
    try {
      m = parseMessage(line);
    } catch {
      return fault(proc, "sent a line that is not JSON-RPC");
    }
    if (isRequest(m)) {
      // Plugins get nothing from the host but what a call hands them.
      deps.log(`plugin ${proc.pluginId} asked the host for ${m.method}, which the host does not offer`);
      try {
        proc.child?.write(encode({ jsonrpc: "2.0", id: m.id, error: { code: RPC_ERRORS.methodNotFound, message: `method not found: ${m.method}` } }));
      } catch {
        // the exit handler deals with a dead pipe
      }
      return;
    }
    if (isNotification(m)) {
      if (m.method === "log") deps.log(`plugin ${proc.pluginId}: ${String((m.params as { message?: unknown } | undefined)?.message ?? "")}`);
      return;
    }
    const p = typeof m.id === "number" ? proc.pending.get(m.id) : undefined;
    if (!p) return fault(proc, `answered request ${String(m.id)}, which the host never sent`);
    proc.pending.delete(m.id as number);
    if ("error" in m) p.reject(new CallFailed(`plugin error: ${m.error.message}`, readErrorData(m.error.data)));
    else p.resolve(m.result);
  }

  async function request(proc: Proc, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (proc.state === "dead" || proc.state === "stopping") throw new NotStarted("the plugin process is stopping", true);
    const child = proc.child;
    if (!child) throw new NotStarted("the plugin process hasn't started", true);
    const id = ++proc.nextId;
    const result = new Promise<unknown>((resolve, reject) => proc.pending.set(id, { resolve, reject }));
    try {
      child.write(encode({ jsonrpc: "2.0", id, method, params }));
    } catch {
      proc.pending.delete(id);
      throw new NotStarted("could not write to the plugin process", true);
    }
    proc.active++;
    clearTimeout(proc.idle);
    const timer = setTimeout(() => fault(proc, `${method} got no answer within ${timeoutMs} ms`), timeoutMs);
    try {
      return await result;
    } finally {
      clearTimeout(timer);
      proc.active--;
      if (proc.active === 0 && proc.state === "ready") {
        proc.idle = setTimeout(() => void stop(proc), o.idleMs);
        proc.idle.unref?.();
      }
    }
  }

  function start(plugin: ProcessPlugin, workspaceId: string): Proc {
    const id = plugin.manifest.id;
    const proc: Proc = {
      key: poolKey(id, workspaceId),
      pluginId: id,
      workspaceId,
      pending: new Map(),
      nextId: 0,
      active: 0,
      state: "starting",
      ready: Promise.resolve(),
    };
    pool.set(proc.key, proc);
    live.add(proc);
    proc.ready = (async () => {
      let child: PluginProcess;
      try {
        child = await (deps.spawn ?? plainSpawner)(plugin, (line) => deps.log(`plugin ${id} stderr: ${line}`));
      } catch (e) {
        proc.state = "dead";
        if (pool.get(proc.key) === proc) pool.delete(proc.key);
        live.delete(proc);
        throw new NotStarted(`plugin ${id} did not start: ${message(e)}`, false);
      }
      if (proc.state !== "starting") {
        // Stopped while it was being started: it never gets to run.
        child.kill("SIGKILL");
        live.delete(proc);
        throw new NotStarted("the plugin process is stopping", true);
      }
      proc.child = child;
      void (async () => {
        for await (const line of readLines(child.stdout, o.maxLineBytes)) onLine(proc, line);
      })().catch((e) => fault(proc, message(e)));
      void child.exited.then((code) => {
        ended(proc, `exited with code ${code}`);
        live.delete(proc);
      });
      const r = (await request(proc, "initialize", { apiVersion: 1, hostVersion: deps.hostVersion, workspaceId }, o.initTimeoutMs)) as
        | { manifest?: unknown; sdkVersion?: unknown }
        | null;
      if (stableJson(r?.manifest) !== stableJson(plugin.manifest)) {
        void stop(proc);
        throw new NotStarted(`plugin ${id} reports a different manifest from the one loaded, so it was stopped`, false);
      }
      if (typeof r?.sdkVersion === "string") proc.sdkVersion = r.sdkVersion;
      deps.log(`plugin ${id}: started, SDK ${proc.sdkVersion ?? "version not reported"}`);
      proc.state = "ready";
    })();
    proc.ready.catch(() => {});
    return proc;
  }

  /** Shutdown, then up to drainMs for in-flight calls, then SIGTERM, then SIGKILL after killMs. */
  async function stop(proc: Proc): Promise<void> {
    if (proc.state === "dead") return;
    if (proc.state !== "stopping") {
      proc.state = "stopping";
      if (pool.get(proc.key) === proc) pool.delete(proc.key);
      clearTimeout(proc.idle);
      const id = ++proc.nextId;
      proc.pending.set(id, { resolve: () => {}, reject: () => {} });
      try {
        proc.child?.write(encode({ jsonrpc: "2.0", id, method: "shutdown", params: {} }));
      } catch {
        // already gone
      }
    }
    const child = proc.child;
    // Not started yet: the start sees "stopping" and kills it before it runs.
    if (!child) return;
    const exited = child.exited.then(() => true);
    const within = (ms: number) => Promise.race([exited, new Promise<false>((r) => setTimeout(() => r(false), ms))]);
    if (await within(o.drainMs)) return;
    deps.log(`plugin ${proc.pluginId}: still running after shutdown; sending SIGTERM`);
    child.kill("SIGTERM");
    if (await within(o.killMs)) return;
    deps.log(`plugin ${proc.pluginId}: still running after SIGTERM; sending SIGKILL`);
    child.kill("SIGKILL");
    await child.exited;
  }

  return {
    /** One method call on the plugin's process for this workspace, starting it if needed. */
    async call(plugin: ProcessPlugin, workspaceId: string, method: string, params: unknown): Promise<unknown> {
      const id = plugin.manifest.id;
      if (deps.confinement !== "external") {
        throw new NotStarted(`plugin ${id} runs out of process, and third-party plugins start only where egress limits are in place`, false);
      }
      const key = poolKey(id, workspaceId);
      if ((unhealthyUntil.get(key) ?? 0) > now()) {
        throw new NotStarted(`plugin ${id} crashed ${o.crashLimit} times in a short time; calls wait until it cools down`, true);
      }
      let proc = pool.get(key);
      if (proc) assertBound(proc.workspaceId, workspaceId);
      else proc = start(plugin, workspaceId);
      try {
        await proc.ready;
      } catch (e) {
        throw e instanceof NotStarted && !e.retryable ? e : new NotStarted(`plugin ${id} did not start: ${message(e)}`, true);
      }
      const why = unhonoured(method, params, proc.sdkVersion);
      if (why) throw new CallFailed(`plugin ${id} was not sent ${why}`, { reason: "invalid_params" });
      return request(proc, method, wireParams(params), o.callTimeoutMs);
    },
    /** Stops every process of one plugin, as an upgrade or removal does; the next call starts afresh. */
    async stopPlugin(pluginId: string): Promise<void> {
      await Promise.all([...live].filter((p) => p.pluginId === pluginId).map((p) => stop(p)));
    },
    /** Running processes, for tests and diagnostics. */
    processes: () =>
      [...live].flatMap((p) => (p.state !== "dead" && p.child ? [{ pluginId: p.pluginId, workspaceId: p.workspaceId, pid: p.child.pid }] : [])),
    /** Stops every process; force skips the shutdown ladder. */
    async close(opts: { force?: boolean } = {}): Promise<void> {
      await Promise.all(
        [...live].map(async (p) => {
          if (!opts.force) return stop(p);
          p.state = "stopping";
          p.child?.kill("SIGKILL");
          await p.child?.exited;
        }),
      );
    },
  };
}

export type Host = ReturnType<typeof createHost>;
