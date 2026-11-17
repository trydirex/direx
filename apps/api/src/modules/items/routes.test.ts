// SPDX-License-Identifier: AGPL-3.0-only
// Items over HTTP with real sessions, real roles and a real Dispatcher.
import { expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { POST, actionIdOf, itemsApp, person } from "./fixtures/items";

// A post whose body says so shows as a LinkedIn post, as social's appearance would.
const LINKEDIN = { kind: "post" as const, account: "Acme", network: "LinkedIn", link: null };
const { ledger, clock, items, script, call, signIn, createOrg, addMember } = await itemsApp({ appearance: async (_w, a) => ((a.content as { body?: string } | null)?.body === "on linkedin" ? LINKEDIN : null) });

const owner = await signIn();
const W = (await createOrg(owner)).workspace.id;
const url = (rest = "") => `/api/w/${W}/items${rest}`;
const post_ = (path: string, cookie: string, body?: unknown) => call(path, cookie, { method: "POST", ...(body !== undefined && { body }) });
const hours = (h: number) => new Date(clock.at.getTime() + h * 3_600_000);
async function needsApproval(details: { warnings?: string[]; plannedAt?: Date } = {}) {
  const i = await items.createActionItem(W, {
    idempotencyKey: crypto.randomUUID(),
    capability: POST,
    dedupe: "blind",
    spec: { body: "hello" },
    actor: person,
    details: { title: "A post", channel: "post", warnings: (details.warnings ?? []).map((text) => ({ code: "unspecified" as const, text })), plannedAt: details.plannedAt },
  });
  const r = await items.submitItem(W, i.id, person);
  if (!r.ok) throw new Error(r.reason);
  return r.item;
}

test("the whole flow: Needs you, approve, send, move, approve again", async () => {
  const i = await needsApproval({ plannedAt: hours(2) });
  const list = (await (await call(url("?needsYou=true"), owner)).json()) as { items: { id: string }[]; needsYouCount: number };
  expect(list.items.map((x) => x.id)).toContain(i.id);
  expect(list.needsYouCount).toBeGreaterThan(0);

  const approved = await post_(url(`/${i.id}/approve`), owner, { revision: 1 });
  expect(approved.status).toBe(200);
  expect(((await approved.json()) as { item: { state: string } }).item.state).toBe("scheduled");

  const moved = await post_(url("/move"), owner, { items: [{ id: i.id, plannedAt: hours(3).toISOString() }] });
  expect(await moved.json()).toEqual({ results: [{ id: i.id, ok: true }] });
  const again = await post_(url(`/${i.id}/approve`), owner, { revision: 1 });
  expect(again.status).toBe(200);

  clock.at = hours(3);
  await ledger.run(W, await actionIdOf(W, i.id));
  const detail = (await (await call(url(`/${i.id}`), owner)).json()) as { item: { state: string }; content: unknown; timeline: { to: string; dispatchGapMs?: number | null }[]; writtenFrom: unknown };
  expect(detail.item.state).toBe("sent");
  // A person's own post was written from nothing Direx recorded.
  expect(detail.writtenFrom).toBeNull();
  expect(detail.content).toEqual({ body: "hello" });
  expect(detail.timeline.map((e) => e.to)).toEqual(["draft", "needs_approval", "scheduled", "needs_approval", "scheduled", "sent"]);
  // The send says how long after the last check it went, against the 2 second target.
  const gap = detail.timeline.at(-1)?.dispatchGapMs;
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(2000);
});

test("a snapshot or approver in the request is rejected, not ignored", async () => {
  const i = await needsApproval();
  expect((await post_(url(`/${i.id}/approve`), owner, { revision: 1, snapshot: [] })).status).toBe(400);
  expect((await post_(url(`/${i.id}/approve`), owner, { revision: 1, approverId: person.userId })).status).toBe(400);
  expect((await items.view(W, i.id))!.state).toBe("needs_approval");
});

test("refusals are named", async () => {
  const i = await needsApproval();
  const stale = await post_(url(`/${i.id}/approve`), owner, { revision: 9 });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "draft_version_moved" });
  const past = await post_(url("/move"), owner, { items: [{ id: i.id, plannedAt: hours(-1).toISOString() }] });
  expect(await past.json()).toEqual({ results: [{ id: i.id, ok: false, reason: "slot_in_past" }] });
  expect((await post_(url(`/${crypto.randomUUID()}/approve`), owner, { revision: 1 })).status).toBe(404);
});

