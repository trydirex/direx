// SPDX-License-Identifier: AGPL-3.0-only
// Mailchimp's draft, send, publish and cancel effects against the fake, including failed and lost answers.
import { expect, test } from "vitest";
import { createFakeMailchimp, type FakeMailchimpList } from "./fake-mailchimp";
import { createMailchimpPlugin, FOOTER, withFooter } from "./plugin";

const NOW = Date.parse("2026-11-04T20:00:00Z");
const LIST = "a1b2c3d4e5";
const issue = { title: "Week 12", previewText: "What we shipped", html: "<html><body><p>Hi</p></body></html>", listId: LIST };

function setup(lists?: FakeMailchimpList[]) {
  const mc = createFakeMailchimp(lists ? { lists } : {});
  /** The 1-based call that fails next: with a 503, or applied and then dropped. */
  let failAt: { n: number; how: "503" | "lost" } | null = null;
  let count = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    count++;
    if (failAt?.n === count) {
      const how = failAt.how;
      failAt = null;
      if (how === "503") return new Response("{}", { status: 503 });
      await mc.fetch(input, init);
      throw new TypeError("fetch failed");
    }
    return mc.fetch(input, init);
  }) as typeof globalThis.fetch;
  const plugin = createMailchimpPlugin({ fetch, now: () => NOW });
  const ctx = (action: string) => ({ workspaceId: "w1", log: () => {}, idempotencyKey: action, credential: { key: mc.key } });
  const run = async (name: string, input: unknown, action: string) => {
    const e = plugin.effects[name]!;
    const { spec } = await e.prepare(input, ctx(action));
    return e.execute(spec, ctx(action));
  };
  const reconcile = (name: string, action: string, spec?: unknown) => plugin.effects[name]!.reconcile!("ignored", ctx(action), spec);
  const fail = (n: number, how: "503" | "lost") => {
    count = 0;
    failAt = { n, how };
  };
  return { mc, run, reconcile, fail, calls: () => count };
}

test("publish creates one campaign on the chosen list, stamped, with the list's sender, and sends it now", async () => {
  const { mc, run } = setup();
  const r = await run("newsletter.publish", issue, "a1");
  const [c] = mc.campaigns.values();
  expect(r).toEqual({ kind: "sent", providerRef: c!.id, correlationKey: c!.id });
  expect(c).toMatchObject({ status: "sent", sends: 1, listId: LIST, subject: "Week 12", title: "Week 12 direx:a1 send:a1", fromName: "Ada", replyTo: "ada@example.com" });
  expect(c!.html).toBe(`<html><body><p>Hi</p>${FOOTER}</body></html>`);
  expect(mc.calls.filter((x) => x.startsWith("PATCH"))).toHaveLength(0);
});

test("a publish that fails or loses its answer at any step, then runs again, sends exactly one campaign once", async () => {
  const { calls, run } = setup();
  await run("newsletter.publish", issue, "probe");
  const steps = calls();
  expect(steps).toBe(6);
  for (let n = 1; n <= steps; n++) {
    for (const how of ["503", "lost"] as const) {
      const { mc, run, fail } = setup();
      fail(n, how);
      const first = await run("newsletter.publish", issue, "a1").catch((e: unknown) => e);
      if (how === "503") expect(first).toMatchObject({ kind: "refused", retryable: true });
      expect(await run("newsletter.publish", issue, "a1")).toMatchObject({ kind: "sent" });
      expect([...mc.campaigns.values()].map((c) => [c.status, c.sends])).toEqual([["sent", 1]]);
    }
  }
});

