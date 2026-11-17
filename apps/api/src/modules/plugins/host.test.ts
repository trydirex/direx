// SPDX-License-Identifier: AGPL-3.0-only
// The out-of-process host against real fixture processes.
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { behaveManifest } from "./fixtures/manifest";
import { assertBound, CallFailed, loadPlugins, type HostOptions, type Plugins } from "./index";

const dir = join(import.meta.dirname, "fixtures");
const W1 = crypto.randomUUID();
const PROBE = { actionId: "a1", subject: "s" };
const W2 = crypto.randomUUID();
const SEND = "com.example.behave/behave.send";
const opened: Plugins[] = [];

afterEach(async () => {
  const pids = opened.flatMap((p) => p.processes().map((x) => x.pid));
  await Promise.all(opened.splice(0).map((p) => p.close({ force: true })));
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
});

async function until<T>(f: () => T | undefined | false, what: string, ms = 5_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) {
    const v = f();
    if (v) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

function setup(opts: { entry?: string; confinement?: "external" | "none"; host?: Partial<HostOptions> } = {}) {
  const logs: string[] = [];
  const plugins = loadPlugins({
    sources: [{ mode: "process", manifest: behaveManifest, entry: join(dir, opts.entry ?? "behave.ts"), dir }],
    credentials: async (ws) => ({ accessToken: `tok-${ws}`, expiresAt: "2026-11-02T10:00:00Z" }),
    confinement: opts.confinement ?? "external",
    log: (l) => logs.push(l),
    hostOptions: { drainMs: 200, killMs: 200, ...opts.host },
  });
  opened.push(plugins);
  const send = (ws: string, spec: unknown) => plugins.effects[SEND]!.execute(spec, { workspaceId: ws, idempotencyKey: "k-1" });
  const logged = (re: RegExp) => until(() => logs.find((l) => re.test(l)), `a log line matching ${re}`);
  return { plugins, logs, send, logged };
}

test("a plugin process sees only PATH and its own directory", async () => {
  process.env.DIREX_TEST_HOST_SECRET = "do-not-leak";
  const { send } = setup();
  expect(await send(W1, { do: "env" })).toEqual({ kind: "sent", providerRef: "DIREX_PLUGIN_DIR,PATH" });
});

test("two workspaces get two processes, each started for its own workspace", async () => {
  const { send, plugins } = setup();
  expect(await send(W1, { do: "sent" })).toMatchObject({ providerRef: `ws=${W1} token=tok-${W1}` });
  expect(await send(W2, { do: "sent" })).toMatchObject({ providerRef: `ws=${W2} token=tok-${W2}` });
  const procs = plugins.processes();
  expect(procs.map((p) => p.workspaceId).sort()).toEqual([W1, W2].sort());
  expect(new Set(procs.map((p) => p.pid)).size).toBe(2);
});

test("a process is never reused for another workspace", () => {
  expect(() => assertBound(W1, W2)).toThrow(/started for workspace .* was asked to serve workspace/);
  expect(() => assertBound(W1, W1)).not.toThrow();
});

test("without external confinement a third-party plugin is not started, and the refusal says why", async () => {
  const { send, plugins } = setup({ confinement: "none" });
  const r = await send(W1, { do: "sent" });
  expect(r).toMatchObject({ kind: "refused", permanent: false, retryable: false, detail: expect.stringMatching(/egress limits/) });
  expect(plugins.processes()).toEqual([]);
});

test("the credential reaches the plugin only in the call that needs it, and the host never logs it", async () => {
  const { send, logs, logged } = setup({ entry: "raw-spy.ts" });
  await send(W1, { do: "sent" });
  const init = await logged(/RECV .*"initialize"/);
  const exec = await logged(/RECV .*"execute"/);
  expect(init).not.toMatch(/tok-/);
  expect(exec).toContain(`tok-${W1}`);
  expect(logs.filter((l) => !l.includes("stderr: RECV")).filter((l) => l.includes("tok-"))).toEqual([]);
});

test("a query gets the credential the same way", async () => {
  const { plugins } = setup();
  expect(await plugins.query(W1, "com.example.behave/mailbox.probe_read", PROBE)).toEqual({ found: true, folder: "inbox", headers: W1, text: `tok-${W1}`, html: null });
});

test("an answer that doesn't fit the query's catalogue entry is a provider_error out of process too, without the answer", async () => {
  const { plugins } = setup();
  const e = await plugins.query(W1, "com.example.behave/mailbox.probe_read", { actionId: "malformed", subject: "s" }).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(CallFailed);
  expect(e).toMatchObject({ reason: "provider_error", message: "the answer to mailbox.probe_read does not fit its catalogue entry" });
  expect((e as Error).message).not.toContain("tok-");
});

test("a request from the plugin gets method not found and is logged; the plugin keeps running", async () => {
  const { send, plugins, logged } = setup();
  expect(await send(W1, { do: "rogue" })).toMatchObject({ kind: "sent" });
  await logged(/asked the host for credentials\.resolve, which the host does not offer/);
  const pid = plugins.processes()[0]!.pid;
  expect(await send(W1, { do: "sent" })).toMatchObject({ kind: "sent" });
  expect(plugins.processes()[0]!.pid).toBe(pid);
});

test("a plugin reporting a different manifest is stopped and its calls are refused", async () => {
  const { send } = setup({ entry: "raw-mismatch.ts" });
  expect(await send(W1, { do: "sent" })).toMatchObject({
    kind: "refused",
    retryable: false,
    detail: expect.stringMatching(/different manifest/),
  });
});

test("a plugin that cannot start is refused as retryable, since nothing was sent", async () => {
  const { send } = setup({ entry: "does-not-exist.ts" });
  expect(await send(W1, { do: "sent" })).toMatchObject({ kind: "refused", retryable: true, detail: expect.stringMatching(/did not start/) });
});

test("a hanging call is cut off, its process killed, and the next call gets a fresh process", async () => {
  const { send, plugins } = setup({ host: { callTimeoutMs: 300 } });
  await send(W1, { do: "sent" });
  const first = plugins.processes()[0]!.pid;
  await expect(send(W1, { do: "hang" })).rejects.toThrow(CallFailed);
  expect(await send(W1, { do: "sent" })).toMatchObject({ kind: "sent" });
  expect(plugins.processes()[0]!.pid).not.toBe(first);
});

test.each(["garbage", "oversize", "unknown-id", "exit", "bad-shape", "throw"])(
  "a plugin that answers with %s fails the call as an unknown outcome",
  async (behaviour) => {
    const { send, plugins } = setup();
    await expect(send(W1, { do: behaviour })).rejects.toThrow();
    if (!["bad-shape", "throw"].includes(behaviour)) await until(() => plugins.processes().length === 0, "the process to be gone");
  },
);

test("three crashes in the window mark the plugin unhealthy; calls are refused without starting it", async () => {
  const { send, plugins, logs } = setup();
  for (let i = 0; i < 3; i++) await expect(send(W1, { do: "exit" })).rejects.toThrow(CallFailed);
  const starts = logs.length;
  expect(await send(W1, { do: "sent" })).toMatchObject({ kind: "refused", retryable: true, detail: expect.stringMatching(/cools down/) });
  expect(plugins.processes()).toEqual([]);
  expect(logs.length).toBe(starts);
  expect(await send(W2, { do: "sent" })).toMatchObject({ kind: "sent" });
});

test("an idle process stops on its own", async () => {
  const { send, plugins } = setup({ host: { idleMs: 100 } });
  await send(W1, { do: "sent" });
  expect(plugins.processes()).toHaveLength(1);
  await until(() => plugins.processes().length === 0, "the idle stop");
});

test("a plugin that ignores shutdown gets SIGTERM, then SIGKILL", async () => {
  const { send, plugins, logged } = setup({ entry: "raw-stubborn.ts", host: { idleMs: 50, drainMs: 100, killMs: 100 } });
  await send(W1, { do: "sent" });
  await logged(/still running after shutdown; sending SIGTERM/);
  await logged(/still running after SIGTERM; sending SIGKILL/);
  await until(() => plugins.processes().length === 0, "the kill");
});