test("bulk approve refuses what isn't clean", async () => {
  const clean = await needsApproval();
  const warned = await needsApproval({ warnings: ["a claim has no source"] });
  const r = await post_(url("/approve-clean"), owner, { items: [{ id: clean.id, revision: 1 }, { id: warned.id, revision: 1 }] });
  expect(await r.json()).toEqual({ results: [{ id: clean.id, ok: true }, { id: warned.id, ok: false, reason: "not_clean" }] });
  const tooMany = Array.from({ length: 201 }, () => ({ id: clean.id, revision: 1 }));
  expect((await post_(url("/approve-clean"), owner, { items: tooMany })).status).toBe(400);
});

test("each route follows the role table", async () => {
  const marketer = await addMember(owner, W, "marketer");
  const contributor = await addMember(owner, W, "contributor");
  const viewer = await addMember(owner, W, "viewer");
  const i = await needsApproval();
  const approve = (c: string) => post_(url(`/${i.id}/approve`), c, { revision: 1 });
  const bulk = (c: string) => post_(url("/approve-clean"), c, { items: [{ id: i.id, revision: 1 }] });
  const resume = (c: string) => post_(url(`/${i.id}/resume`), c);
  const resolve = (c: string) => post_(url(`/${i.id}/resolve-unknown`), c, { choice: "mark_sent" });
  const cancel = (c: string) => post_(url(`/${i.id}/cancel`), c);
  const move = (c: string) => post_(url("/move"), c, { items: [{ id: i.id, plannedAt: hours(1).toISOString() }] });
  const triage = (c: string) => call(url(`/${i.id}/triage`), c, { method: "PATCH", body: { snoozedUntil: null } });

  for (const req of [approve, bulk, resume, resolve]) {
    expect((await req(contributor.cookie)).status).toBe(403);
    expect((await req(viewer.cookie)).status).toBe(403);
  }
  for (const req of [cancel, move, triage]) expect((await req(viewer.cookie)).status).toBe(403);
  expect((await call(url(), viewer.cookie)).status).toBe(200);
  expect((await call(url(`/${i.id}`), viewer.cookie)).status).toBe(200);

  expect((await triage(contributor.cookie)).status).toBe(200);
  expect((await move(contributor.cookie)).status).toBe(200);
  const scheduledFirst = await needsApproval();
  expect((await post_(url(`/${scheduledFirst.id}/approve`), marketer.cookie, { revision: 1 })).status).toBe(200);
}, 30_000);

test("a member of one Workspace gets 404 on another's Items, and no session gets 401", async () => {
  const stranger = await signIn();
  await createOrg(stranger, "Other");
  const i = await needsApproval();
  const paths: [string, string, unknown?][] = [
    ["GET", url()],
    ["GET", url(`/${i.id}`)],
    ["POST", url(`/${i.id}/approve`), { revision: 1 }],
    ["POST", url("/approve-clean"), { items: [{ id: i.id, revision: 1 }] }],
    ["POST", url(`/${i.id}/cancel`)],
    ["POST", url(`/${i.id}/resume`)],
    ["POST", url(`/${i.id}/resolve-unknown`), { choice: "resend" }],
    ["POST", url("/move"), { items: [{ id: i.id, plannedAt: hours(1).toISOString() }] }],
    ["PATCH", url(`/${i.id}/triage`), { snoozedUntil: null }],
  ];
  for (const [method, path, body] of paths) {
    expect((await call(path, stranger, { method, body })).status).toBe(404);
    expect((await call(path, undefined, { method, body })).status).toBe(401);
  }
});

test("an unknown outcome shows its two choices' effects, and a settled one is Sent", async () => {
  script.next = "throw";
  const i = await needsApproval();
  await post_(url(`/${i.id}/approve`), owner, { revision: 1 });
  await ledger.run(W, await actionIdOf(W, i.id));
  expect(await items.view(W, i.id)).toMatchObject({ state: "held", reasonCode: "outcome_unknown", reason: "not sure it sent", movable: false });
  expect((await post_(url(`/${i.id}/cancel`), owner)).status).toBe(409);
  const settled = await post_(url(`/${i.id}/resolve-unknown`), owner, { choice: "mark_sent" });
  expect(((await settled.json()) as { item: { state: string } }).item.state).toBe("sent");
});

