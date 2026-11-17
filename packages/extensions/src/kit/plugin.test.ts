// SPDX-License-Identifier: AGPL-3.0-only
import { invoke } from "../test-wire";
import { expect, test } from "vitest";
import { NewsletterHttpError } from "../newsletter/http";
import { createFakeKit } from "./fake-kit";
import { createKitPlugin, KIT_DEFAULTS } from "./plugin";

const ctx = (key: string) => ({ workspaceId: "w1", log: () => {}, credential: { key } });
const query = (plugin: ReturnType<typeof createKitPlugin>, name: string, input: unknown, key: string) => plugin.queries[name]!(input, ctx(key));

const list = (count: number, state = "active") =>
  Array.from({ length: count }, (_, i) => ({ email: `p${i}@example.com`, state, createdAt: "2026-11-04T20:44:39Z" }));

test("reads a 10,000 subscriber list completely across pages", async () => {
  const kit = createFakeKit({ subscribers: list(10_000) });
  const plugin = createKitPlugin({ fetch: kit.fetch });
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = (await query(plugin, "newsletter.subscribers", cursor ? { cursor } : {}, kit.key)) as { subscribers: { email: string }[]; nextCursor: string | null };
    seen.push(...page.subscribers.map((s) => s.email));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toHaveLength(10_000);
  expect(new Set(seen).size).toBe(10_000);
  expect(kit.calls).toHaveLength(20);
});

test("maps Kit's states, and anything unknown is other", async () => {
  const at = "2026-11-04T20:44:39Z";
  const kit = createFakeKit({
    subscribers: [
      { email: "A@Example.com", state: "active", createdAt: at },
      { email: "b@example.com", state: "cancelled", createdAt: at },
      { email: "c@example.com", state: "bounced", createdAt: at },
      { email: "d@example.com", state: "complained", createdAt: at },
      { email: "e@example.com", state: "inactive", createdAt: at },
      { email: "f@example.com", state: "something_new", createdAt: at },
    ],
  });
  const page = (await query(createKitPlugin({ fetch: kit.fetch }), "newsletter.subscribers", {}, kit.key)) as { subscribers: { email: string; state: string }[] };
  expect(page.subscribers.map((s) => [s.email, s.state])).toEqual([
    ["a@example.com", "subscribed"],
    ["b@example.com", "unsubscribed"],
    ["c@example.com", "bounced"],
    ["d@example.com", "complained"],
    ["e@example.com", "other"],
    ["f@example.com", "other"],
  ]);
});

test("passes changed-since to Kit as updated_after", async () => {
  const kit = createFakeKit();
  await query(createKitPlugin({ fetch: kit.fetch }), "newsletter.subscribers", { changedSince: "2026-11-01T00:00:00Z" }, kit.key);
  expect(kit.calls[0]).toContain("updated_after=2026-11-01T00%3A00%3A00Z");
});

test("the profile names the list, counts active subscribers only, and can always send", async () => {
  const kit = createFakeKit({ accountName: "Founder notes", subscribers: [...list(3), ...list(2, "cancelled")] });
  expect(await query(createKitPlugin({ fetch: kit.fetch }), "newsletter.profile", {}, kit.key)).toEqual({ listName: "Founder notes", subscriberCount: 3, canSend: true });
});

test("stats map Kit's names, and a bad id never reaches Kit", async () => {
  const kit = createFakeKit();
  kit.broadcasts.set(7, { id: 7, status: "scheduled", sent: true, sendAt: "2026-11-04T20:05:00Z", recipients: 120, opens: 80, clicks: 9, unsubscribes: 1 });
  const plugin = createKitPlugin({ fetch: kit.fetch });
  expect(await query(plugin, "newsletter.stats", { issueId: "7" }, kit.key)).toEqual({ recipients: 120, clicks: 9, unsubscribes: 1, opens: 80 });
  await expect(query(plugin, "newsletter.stats", { issueId: "../account" }, kit.key)).rejects.toThrow(/broadcast id/);
  expect(kit.calls).toHaveLength(1);
});

test("a revoked key asks for a reconnect, once, without the key in the message", async () => {
  const kit = createFakeKit({ key: "secret-kit-key-123" });
  kit.revoke();
  const e = await query(createKitPlugin({ fetch: kit.fetch }), "newsletter.profile", {}, kit.key).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(NewsletterHttpError);
  expect((e as NewsletterHttpError).credentialRejected).toBe(true);
  expect((e as Error).message).toBe("Kit answered 401");
  expect(kit.calls).toHaveLength(1);
});

test("a 429 is retryable after Kit's fixed wait, since Kit sends no rate headers", async () => {
  const kit = createFakeKit();
  kit.limitNext();
  const e = await query(createKitPlugin({ fetch: kit.fetch }), "newsletter.subscribers", {}, kit.key).catch((x: unknown) => x);
  expect(e).toMatchObject({ status: 429, retryAfterMs: 60_000, credentialRejected: false });
});

test("no key means not connected, and nothing is sent", async () => {
  const kit = createFakeKit();
  const plugin = createKitPlugin({ fetch: kit.fetch });
  await expect(plugin.queries["newsletter.profile"]!({}, { workspaceId: "w1", log: () => {}, credential: null })).rejects.toThrow("Kit is not connected");
  expect(kit.calls).toHaveLength(0);
});

test("the plugin answers through the SDK's invoke", async () => {
  const kit = createFakeKit({ subscribers: list(1) });
  const r = await invoke(createKitPlugin({ fetch: kit.fetch }), "query", { capability: "newsletter.profile", input: {}, credential: { key: kit.key } }, { workspaceId: "w1", log: () => {} });
  expect(r).toEqual({ output: { listName: "Test list", subscriberCount: 1, canSend: true } });
});

test("publish asks to be called at least as early as Kit's own scheduling delay, so an issue arrives on time", () => {
  const publish = createKitPlugin().manifest.capabilities.find((c) => c.kind === "effect" && c.name === "newsletter.publish");
  expect(publish?.kind === "effect" && publish.leadMs).toBeGreaterThanOrEqual(KIT_DEFAULTS.sendDelayMs);
});
