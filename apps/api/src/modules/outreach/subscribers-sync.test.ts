// SPDX-License-Identifier: AGPL-3.0-only
// Reading a whole newsletter list from the fake Kit and fake beehiiv, through errors shaped the way
// the plugin host passes them on.
import { createBeehiivPlugin, createFakeBeehiiv, createFakeKit, createKitPlugin } from "@direx/extensions";
import { expect, test } from "vitest";
import { PluginError, type QueryOutput } from "@direx/plugin-sdk";
import { CallFailed, failureOf } from "../plugins/index";
import { directQuery } from "../plugins/fixtures/query";
import { syncList, type SyncDeps } from "./application/subscribers";

type Plugin = ReturnType<typeof createKitPlugin>;

function harness(plugin: Plugin, key: string, o: { ceilingMs?: number } = {}) {
  let clock = Date.parse("2026-11-04T05:00:00Z");
  const stored = new Map<string, string>();
  const waits: number[] = [];
  const deps: SyncDeps = {
    // As the host does: the plugin's typed fields reach the caller on a CallFailed.
    query: (ws, capability, input, credentialId) =>
      directQuery(plugin, () => ({ key }))(ws, capability, input, credentialId).catch((e: unknown) => {
        throw new CallFailed(`plugin error: ${e instanceof Error ? e.message : String(e)}`, e instanceof PluginError ? e : { reason: "failed" });
      }),
    store: async (_ws, _cred, rows) => void rows.forEach((r) => stored.set(r.email, r.state)),
    now: () => new Date(clock),
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    ...o,
  };
  return { deps, stored, waits, run: () => syncList(deps, "w1", "c1", "kit/newsletter.subscribers") };
}

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `p${i}@example.com`, state: "active", createdAt: "2026-11-01T00:00:00Z" }));

test("a 10,000-subscriber Kit list is read completely", async () => {
  const kit = createFakeKit({ subscribers: people(10_000) });
  const h = harness(createKitPlugin({ fetch: kit.fetch }), kit.key);
  expect(await h.run()).toEqual({ kind: "done", pages: 20, addresses: 10_000 });
  expect(h.stored.size).toBe(10_000);
});

test("one list of an account with several is named on every page read", async () => {
  const inputs: unknown[] = [];
  const pages: QueryOutput<"newsletter.subscribers">[] = [{ subscribers: [{ email: "a@example.com", state: "subscribed", createdAt: "2026-11-01T00:00:00Z" }], nextCursor: "1000" }, { subscribers: [], nextCursor: null }];
  const deps: SyncDeps = { query: async (_ws, _cap, input) => (inputs.push(input), pages[inputs.length - 1]!), store: async () => {}, now: () => new Date(), sleep: async () => {} };
  expect(await syncList(deps, "w1", "c1", "kit/newsletter.subscribers", "a1")).toEqual({ kind: "done", pages: 2, addresses: 1 });
  expect(inputs).toEqual([{ listId: "a1" }, { cursor: "1000", listId: "a1" }]);
});

test("a beehiiv list is read completely, every state included", async () => {
  const statuses = ["active", "inactive", "pending", "paused", "invalid"];
  const bh = createFakeBeehiiv({ subscriptions: Array.from({ length: 250 }, (_, i) => ({ email: `b${i}@example.com`, status: statuses[i % 5]!, created: 1793823726 })) });
  const h = harness(createBeehiivPlugin({ fetch: bh.fetch }) as Plugin, bh.key);
  expect(await h.run()).toMatchObject({ kind: "done", addresses: 250 });
  expect(new Set(h.stored.values())).toEqual(new Set(["subscribed", "unsubscribed", "other"]));
});

test("a 429 halfway waits as the tool says and carries on from the same page", async () => {
  const bh = createFakeBeehiiv({ subscriptions: Array.from({ length: 300 }, (_, i) => ({ email: `b${i}@example.com`, status: "active", created: 1793823726 })) });
  let calls = 0;
  const limited = (async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    // The third call is the second page: limit it once, for 90 seconds.
    if (calls === 3) bh.limitNext(Date.parse("2026-11-04T05:01:30Z") / 1000);
    return bh.fetch(input, init);
  }) as typeof fetch;
  const h = harness(createBeehiivPlugin({ fetch: limited, now: () => Date.parse("2026-11-04T05:00:00Z") }) as Plugin, bh.key);
  expect(await h.run()).toMatchObject({ kind: "done", addresses: 300 });
  expect(h.waits).toEqual([90_000]);
  expect(h.stored.size).toBe(300);
});

test("a revoked key stops this list and keeps what was read", async () => {
  const kit = createFakeKit({ subscribers: people(1200) });
  let pages = 0;
  const revoking = (async (input: string | URL | Request, init?: RequestInit) => {
    if (++pages === 2) kit.revoke();
    return kit.fetch(input, init);
  }) as typeof fetch;
  const h = harness(createKitPlugin({ fetch: revoking }), kit.key);
  expect(await h.run()).toMatchObject({ kind: "key_refused", pages: 1, addresses: 500, detail: "plugin error: Kit answered 401" });
  expect(h.stored.size).toBe(500);
});

test("a tool that keeps saying slow down stops at the ceiling, keeping what was read", async () => {
  const kit = createFakeKit({ subscribers: people(10) });
  kit.limitNext(100);
  const h = harness(createKitPlugin({ fetch: kit.fetch }), kit.key, { ceilingMs: 5 * 60_000 });
  expect(await h.run()).toMatchObject({ kind: "too_slow", pages: 0 });
  expect(h.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5 * 60_000);
});

test("any other failure stops this list with the plugin's words", async () => {
  const kit = createFakeKit();
  const h = harness(createKitPlugin({ fetch: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch }), kit.key);
  expect(await h.run()).toMatchObject({ kind: "failed", detail: "plugin error: Kit answered 500" });
});

test("the status and wait are read from a plugin's typed failure, never its words", () => {
  expect(failureOf(new CallFailed("plugin error: Kit answered 200", { reason: "rate_limited", status: 429, waitMs: 60_000 }))).toEqual({ reason: "rate_limited", status: 429, waitMs: 60_000 });
  expect(failureOf(new CallFailed("plugin error: beehiiv answered 429; wait 5 ms", { reason: "credential_rejected", status: 401 }))).toEqual({ reason: "credential_rejected", status: 401 });
  expect(failureOf(new Error("plugin error: Kit answered 429; wait 60000 ms"))).toEqual({ reason: "failed" });
});
