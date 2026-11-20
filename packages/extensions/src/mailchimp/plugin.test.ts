// SPDX-License-Identifier: AGPL-3.0-only
// Mailchimp's reads against the fake: members in pages, the account's lists, a list's size, a report.
import { expect, test } from "vitest";
import { NewsletterHttpError } from "../newsletter/http";
import { invoke } from "../test-wire";
import { createFakeMailchimp, type FakeMailchimpList } from "./fake-mailchimp";
import { createMailchimpPlugin } from "./plugin";

const ctx = (key: string) => ({ workspaceId: "w1", log: () => {}, credential: { key } });
const query = (plugin: ReturnType<typeof createMailchimpPlugin>, name: string, input: unknown, key: string) => plugin.queries[name]!(input, ctx(key));
const AT = "2026-11-04T20:44:39+00:00";
const members = (count: number, status = "subscribed") => Array.from({ length: count }, (_, i) => ({ email: `p${i}@example.com`, status, opt: AT, changed: AT }));
const two: FakeMailchimpList[] = [
  { id: "aaaa111111", name: "Founders", members: members(3) },
  { id: "bbbb222222", name: "Customers", members: members(2) },
];

test("reads a 10,000 member list completely across pages", async () => {
  const mc = createFakeMailchimp({ lists: [{ id: "aaaa111111", name: "Founders", members: members(10_000) }] });
  const plugin = createMailchimpPlugin({ fetch: mc.fetch });
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = (await query(plugin, "newsletter.subscribers", { listId: "aaaa111111", ...(cursor && { cursor }) }, mc.key)) as { subscribers: { email: string }[]; nextCursor: string | null };
    seen.push(...page.subscribers.map((s) => s.email));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(new Set(seen).size).toBe(10_000);
  expect(mc.calls).toHaveLength(10);
});

test("maps Mailchimp's states, lower-cases emails, and dates a member by opt-in, then signup, then last change", async () => {
  const mc = createFakeMailchimp({
    lists: [
      {
        id: "aaaa111111",
        name: "Founders",
        members: [
          { email: "A@Example.com", status: "subscribed", opt: "2026-01-01T00:00:00+00:00", signup: "2025-01-01T00:00:00+00:00", changed: AT },
          { email: "b@example.com", status: "unsubscribed", signup: "2025-01-01T00:00:00+00:00", changed: AT },
          { email: "c@example.com", status: "cleaned", changed: AT },
          { email: "d@example.com", status: "pending", changed: AT },
          { email: "e@example.com", status: "transactional", changed: AT },
          { email: "f@example.com", status: "archived", changed: AT },
          { email: "g@example.com", status: "something_new", changed: AT },
        ],
      },
    ],
  });
  const page = (await query(createMailchimpPlugin({ fetch: mc.fetch }), "newsletter.subscribers", { listId: "aaaa111111" }, mc.key)) as { subscribers: { email: string; state: string; createdAt: string }[]; nextCursor: string | null };
  expect(page.subscribers.map((s) => [s.email, s.state, s.createdAt])).toEqual([
    ["a@example.com", "subscribed", "2026-01-01T00:00:00.000Z"],
    ["b@example.com", "unsubscribed", "2025-01-01T00:00:00.000Z"],
    ["c@example.com", "bounced", "2026-11-04T20:44:39.000Z"],
    ["d@example.com", "other", "2026-11-04T20:44:39.000Z"],
    ["e@example.com", "other", "2026-11-04T20:44:39.000Z"],
    ["f@example.com", "other", "2026-11-04T20:44:39.000Z"],
    ["g@example.com", "other", "2026-11-04T20:44:39.000Z"],
  ]);
  expect(page.nextCursor).toBeNull();
});

test("passes changed-since as since_last_changed", async () => {
  const mc = createFakeMailchimp();
  await query(createMailchimpPlugin({ fetch: mc.fetch }), "newsletter.subscribers", { listId: "a1b2c3d4e5", changedSince: "2026-11-01T00:00:00Z" }, mc.key);
  expect(mc.calls[0]).toContain("since_last_changed=2026-11-01T00%3A00%3A00Z");
});

test("a read without a list uses the account's only list, and asks for a choice when there are several", async () => {
  const one = createFakeMailchimp({ lists: [two[0]!] });
  const page = (await query(createMailchimpPlugin({ fetch: one.fetch }), "newsletter.subscribers", {}, one.key)) as { subscribers: unknown[] };
  expect(page.subscribers).toHaveLength(3);
  const several = createFakeMailchimp({ lists: two });
  await expect(query(createMailchimpPlugin({ fetch: several.fetch }), "newsletter.subscribers", {}, several.key)).rejects.toThrow("Mailchimp has several lists: choose one on the Newsletter settings page");
  await expect(query(createMailchimpPlugin({ fetch: several.fetch }), "newsletter.subscribers", { listId: "../lists" }, several.key)).rejects.toThrow("letters and digits");
  await expect(query(createMailchimpPlugin({ fetch: several.fetch }), "newsletter.subscribers", { listId: "aaaa111111", cursor: "-5" }, several.key)).rejects.toThrow("offset");
});