test("resuming a Held Item sends it back through the checks", async () => {
  script.next = "refused_retryable";
  const i = await needsApproval();
  await post_(url(`/${i.id}/approve`), owner, { revision: 1 });
  const id = await actionIdOf(W, i.id);
  await ledger.run(W, id);
  for (let n = 0; n < 4; n++) {
    clock.at = hours(1);
    await ledger.run(W, id);
  }
  expect(await items.view(W, i.id)).toMatchObject({ state: "held", reasonCode: "provider_rejected" });
  const resumed = await post_(url(`/${i.id}/resume`), owner);
  expect(((await resumed.json()) as { item: { state: string } }).item.state).toBe("scheduled");
});

test("decisions from the review page count toward that person's own rates, and nobody else's", async () => {
  const rates = async (cookie: string) => {
    const r = await call(`/api/w/${W}/review-rates`, cookie);
    expect(r.status, await r.clone().text()).toBe(200);
    return (await r.json()) as { decisions: number; medianSeconds: number | null; changedShare: number | null; warning: boolean };
  };
  const before = (await rates(owner)).decisions;
  const ago = (s: number) => new Date(clock.at.getTime() - s * 1000).toISOString();

  const read = await needsApproval({ plannedAt: hours(2) });
  expect((await post_(url(`/${read.id}/approve`), owner, { revision: 1, openedAt: ago(20) })).status).toBe(200);
  // Left open for two hours, it counts as thirty minutes.
  const dropped = await needsApproval({ plannedAt: hours(2) });
  expect((await post_(url(`/${dropped.id}/cancel?openedAt=${encodeURIComponent(ago(7200))}`), owner)).status).toBe(200);
  // Approved from elsewhere, with no time it opened: not a review-page decision.
  const elsewhere = await needsApproval({ plannedAt: hours(2) });
  expect((await post_(url(`/${elsewhere.id}/approve`), owner, { revision: 1 })).status).toBe(200);

  const mine = await rates(owner);
  expect(mine.decisions).toBe(before + 2);
  if (before === 0) expect(mine).toMatchObject({ medianSeconds: (20 + 1800) / 2, changedShare: 0.5, warning: false });
  const marketer = await addMember(owner, W, "marketer");
  expect((await rates(marketer.cookie)).decisions).toBe(0);
});

test("praise on approve and a reason on cancel are kept with the decision; an unknown reason or a long sentence is refused", async () => {
  const db = await appClient();
  const recorded = async (itemId: string) => {
    await db.query("select set_config('app.workspace_id', $1, false)", [W]);
    return (await db.query("select decision, reason, reason_note from review_decisions where item_id = $1", [itemId])).rows;
  };
  const opened = new Date(clock.at.getTime() - 10_000).toISOString();
  const liked = await needsApproval({ plannedAt: hours(2) });
  expect((await post_(url(`/${liked.id}/approve`), owner, { revision: 1, openedAt: opened, praise: true })).status).toBe(200);
  expect(await recorded(liked.id)).toEqual([{ decision: "approve", reason: "great", reason_note: null }]);

  const dropped = await needsApproval({ plannedAt: hours(2) });
  const cancel = (query: string) => post_(url(`/${dropped.id}/cancel?openedAt=${encodeURIComponent(opened)}&${query}`), owner);
  expect((await cancel("reason=rude")).status).toBe(400);
  expect((await cancel(`reason=long&note=${"x".repeat(301)}`)).status).toBe(400);
  expect((await cancel(`reason=voice&note=${encodeURIComponent("Sounds like a bank.")}`)).status).toBe(200);
  expect(await recorded(dropped.id)).toEqual([{ decision: "reject", reason: "voice", reason_note: "Sounds like a bank." }]);
  await db.end();
});

test("a post's detail says how it will appear: the account and network it goes out as", async () => {
  const i = await items.createActionItem(W, { idempotencyKey: crypto.randomUUID(), capability: POST, dedupe: "blind", spec: { body: "on linkedin" }, actor: person, details: { title: "A post", channel: "post", warnings: [] } });
  const detail = (await (await call(url(`/${i.id}`), owner)).json()) as { appearance: unknown };
  expect(detail.appearance).toEqual(LINKEDIN);
});
