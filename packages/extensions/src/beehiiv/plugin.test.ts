// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { NewsletterHttpError } from "../newsletter/http";
import { createFakeBeehiiv, FAKE_PUB } from "./fake-beehiiv";
import { createBeehiivPlugin } from "./plugin";

const NOW = Date.parse("2026-11-04T20:00:00Z");
const ctx = (key: string) => ({ workspaceId: "w1", log: () => {}, credential: { key } });
const query = (plugin: ReturnType<typeof createBeehiivPlugin>, name: string, input: unknown, key: string) => plugin.queries[name]!(input, ctx(key));
const list = (count: number, status = "active") => Array.from({ length: count }, (_, i) => ({ email: `p${i}@example.com`, status, created: 1793823726 }));

test("reads a 10,000 subscriber list completely across pages, finding the publication once", async () => {
  const bh = createFakeBeehiiv({ subscriptions: list(10_000) });
  const plugin = createBeehiivPlugin({ fetch: bh.fetch });
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = (await query(plugin, "newsletter.subscribers", cursor ? { cursor } : {}, bh.key)) as { subscribers: { email: string }[]; nextCursor: string | null };
    seen.push(...page.subscribers.map((s) => s.email));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(seen).size).toBe(10_000);
  expect(bh.calls.filter((c) => c.startsWith("GET /v2/publications?"))).toHaveLength(1);
  expect(bh.calls).toHaveLength(101);
});

test("maps beehiiv's states, and anything else is other", async () => {
  const statuses = ["active", "paused", "inactive", "pending", "validating", "invalid", "needs_attention", "unset", "brand_new"];
  const bh = createFakeBeehiiv({ subscriptions: statuses.map((status, i) => ({ email: `S${i}@Example.com`, status, created: 1793823726 })) });
  const page = (await query(createBeehiivPlugin({ fetch: bh.fetch }), "newsletter.subscribers", {}, bh.key)) as { subscribers: { email: string; state: string; createdAt: string }[] };
  expect(page.subscribers.map((s) => s.state)).toEqual(["subscribed", "subscribed", "unsubscribed", "other", "other", "other", "other", "other", "other"]);
  expect(page.subscribers[0]).toMatchObject({ email: "s0@example.com", createdAt: "2026-11-04T20:22:06.000Z" });
});

test("the profile names the publication and counts active subscribers", async () => {
  const bh = createFakeBeehiiv({ name: "Founder notes", subscriptions: [...list(4), ...list(2, "inactive")] });
  expect(await query(createBeehiivPlugin({ fetch: bh.fetch }), "newsletter.profile", {}, bh.key)).toEqual({ listName: "Founder notes", subscriberCount: 4, canSend: true });
});

test("stats come from the post's email stats, delivered included", async () => {
  const bh = createFakeBeehiiv();
  const id = "post_418f1626-686f-4113-b4da-58e0b8ab549a";
  bh.posts.set(id, { id, status: "confirmed", recipients: 1, delivered: 0, opens: 0, clicks: 0, unsubscribes: 0 });
  const plugin = createBeehiivPlugin({ fetch: bh.fetch });
  expect(await query(plugin, "newsletter.stats", { issueId: id }, bh.key)).toEqual({ recipients: 1, delivered: 0, clicks: 0, unsubscribes: 0, opens: 0 });
  await expect(query(plugin, "newsletter.stats", { issueId: "../subscriptions" }, bh.key)).rejects.toThrow(/post id/);
});

test("a key that reaches several publications, or none, is refused", async () => {
  const two = createFakeBeehiiv({ publications: [FAKE_PUB, "pub_00000000-0000-4000-8000-000000000002"] });
  await expect(query(createBeehiivPlugin({ fetch: two.fetch }), "newsletter.profile", {}, two.key)).rejects.toThrow(/more than one publication/);
  const none = createFakeBeehiiv({ publications: [] });
  await expect(query(createBeehiivPlugin({ fetch: none.fetch }), "newsletter.profile", {}, none.key)).rejects.toThrow(/no publication/);
});

test("a revoked key asks for a reconnect without the key in the message", async () => {
  const bh = createFakeBeehiiv({ key: "fake-beehiiv-key" });
  bh.revoke();
  const e = await query(createBeehiivPlugin({ fetch: bh.fetch }), "newsletter.profile", {}, bh.key).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(NewsletterHttpError);
  expect(e).toMatchObject({ status: 401, credentialRejected: true, message: "beehiiv answered 401" });
  expect(bh.calls).toHaveLength(1);
});

test("a 429 waits until beehiiv's ratelimit-reset", async () => {
  const bh = createFakeBeehiiv();
  bh.limitNext(NOW / 1000 + 90);
  const e = await query(createBeehiivPlugin({ fetch: bh.fetch, now: () => NOW }), "newsletter.profile", {}, bh.key).catch((x: unknown) => x);
  expect(e).toMatchObject({ status: 429, retryAfterMs: 90_000 });
});