test("the profile names the chosen list, or the account when none is chosen yet, so a new key can be saved", async () => {
  const mc = createFakeMailchimp({ lists: two });
  const plugin = createMailchimpPlugin({ fetch: mc.fetch });
  expect(await query(plugin, "newsletter.profile", { listId: "bbbb222222" }, mc.key)).toEqual({ listName: "Customers", subscriberCount: 2, canSend: true });
  expect(await query(plugin, "newsletter.profile", null, mc.key)).toEqual({ listName: "Mailchimp", subscriberCount: 5, canSend: true });
  const one = createFakeMailchimp({ lists: [two[0]!] });
  expect(await query(createMailchimpPlugin({ fetch: one.fetch }), "newsletter.profile", {}, one.key)).toEqual({ listName: "Founders", subscriberCount: 3, canSend: true });
});

test("lists name every list in the account with its subscriber count", async () => {
  const mc = createFakeMailchimp({ lists: two });
  expect(await query(createMailchimpPlugin({ fetch: mc.fetch }), "newsletter.lists", null, mc.key)).toEqual([
    { id: "aaaa111111", name: "Founders", subscriberCount: 3 },
    { id: "bbbb222222", name: "Customers", subscriberCount: 2 },
  ]);
});

test("stats map Mailchimp's report, and a bad id never reaches Mailchimp", async () => {
  const mc = createFakeMailchimp();
  mc.reports.set("c000000001", { emails_sent: 120, unsubscribed: 1, opens: { unique_opens: 80 }, clicks: { unique_clicks: 9 } });
  const plugin = createMailchimpPlugin({ fetch: mc.fetch });
  expect(await query(plugin, "newsletter.stats", { issueId: "c000000001" }, mc.key)).toEqual({ recipients: 120, clicks: 9, unsubscribes: 1, opens: 80 });
  await expect(query(plugin, "newsletter.stats", { issueId: "../lists" }, mc.key)).rejects.toThrow(/campaign id/);
  expect(mc.calls).toHaveLength(1);
});

test("a revoked key asks for a reconnect, once, without the key in the message", async () => {
  const mc = createFakeMailchimp();
  mc.revoke();
  const e = await query(createMailchimpPlugin({ fetch: mc.fetch }), "newsletter.lists", null, mc.key).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(NewsletterHttpError);
  expect((e as NewsletterHttpError).credentialRejected).toBe(true);
  expect((e as Error).message).toBe("Mailchimp answered 401");
  expect(mc.calls).toHaveLength(1);
});

test("a 429 is retryable after a fixed wait, since Mailchimp sends no rate headers", async () => {
  const mc = createFakeMailchimp();
  mc.limitNext();
  const e = await query(createMailchimpPlugin({ fetch: mc.fetch }), "newsletter.lists", null, mc.key).catch((x: unknown) => x);
  expect(e).toMatchObject({ status: 429, retryAfterMs: 60_000, credentialRejected: false });
});

test("a key without a data center is refused before any call, and the host comes only from the key", async () => {
  const mc = createFakeMailchimp();
  const plugin = createMailchimpPlugin({ fetch: mc.fetch });
  for (const key of ["0123456789abcdef", "0123456789abcdef-evil.example.com/x", "0123456789abcdef-us21.attacker"]) {
    const e = (await query(plugin, "newsletter.lists", null, key).catch((x: unknown) => x)) as Error;
    expect(e).toMatchObject({ reason: "credential_rejected" });
    expect(e.message).not.toContain(key);
  }
  expect(mc.calls).toHaveLength(0);
  await expect(plugin.queries["newsletter.lists"]!(null, { workspaceId: "w1", log: () => {}, credential: null })).rejects.toThrow("Mailchimp is not connected");
});

test("the plugin answers through the SDK's invoke", async () => {
  const mc = createFakeMailchimp();
  const r = await invoke(createMailchimpPlugin({ fetch: mc.fetch }), "query", { capability: "newsletter.lists", input: null, credential: { key: mc.key } }, { workspaceId: "w1", log: () => {} });
  expect(r).toEqual({ output: [{ id: "a1b2c3d4e5", name: "Founders", subscriberCount: 0 }] });
});
