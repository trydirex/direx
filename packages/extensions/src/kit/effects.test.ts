// SPDX-License-Identifier: AGPL-3.0-only
// Kit's draft, send and cancel effects against the fake, including answers that never arrive.
import { expect, test } from "vitest";
import { createFakeKit } from "./fake-kit";
import { createKitPlugin } from "./plugin";

const NOW = Date.parse("2026-11-04T20:00:00Z");

function setup() {
  const kit = createFakeKit({ subscribers: [{ email: "me@example.com", state: "active", createdAt: "2026-11-04T19:00:00Z" }] });
  /** Set to "PUT" to lose the answer to the next PUT; "any" for the next call of any kind. */
  let loseOn: "PUT" | "any" | null = null;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (loseOn === "any" || (loseOn === "PUT" && init?.method === "PUT")) {
      loseOn = null;
      kit.loseNextAnswer();
    }
    return kit.fetch(input, init);
  }) as typeof globalThis.fetch;
  const plugin = createKitPlugin({ fetch, now: () => NOW });
  const ctx = (action: string) => ({ workspaceId: "w1", log: () => {}, idempotencyKey: action, credential: { key: kit.key } });
  const run = async (name: string, input: unknown, action: string) => {
    const e = plugin.effects[name]!;
    const { spec } = await e.prepare(input, ctx(action));
    return e.execute(spec, ctx(action));
  };
  const reconcile = (name: string, action: string) => plugin.effects[name]!.reconcile!("ignored", ctx(action));
  const draft = async (action = "a-draft") => {
    const r = await run("newsletter.draft", { title: "Week 12", previewText: "What we shipped", html: "<p>Hi</p>" }, action);
    if (r.kind !== "sent") throw new Error("draft failed");
    return r.providerRef!;
  };
  return { kit, plugin, run, reconcile, draft, lose: (on: "PUT" | "any") => void (loseOn = on) };
}

test("a draft is a Kit broadcast with no send time, stamped with the Action", async () => {
  const { kit, draft } = setup();
  const id = await draft();
  expect(kit.broadcasts.get(Number(id))).toMatchObject({ status: "draft", sendAt: null, subject: "Week 12", description: "direx:a-draft" });
});

test("a draft whose answer was lost is found by its stamp, and never drafted twice", async () => {
  const { kit, run, reconcile, lose } = setup();
  lose("any");
  await expect(run("newsletter.draft", { title: "Week 12", html: "<p>Hi</p>" }, "a-lost")).rejects.toThrow("fetch failed");
  const [id] = kit.broadcasts.keys();
  expect(await reconcile("newsletter.draft", "a-lost")).toEqual({ kind: "sent", providerRef: String(id) });
  expect(kit.broadcasts.size).toBe(1);
});

test("a draft that was never made reconciles as unknown, not as not sent", async () => {
  const { reconcile } = setup();
  expect(await reconcile("newsletter.draft", "never")).toEqual({ kind: "unknown" });
});

test("a send schedules the broadcast five minutes out", async () => {
  const { kit, run, draft } = setup();
  const id = await draft();
  expect(await run("newsletter.send", { issueId: id }, "a-send")).toEqual({ kind: "sent", providerRef: id, correlationKey: id });
  expect(kit.broadcasts.get(Number(id))).toMatchObject({ status: "scheduled", sendAt: "2026-11-04T20:05:00.000Z", description: "direx:a-draft send:a-send" });
});

test("a later send time is kept, an earlier one moves to the five-minute window", async () => {
  const { kit, run, draft } = setup();
  const late = await draft("d1");
  await run("newsletter.send", { issueId: late, at: "2026-11-05T09:00:00Z" }, "s1");
  expect(kit.broadcasts.get(Number(late))?.sendAt).toBe("2026-11-05T09:00:00Z");
  const soon = await draft("d2");
  await run("newsletter.send", { issueId: soon, at: "2026-11-04T20:01:00Z" }, "s2");
  expect(kit.broadcasts.get(Number(soon))?.sendAt).toBe("2026-11-04T20:05:00.000Z");
});

test("a send whose answer was lost, then retried, schedules exactly once", async () => {
  const { kit, run, reconcile, draft, lose } = setup();
  const id = await draft();
  const before = kit.calls.length;
  lose("PUT");
  await expect(run("newsletter.send", { issueId: id }, "a-send")).rejects.toThrow("fetch failed");
  expect(await reconcile("newsletter.send", "a-send")).toEqual({ kind: "sent", providerRef: id });
  // A retry anyway sees its own stamp and reports the send without a second PUT.
  expect(await run("newsletter.send", { issueId: id }, "a-send")).toMatchObject({ kind: "sent", providerRef: id });
  expect(kit.calls.slice(before).filter((c) => c.startsWith("PUT"))).toHaveLength(1);
});