test("a publish whose send answer was lost reconciles as sent; one never sent stays unknown", async () => {
  const { mc, run, reconcile, fail } = setup();
  fail(6, "lost");
  await expect(run("newsletter.publish", issue, "a1")).rejects.toThrow("fetch failed");
  const [c] = mc.campaigns.values();
  expect(await reconcile("newsletter.publish", "a1")).toEqual({ kind: "sent", providerRef: c!.id });
  // Stamped for sending but still a draft: a person decides.
  const other = setup();
  other.fail(6, "503");
  await other.run("newsletter.publish", issue, "a2");
  expect(await other.reconcile("newsletter.publish", "a2")).toEqual({ kind: "unknown" });
  expect(await other.reconcile("newsletter.publish", "never")).toEqual({ kind: "unknown" });
});

test("publish refuses without a list, or with a time ahead, and nothing reaches Mailchimp", async () => {
  const { mc, run } = setup();
  expect(await run("newsletter.publish", { ...issue, listId: undefined }, "a1")).toMatchObject({ kind: "refused", permanent: true, detail: expect.stringContaining("names no Mailchimp list") });
  expect(await run("newsletter.publish", { ...issue, at: "2026-11-04T21:00:00Z" }, "a2")).toMatchObject({ kind: "refused", permanent: true, detail: expect.stringContaining("never schedules") });
  expect(mc.calls).toHaveLength(0);
});

test("a campaign Mailchimp says isn't ready is refused with the checklist's words, and not sent", async () => {
  const { mc, run } = setup([{ id: LIST, name: "Founders", fromName: "Ada" }]);
  expect(await run("newsletter.publish", issue, "a1")).toEqual({ kind: "refused", permanent: true, retryable: false, detail: "Mailchimp says the campaign isn't ready to send: Reply-to address: Reply-to address is missing." });
  expect([...mc.campaigns.values()][0]).toMatchObject({ status: "save", sends: 0 });
});

test("the footer is added only when the HTML has no unsubscribe link", () => {
  expect(withFooter('<p>Hi</p><a href="*|UNSUB|*">Leave</a>')).toBe('<p>Hi</p><a href="*|UNSUB|*">Leave</a>');
  expect(withFooter("<p>Hi</p>")).toBe(`<p>Hi</p>${FOOTER}`);
});

test("draft then send: the draft stays a draft, and the send stamps and sends it", async () => {
  const { mc, run } = setup();
  const d = await run("newsletter.draft", issue, "d1");
  if (d.kind !== "sent") throw new Error("draft failed");
  expect(mc.campaigns.get(d.providerRef!)).toMatchObject({ status: "save", title: "Week 12 direx:d1" });
  expect(await run("newsletter.send", { issueId: d.providerRef }, "s1")).toEqual({ kind: "sent", providerRef: d.providerRef, correlationKey: d.providerRef });
  expect(mc.campaigns.get(d.providerRef!)).toMatchObject({ status: "sent", sends: 1, title: "Week 12 direx:d1 send:s1" });
  // The same Action again reports the send; another Action is refused.
  expect(await run("newsletter.send", { issueId: d.providerRef }, "s1")).toMatchObject({ kind: "sent" });
  expect(await run("newsletter.send", { issueId: d.providerRef }, "s2")).toMatchObject({ kind: "refused", detail: expect.stringContaining("is sent, not a draft") });
  expect(mc.campaigns.get(d.providerRef!)!.sends).toBe(1);
});

test("a send refuses a campaign Direx didn't create, a bad id, and a time ahead", async () => {
  const { mc, run } = setup();
  mc.campaigns.set("c000000099", { id: "c000000099", status: "save", listId: LIST, title: "Made by hand", subject: "Hi", replyTo: "a@example.com", html: "*|UNSUB|*", sends: 0 });
  expect(await run("newsletter.send", { issueId: "c000000099" }, "s1")).toMatchObject({ kind: "refused", detail: expect.stringContaining("didn't create") });
  expect(await run("newsletter.send", { issueId: "../lists" }, "s2")).toMatchObject({ kind: "refused", permanent: true });
  expect(await run("newsletter.send", { issueId: "c000000099", at: "2026-11-05T09:00:00Z" }, "s3")).toMatchObject({ kind: "refused", detail: expect.stringContaining("never schedules") });
  expect(mc.campaigns.get("c000000099")!.sends).toBe(0);
});

