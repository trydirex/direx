// SPDX-License-Identifier: AGPL-3.0-only
// What crosses the wire under ADR 0028: typed failures on both paths, the SDK version a plugin
// reports, and restricting fields kept from a plugin that has not said it honours them.
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { behavePlugin } from "./fixtures/behave-plugin";
import { parseManifest } from "@direx/plugin-sdk";
import { behaveManifest } from "./fixtures/manifest";
import { CallFailed, createHost, NotStarted } from "./application/host";
import { spawnPlugin } from "./adapters/process";
import { inProcessCall } from "./application/in-process";

const dir = join(import.meta.dirname, "fixtures");
const parsed = parseManifest(behaveManifest);
if (!parsed.ok) throw new Error(parsed.errors.join("; "));
const manifest = parsed.manifest;
const W = crypto.randomUUID();
const hosts: ReturnType<typeof createHost>[] = [];
afterEach(async () => void (await Promise.all(hosts.splice(0).map((h) => h.close({ force: true })))));

function setup(entry: string) {
  const logs: string[] = [];
  const host = createHost({ confinement: "external", hostVersion: "0.2.0", log: (l) => logs.push(l), options: { drainMs: 200, killMs: 200 } });
  hosts.push(host);
  const call = (method: string, params: unknown) => host.call({ manifest, entry: join(dir, entry), dir }, W, method, params);
  return { call, logs };
}

const fail = (p: Promise<unknown>) => p.then(() => expect.unreachable(), (e: unknown) => e as CallFailed);
const SKIP = [{ from: "seed@example.com", subject: "placement", after: 0, before: 1 }];
const token = { accessToken: "t", expiresAt: "2030-01-01T00:00:00Z" };

test("a closed pipe during initialize reports a retryable startup failure without sending a call", async () => {
  const writes: string[] = [];
  const host = createHost({
    confinement: "external", hostVersion: "0.2.0", log: () => {},
    spawn: async (plugin, log) => ({
      ...spawnPlugin(plugin.entry, plugin.dir, log),
      write(line) {
        writes.push(line);
        throw new Error("closed pipe");
      },
    }),
  });
  hosts.push(host);
  const error = await fail(host.call({ manifest, entry: join(dir, "behave.ts"), dir }, W, "execute", {}));
  expect(error).toBeInstanceOf(NotStarted);
  expect(error).toMatchObject({ retryable: true, message: expect.stringMatching(/did not start: could not write/) });
  expect(writes.map((line) => JSON.parse(line).method)).toEqual(["initialize"]);
});

test("process path: a plugin's typed failure arrives as fields, and an unknown reason as failed with its wait", async () => {
  const sdk = setup("behave.ts");
  const typed = await fail(sdk.call("query", { capability: "mailbox.probe_read", input: { actionId: "slow", subject: "s" }, credential: token }));
  expect(typed).toBeInstanceOf(CallFailed);
  expect(typed).toMatchObject({ reason: "rate_limited", status: 429, waitMs: 1500 });
  const raw = setup("raw-spy.ts");
  expect(await fail(raw.call("query", { capability: "mailbox.probe_read", input: {}, credential: token }))).toMatchObject({ reason: "failed", waitMs: 700 });
});

test("the host records the SDK version a plugin reports, or that it reported none", async () => {
  const sdk = setup("behave.ts");
  await sdk.call("query", { capability: "mailbox.probe_read", input: {}, credential: token });
  expect(sdk.logs).toContain("plugin com.example.behave: started, SDK 0.2.0");
  const raw = setup("raw-spy.ts");
  await raw.call("execute", { capability: "behave.send", spec: {}, idempotencyKey: "k", credential: null });
  expect(raw.logs).toContain("plugin com.example.behave: started, SDK version not reported");
});

test("a skip list is never sent to a plugin that has not said it honours one; an empty one is", async () => {
  const raw = setup("raw-spy.ts");
  const refused = await fail(raw.call("poll", { capability: "behave.feed", cursor: null, credential: null, skip: SKIP }));
  expect(refused).toMatchObject({ reason: "invalid_params" });
  expect(refused.message).toMatch(/skip, which needs SDK 0\.2\.0; the plugin reports no version/);
  await raw.call("poll", { capability: "behave.feed", cursor: null, credential: null, skip: [] });
  expect(raw.logs.filter((l) => l.includes('"method":"poll"'))).toHaveLength(1);
  expect(raw.logs.some((l) => l.includes("seed@example.com"))).toBe(false);
  const sdk = setup("behave.ts");
  expect(await sdk.call("poll", { capability: "behave.feed", cursor: null, credential: token, skip: SKIP })).toMatchObject({ cursor: "2" });
});

test("the credential goes on the wire with its kind", async () => {
  const raw = setup("raw-spy.ts");
  await raw.call("execute", { capability: "behave.send", spec: {}, idempotencyKey: "k", credential: token });
  expect(raw.logs.some((l) => l.includes(`"credential":{"kind":"oauth2","accessToken":"t"`))).toBe(true);
});

test("in-process path: the same fields, failed for a plain error, invalid_params for bad params", async () => {
  const call = inProcessCall(behavePlugin, () => {});
  expect(await fail(call(W, "query", { capability: "mailbox.probe_read", input: { actionId: "slow", subject: "s" }, credential: token }))).toMatchObject({ reason: "rate_limited", status: 429, waitMs: 1500 });
  expect(await fail(call(W, "query", { capability: "mailbox.probe_read", input: { actionId: "leak", subject: "s" }, credential: token }))).toMatchObject({ reason: "failed" });
  expect(await fail(call(W, "query", { capability: "mailbox.probe_read", credential: token }))).toMatchObject({ reason: "invalid_params" });
});