test("a send lost before Kit changed anything reconciles as unknown", async () => {
  const { kit, run, reconcile, draft, lose } = setup();
  const id = await draft();
  lose("any"); // the read before the PUT loses its answer, so nothing was scheduled
  await expect(run("newsletter.send", { issueId: id }, "a-send")).rejects.toThrow("fetch failed");
  expect(await reconcile("newsletter.send", "a-send")).toEqual({ kind: "unknown" });
  expect(kit.broadcasts.get(Number(id))?.status).toBe("draft");
});

test("a send refuses a broadcast Direx didn't draft, or one that isn't a draft", async () => {
  const { kit, run, draft } = setup();
  kit.broadcasts.set(5, { id: 5, status: "draft", sendAt: null, description: "written by hand", recipients: 0, opens: 0, clicks: 0, unsubscribes: 0 });
  expect(await run("newsletter.send", { issueId: "5" }, "s1")).toMatchObject({ kind: "refused", permanent: true, detail: expect.stringContaining("didn't draft") });
  expect(kit.broadcasts.get(5)?.status).toBe("draft");
  const id = await draft();
  await run("newsletter.send", { issueId: id }, "s1");
  expect(await run("newsletter.send", { issueId: id }, "s2")).toMatchObject({ kind: "refused", detail: expect.stringContaining("scheduled") });
});

test("a cancel inside the window puts the broadcast back to draft", async () => {
  const { kit, run, draft } = setup();
  const id = await draft();
  await run("newsletter.send", { issueId: id }, "a-send");
  expect(await run("newsletter.cancel", { issueId: id }, "a-cancel")).toEqual({ kind: "sent", providerRef: id });
  expect(kit.broadcasts.get(Number(id))).toMatchObject({ status: "draft", sendAt: null });
});

test("a cancel after Kit has sent reports already sent and changes nothing, even if the broadcast still reads as scheduled", async () => {
  const { kit, run, draft } = setup();
  const id = await draft();
  await run("newsletter.send", { issueId: id }, "a-send");
  kit.complete(Number(id));
  expect(kit.broadcasts.get(Number(id))?.status).toBe("scheduled");
  expect(await run("newsletter.cancel", { issueId: id }, "a-cancel")).toMatchObject({ kind: "refused", permanent: true, detail: expect.stringContaining("already sent") });
  expect(kit.broadcasts.get(Number(id))).toMatchObject({ status: "scheduled", sendAt: "2026-11-04T20:05:00.000Z" });
});

test("a cancel once the send time has passed is refused, even before the stats catch up", async () => {
  const { kit, run, draft } = setup();
  const id = await draft();
  await run("newsletter.send", { issueId: id, at: "2026-11-04T20:05:00Z" }, "a-send");
  const later = createKitPlugin({ fetch: kit.fetch, now: () => Date.parse("2026-11-04T20:05:10Z") });
  const ctx = { workspaceId: "w1", log: () => {}, idempotencyKey: "a-cancel", credential: { key: kit.key } };
  expect(await later.effects["newsletter.cancel"]!.execute({ issueId: id }, ctx)).toMatchObject({ kind: "refused", detail: expect.stringContaining("already sent") });
  expect(kit.broadcasts.get(Number(id))?.status).toBe("scheduled");
});

test("a sent broadcast that was put back to draft is never sent again", async () => {
  const { kit, run, draft } = setup();
  const id = await draft();
  await run("newsletter.send", { issueId: id }, "a-send");
  kit.complete(Number(id));
  Object.assign(kit.broadcasts.get(Number(id))!, { status: "draft", sendAt: null });
  // The same Action retried: its stamp says it already went.
  expect(await run("newsletter.send", { issueId: id }, "a-send")).toMatchObject({ kind: "sent", providerRef: id });
  // A new Action: Direx's own stamps say it was scheduled and never cancelled by Direx.
  expect(await run("newsletter.send", { issueId: id }, "b-send")).toMatchObject({ kind: "refused", detail: expect.stringContaining("may have been sent") });
  expect(kit.broadcasts.get(Number(id))).toMatchObject({ status: "draft", sendAt: null });
  // And cancel doesn't claim to have stopped it.
  expect(await run("newsletter.cancel", { issueId: id }, "a-cancel")).toMatchObject({ kind: "refused", detail: expect.stringContaining("already sent") });
});