test("a draft whose answer was lost is found by its stamp; one never made reconciles as unknown", async () => {
  const { mc, run, reconcile, fail } = setup();
  fail(3, "lost");
  await expect(run("newsletter.draft", issue, "d1")).rejects.toThrow("fetch failed");
  const [c] = mc.campaigns.values();
  expect(await reconcile("newsletter.draft", "d1")).toEqual({ kind: "sent", providerRef: c!.id });
  expect(await reconcile("newsletter.draft", "never")).toEqual({ kind: "unknown" });
  expect(await run("newsletter.draft", { ...issue, listId: undefined }, "d2")).toMatchObject({ kind: "refused", detail: expect.stringContaining("names no Mailchimp list") });
});

test("a send whose answer was lost reconciles as sent", async () => {
  const { mc, run, reconcile, fail } = setup();
  const d = await run("newsletter.draft", issue, "d1");
  if (d.kind !== "sent") throw new Error("draft failed");
  fail(4, "lost");
  await expect(run("newsletter.send", { issueId: d.providerRef }, "s1")).rejects.toThrow("fetch failed");
  expect(mc.campaigns.get(d.providerRef!)!.status).toBe("sent");
  expect(await reconcile("newsletter.send", "s1")).toEqual({ kind: "sent", providerRef: d.providerRef });
});

test("cancel leaves a draft alone, unschedules one scheduled by hand, and refuses one already sent", async () => {
  const { mc, run, reconcile } = setup();
  const base = { listId: LIST, title: "x direx:d", subject: "x", sends: 0 };
  mc.campaigns.set("c1", { id: "c1", status: "save", ...base });
  mc.campaigns.set("c2", { id: "c2", status: "schedule", ...base });
  mc.campaigns.set("c3", { id: "c3", status: "sent", ...base });
  mc.campaigns.set("c4", { id: "c4", status: "paused", ...base });
  expect(await run("newsletter.cancel", { issueId: "c1" }, "x1")).toEqual({ kind: "sent", providerRef: "c1" });
  expect(mc.calls.filter((c) => c.includes("unschedule"))).toHaveLength(0);
  expect(await run("newsletter.cancel", { issueId: "c2" }, "x2")).toEqual({ kind: "sent", providerRef: "c2" });
  expect(mc.campaigns.get("c2")!.status).toBe("save");
  expect(await run("newsletter.cancel", { issueId: "c3" }, "x3")).toMatchObject({ kind: "refused", detail: expect.stringContaining("already sent") });
  expect(await run("newsletter.cancel", { issueId: "c4" }, "x4")).toMatchObject({ kind: "refused", detail: "the campaign is paused" });
  expect(await run("newsletter.cancel", { issueId: "../x" }, "x5")).toMatchObject({ kind: "refused", permanent: true });
  expect(await reconcile("newsletter.cancel", "x2", { issueId: "c2" })).toEqual({ kind: "sent", providerRef: "c2" });
  expect(await reconcile("newsletter.cancel", "x3", { issueId: "c3" })).toEqual({ kind: "unknown" });
  expect(await reconcile("newsletter.cancel", "x5", { issueId: "../x" })).toEqual({ kind: "unknown" });
});

test("a revoked key asks for a reconnect, and a 404 is a permanent refusal", async () => {
  const { mc, run } = setup();
  expect(await run("newsletter.send", { issueId: "c404" }, "s1")).toMatchObject({ kind: "refused", permanent: true, detail: "Mailchimp answered 404" });
  mc.revoke();
  expect(await run("newsletter.publish", issue, "a1")).toEqual({ kind: "refused", permanent: false, retryable: true, detail: "Mailchimp answered 401", credentialRejected: true });
});
