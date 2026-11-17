// SPDX-License-Identifier: AGPL-3.0-only
// beehiiv's draft, send and cancel effects against the fake.
import { expect, test } from "vitest";
import { createFakeBeehiiv } from "./fake-beehiiv";
import { createBeehiivPlugin, NEEDS_PRO } from "./plugin";

const NOW = Date.parse("2026-11-04T20:00:00Z");

function setup(o: { sendApi?: boolean } = {}) {
  const bh = createFakeBeehiiv({ ...o, subscriptions: [{ email: "me@example.com", status: "active", created: 1793823726 }] });
  const plugin = createBeehiivPlugin({ fetch: bh.fetch, now: () => NOW });
  const ctx = (action: string) => ({ workspaceId: "w1", log: () => {}, idempotencyKey: action, credential: { key: bh.key } });
  const run = async (name: string, input: unknown, action = "a1") => {
    const e = plugin.effects[name]!;
    const { spec } = await e.prepare(input, ctx(action));
    return e.execute(spec, ctx(action));
  };
  const draft = async () => {
    const r = await run("newsletter.draft", { title: "Week 12", html: "<p>Hi</p>" });
    if (r.kind !== "sent") throw new Error(`draft failed: ${JSON.stringify(r)}`);
    return r.providerRef!;
  };
  return { bh, plugin, run, draft };
}

test("a draft is a beehiiv post left as draft", async () => {
  const { bh, draft } = setup();
  const id = await draft();
  expect(bh.posts.get(id)?.status).toBe("draft");
});

test("a send confirms the draft once, and a second send is refused", async () => {
  const { bh, run, draft } = setup();
  const id = await draft();
  expect(await run("newsletter.send", { issueId: id })).toEqual({ kind: "sent", providerRef: id });
  expect(bh.posts.get(id)?.status).toBe("confirmed");
  expect(await run("newsletter.send", { issueId: id })).toMatchObject({ kind: "refused", detail: expect.stringContaining("not sent again") });
  expect(bh.calls.filter((c) => c.startsWith("PATCH"))).toHaveLength(1);
});

test("a send for a later time is refused, since beehiiv can't unschedule", async () => {
  const { bh, run, draft } = setup();
  const id = await draft();
  expect(await run("newsletter.send", { issueId: id, at: "2026-11-05T09:00:00Z" })).toMatchObject({ kind: "refused", detail: expect.stringContaining("at its time") });
  expect(bh.posts.get(id)?.status).toBe("draft");
  expect(await run("newsletter.send", { issueId: id, at: "2026-11-04T20:00:30Z" })).toMatchObject({ kind: "sent" });
});

test("a plan without the send API refuses with the needs-Pro reason, and reads still work", async () => {
  const { plugin, bh, run } = setup({ sendApi: false });
  expect(await run("newsletter.draft", { title: "Week 12", html: "<p>Hi</p>" })).toEqual({ kind: "refused", permanent: false, retryable: false, detail: NEEDS_PRO, plan: "Pro" });
  const page = (await plugin.queries["newsletter.subscribers"]!({}, { workspaceId: "w1", log: () => {}, credential: { key: bh.key } })) as { subscribers: unknown[] };
  expect(page.subscribers).toHaveLength(1);
});

test("a cancel before beehiiv has the post changes nothing; after, it is already sent", async () => {
  const { bh, run, draft } = setup();
  const id = await draft();
  expect(await run("newsletter.cancel", { issueId: id })).toEqual({ kind: "sent", providerRef: id });
  expect(bh.posts.get(id)?.status).toBe("draft");
  await run("newsletter.send", { issueId: id });
  expect(await run("newsletter.cancel", { issueId: id })).toMatchObject({ kind: "refused", permanent: true, detail: expect.stringContaining("already sent") });
});

test("a lost answer throws, so the Dispatcher holds the Action for a person", async () => {
  const { bh, draft } = setup();
  const id = await draft();
  const plugin = createBeehiivPlugin({
    now: () => NOW,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await bh.fetch(input, init);
      if (init?.method === "PATCH") throw new TypeError("fetch failed");
      return res;
    }) as typeof fetch,
  });
  const ctx = { workspaceId: "w1", log: () => {}, idempotencyKey: "a1", credential: { key: bh.key } };
  await expect(plugin.effects["newsletter.send"]!.execute({ issueId: id }, ctx)).rejects.toThrow("fetch failed");
  expect(plugin.effects["newsletter.send"]!.reconcile).toBeUndefined();
});

test("publish creates the post confirmed, in one call, and refuses a later time", async () => {
  const { bh, run } = setup();
  const r = await run("newsletter.publish", { title: "Week 12", html: "<p>Hi</p>" });
  expect(r).toMatchObject({ kind: "sent" });
  expect(bh.posts.get(r.kind === "sent" ? r.providerRef! : "")?.status).toBe("confirmed");
  expect(bh.calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  expect(await run("newsletter.publish", { title: "Week 13", html: "<p>Hi</p>", at: "2026-11-10T09:00:00Z" })).toMatchObject({ kind: "refused", detail: expect.stringContaining("at its time") });
});

test("publish on a plan without the send API refuses with the needs-Pro reason", async () => {
  const { run } = setup({ sendApi: false });
  expect(await run("newsletter.publish", { title: "Week 12", html: "<p>Hi</p>" })).toEqual({ kind: "refused", permanent: false, retryable: false, detail: NEEDS_PRO, plan: "Pro" });
});

test("publish has no reconcile, so a lost answer is held for a person", () => {
  const { plugin } = setup();
  expect(plugin.effects["newsletter.publish"]!.reconcile).toBeUndefined();
});

test("a revoked key asks for a reconnect, and a bad id never reaches beehiiv", async () => {
  const { bh, run, draft, plugin } = setup();
  const id = await draft();
  const before = bh.calls.length;
  expect(await plugin.effects["newsletter.send"]!.execute({ issueId: "post_../x" }, { workspaceId: "w1", log: () => {}, idempotencyKey: "a1", credential: { key: bh.key } })).toMatchObject({ kind: "refused", permanent: true });
  expect(bh.calls).toHaveLength(before);
  bh.revoke();
  expect(await run("newsletter.send", { issueId: id })).toMatchObject({ kind: "refused", credentialRejected: true });
});