test("a broadcast Direx scheduled and someone put back to draft outside Direx is never sent again", async () => {
  const { kit, run, draft } = setup();
  const id = await draft();
  await run("newsletter.send", { issueId: id }, "a-send");
  // Unscheduled in Kit by hand, with no trace left in the stats of whether it went first.
  Object.assign(kit.broadcasts.get(Number(id))!, { status: "draft", sendAt: null });
  expect(await run("newsletter.send", { issueId: id }, "b-send")).toMatchObject({ kind: "refused", detail: expect.stringContaining("may have been sent") });
  expect(kit.broadcasts.get(Number(id))?.status).toBe("draft");
});

test("a cancelled issue can be sent again by a new Action", async () => {
  const { kit, run, draft } = setup();
  const id = await draft();
  await run("newsletter.send", { issueId: id }, "a-send");
  await run("newsletter.cancel", { issueId: id }, "a-cancel");
  expect(await run("newsletter.send", { issueId: id }, "b-send")).toMatchObject({ kind: "sent" });
  expect(kit.broadcasts.get(Number(id))?.status).toBe("scheduled");
});

test("a cancel whose answer was lost is confirmed by reconcile", async () => {
  const { kit, run, reconcile, draft, lose } = setup();
  const id = await draft();
  await run("newsletter.send", { issueId: id }, "a-send");
  lose("PUT");
  await expect(run("newsletter.cancel", { issueId: id }, "a-cancel")).rejects.toThrow("fetch failed");
  expect(kit.broadcasts.get(Number(id))?.status).toBe("draft");
  expect(await reconcile("newsletter.cancel", "a-cancel")).toEqual({ kind: "sent", providerRef: id });
});

test("a 429 can be retried, and a revoked key asks for a reconnect", async () => {
  const { kit, run, draft } = setup();
  const id = await draft();
  kit.limitNext();
  expect(await run("newsletter.send", { issueId: id }, "s1")).toMatchObject({ kind: "refused", retryable: true });
  kit.revoke();
  expect(await run("newsletter.send", { issueId: id }, "s1")).toMatchObject({ kind: "refused", credentialRejected: true });
  expect(kit.broadcasts.get(Number(id))?.status).toBe("draft");
});

test("publish creates the broadcast already scheduled and stamped, in one call", async () => {
  const { kit, run } = setup();
  const r = await run("newsletter.publish", { title: "Week 12", previewText: "What we shipped", html: "<p>Hi</p>" }, "a-issue");
  expect(r).toMatchObject({ kind: "sent" });
  const b = kit.broadcasts.get(Number(r.kind === "sent" ? r.providerRef : 0));
  expect(b).toMatchObject({ status: "scheduled", sendAt: "2026-11-04T20:05:00.000Z", description: "direx:a-issue send:a-issue" });
  expect(kit.calls.filter((c) => !c.startsWith("GET"))).toHaveLength(1);
});

test("publish at a later slot keeps the slot", async () => {
  const { kit, run } = setup();
  const r = await run("newsletter.publish", { title: "Week 12", html: "<p>Hi</p>", at: "2026-11-10T09:00:00Z" }, "a-issue");
  expect(kit.broadcasts.get(Number(r.kind === "sent" ? r.providerRef : 0))?.sendAt).toBe("2026-11-10T09:00:00Z");
});

test("a publish whose answer was lost is found by its stamp, and never made twice", async () => {
  const { kit, run, reconcile, lose } = setup();
  lose("any");
  await expect(run("newsletter.publish", { title: "Week 12", html: "<p>Hi</p>" }, "a-lost")).rejects.toThrow("fetch failed");
  const [id] = kit.broadcasts.keys();
  expect(await reconcile("newsletter.publish", "a-lost")).toEqual({ kind: "sent", providerRef: String(id) });
  expect(kit.broadcasts.size).toBe(1);
  expect(await reconcile("newsletter.publish", "never")).toEqual({ kind: "unknown" });
});

test("prepare refuses a bad input before anything reaches Kit", async () => {
  const { kit, plugin } = setup();
  const ctx = { workspaceId: "w1", log: () => {} };
  await expect(plugin.effects["newsletter.draft"]!.prepare({ title: "", html: "<p>x</p>" }, ctx)).rejects.toThrow("newsletter.draft");
  await expect(plugin.effects["newsletter.send"]!.prepare({ issueId: "1", to: "everyone" }, ctx)).rejects.toThrow("newsletter.send");
  expect(kit.calls).toHaveLength(0);
});
