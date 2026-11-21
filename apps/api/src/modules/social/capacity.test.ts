// SPDX-License-Identifier: AGPL-3.0-only
// A post's place on its Social account's day (ADR 0038): placed inside the account's hours and gap,
// counted against its budget, refused to a person on a spent day, and safe under many writers.
import { closeDb } from "@direx/db";
import { closeAuthDb } from "@direx/db/auth";
import { describe, expect, it, vi } from "vitest";
import { appClient } from "../../../../../test/db";
import { createVault, credentialLabel, rootKeyFromEnv } from "../credentials/index";
import { routeCapacity } from "../items/index";
import { actionIdOf, itemsWorld, person } from "../items/fixtures/items";
import { socialCapacity } from "./application/capacity";
import { offPace } from "./application/pace";

const PUBLISH = "com.example.testnet/social.publish";
const PACE = { from: 8 * 60, until: 20 * 60, weekends: true, gapMinutes: 60 };
const HOUR = 3_600_000;

async function world() {
  const capacity = routeCapacity((c) => (c.endsWith("/social.publish") ? socialCapacity({ networks: () => [{ connection: "testnet", pace: PACE }] }) : undefined));
  const w = await itemsWorld({ resolvers: { credential: credentialLabel }, capacity });
  const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => w.clock.at });
  const made = await vault.create({ workspaceId: w.W, actorUserId: person.userId, scope: "workspace", kind: "api_key", key: "page", name: "Page", meta: {}, value: { key: "x" } });
  if (!made.ok) throw new Error(made.reason);
  const credentialId = made.credential.id;
  const db = await appClient();
  const q = async (text: string, params: unknown[] = []) => {
    await db.query("begin");
    await db.query("select set_config('app.workspace_id', $1, true)", [w.W]);
    const r = await db.query(text, params);
    await db.query("commit");
    return r.rows;
  };
  const addAccount = (target: string) => q("insert into social_accounts (workspace_id, credential_id, connection, account_type, network_id, name) values ($1, $2, 'testnet', 'page', $3, 'Page')", [w.W, credentialId, target]);
  await addAccount("acct-1");
  const spec = (target: string) => ({ text: "hello", followUps: [], target });
  const post = (plannedAt: Date, placement: "auto" | "exact" = "auto", target = "acct-1", personId?: string) =>
    w.items.createActionItem(w.W, {
      idempotencyKey: crypto.randomUUID(),
      capability: PUBLISH,
      dedupe: "blind",
      spec: { ...spec(target), ...(personId && { touch: { personId, touchClass: "cold" } }) },
      credentialId,
      actor: person,
      placement,
      details: { title: "A post", channel: "post", warnings: [], plannedAt },
    });
  const reserved = async (day: string) => ((await q("select distinct on (action_id) action_id, slot from social_reservations where day = $1 order by action_id, created_at desc", [day])) as { slot: Date }[]).map((r) => r.slot);
  const retarget = (id: string, target: string, plannedAt: Date) => w.items.reviseActionItem(w.W, id, { spec: spec(target), actor: person, placement: "exact", details: { warnings: [], plannedAt } });
  return { ...w, addAccount, post, retarget, reserved, q, done: () => db.end() };
}

// The world's clock starts on Monday 2026-11-02 at 09:00 UTC, and the Workspace is on UTC.
const tomorrow = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 3, h, m));
const today = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 2, h, m));

describe("a Social account's day", () => {
  it("places a step's posts on the wanted day inside the hours, apart by the gap and never on a quarter hour", async () => {
    const w = await world();
    const made = [await w.post(tomorrow(8)), await w.post(tomorrow(8)), await w.post(tomorrow(8))];
    const times = made.map((i) => i.at!);
    for (const t of times) {
      expect(t.getUTCDate()).toBe(3);
      expect(t.getUTCMinutes() % 15).not.toBe(0);
      expect(offPace(t, PACE, "UTC", times.filter((o) => o !== t))).toBeNull();
    }
    expect((await w.reserved("2026-11-03")).length).toBe(3);
    await w.done();
  });

  it("refuses a person's approval or move into today once its budget is spent, naming the day and the budget", async () => {
    const w = await world();
    // A new account's budget is one post a day.
    await w.submit(await w.post(today(12)));
    const second = await w.submit(await w.post(today(15)));
    expect(await w.items.approve(w.W, second.id, second.revision, w.who)).toEqual({ ok: false, reason: "account_day_full", day: "2026-11-02", limit: 1 });
    const third = await w.submit(await w.post(tomorrow(12)));
    expect(await w.items.moveItem(w.W, third.id, today(17), person)).toEqual({ ok: false, reason: "account_day_full", day: "2026-11-02", limit: 1 });
    await w.done();
  });

  it.each([12, 13])("checks the new account when retargeted today at %i:00", async (hour) => {
    const w = await world();
    await w.addAccount("acct-2");
    const post = await w.post(today(12), "exact");
    await w.post(today(15), "exact", "acct-2");
    expect(await w.retarget(post.id, "acct-2", today(hour))).toMatchObject({ ok: true });
    expect(await w.reserved("2026-11-02")).toEqual(expect.arrayContaining([today(12), today(15)]));
    const submitted = await w.submit(post);
    expect(await w.items.approve(w.W, submitted.id, submitted.revision, w.who)).toMatchObject({ ok: false, reason: "account_day_full", limit: 1 });
    await w.done();
  });

  it("reserves an unchanged slot on the new account and frees the old account's place", async () => {
    const w = await world();
    await w.addAccount("acct-2");
    const post = await w.post(today(12), "exact");
    expect(await w.retarget(post.id, "acct-2", today(12))).toMatchObject({ ok: true });
    expect(await w.q("select network_id from social_reservations order by created_at")).toEqual([{ network_id: "acct-1" }, { network_id: "acct-2" }]);
    await w.post(today(15), "exact");
    expect(await w.reserved("2026-11-02")).toEqual(expect.arrayContaining([today(12), today(15)]));
    await w.done();
  });

  it("checks a later day against the most the budget could reach", async () => {
    const w = await world();
    for (let i = 0; i < 5; i++) await w.post(tomorrow(8));
    expect((await w.reserved("2026-11-03")).length).toBe(5);
    const sixth = await w.submit(await w.post(tomorrow(8)));
    expect(await w.items.approve(w.W, sixth.id, sixth.revision, w.who)).toMatchObject({ ok: false, reason: "account_day_full", limit: 5 });
    await w.done();
  });

  it("keeps a person's exact time inside the gap, with one warning", async () => {
    const w = await world();
    await w.post(tomorrow(10), "exact");
    const close = await w.post(tomorrow(10, 20), "exact");
    expect(close.at).toEqual(tomorrow(10, 20));
    expect(close.warnings.map((x) => x.text)).toEqual(["Another post on this account is planned within 60 minutes."]);
    await w.done();
  });

  it("keeps a placed post where it is when a launch moves it by a day", async () => {
    const w = await world();
    const placed = await w.post(tomorrow(8));
    const dayLater = new Date(placed.at!.getTime() + 24 * HOUR);
    expect(await w.items.redateItem(w.W, placed.id, dayLater, person)).toMatchObject({ ok: true });
    expect(await w.reserved("2026-11-04")).toEqual([dayLater]);
    await w.done();
  });

  it("leaves an approved post on its original schedule when the redate day is full", async () => {
    const w = await world();
    await w.post(today(12), "exact");
    const post = await w.submit(await w.post(tomorrow(12), "exact"));
    expect(await w.items.approve(w.W, post.id, post.revision, w.who)).toMatchObject({ ok: true });
    const id = await actionIdOf(w.W, post.id);
    expect(await w.items.redateItem(w.W, post.id, today(14), person)).toEqual({ ok: false, reason: "account_day_full", day: "2026-11-02", limit: 1 });
    expect(await w.items.detail(w.W, post.id)).toMatchObject({ item: { at: tomorrow(12) } });
    expect(await w.ledger.getAction(w.W, id)).toMatchObject({ state: "scheduled", dueAt: tomorrow(12) });
    expect(await w.reserved("2026-11-03")).toEqual([tomorrow(12)]);
    expect(await w.reserved("2026-11-02")).toEqual([today(12)]);
    await w.done();
  });

  it("resumes concurrent late posts at spaced slots after a full day with a two-connection pool", async () => {
    const w = await world();
    const posts = await Promise.all(Array.from({ length: 2 }, async () =>
      w.submit(await w.post(tomorrow(10), "auto", "acct-1", await w.newPerson())),
    ));
    const ids = await Promise.all(posts.map(async (post) => {
      expect(await w.items.approve(w.W, post.id, post.revision, w.who)).toMatchObject({ ok: true });
      return actionIdOf(w.W, post.id);
    }));
    w.clock.at = new Date(tomorrow(13).getTime() + 24 * HOUR);
    await w.post(new Date(w.clock.at.getTime() + HOUR), "exact");
    // This fixture has no publishing effect; start at the late hold the dispatcher would record.
    await w.q("update actions set state = 'held', hold_reason = 'late', next_attempt_at = null where id = any($1::uuid[])", [ids]);
    await closeAuthDb();
    await closeDb();
    vi.stubEnv("DIREX_DB_POOL_MAX", "2");
    try {
      const results = await Promise.all(posts.map((post) => w.items.resume(w.W, post.id, person)));
      expect(results.every((result) => result.ok)).toBe(true);
      const slots = (await w.reserved("2026-11-05")).sort((a, b) => a.getTime() - b.getTime());
      expect(slots).toHaveLength(2);
      expect(offPace(slots[0]!, PACE, "UTC", [slots[1]!])).toBeNull();
      expect(offPace(slots[1]!, PACE, "UTC", [slots[0]!])).toBeNull();
      const touches = await w.q(
        "select distinct on (action_id) slot from touch_reservations where action_id = any($1::uuid[]) order by action_id, created_at desc",
        [ids],
      );
      expect(touches.map((row) => row.slot)).toEqual(expect.arrayContaining(slots));
    } finally {
      vi.unstubAllEnvs();
      await closeAuthDb();
      await closeDb();
      await w.done();
    }
  });

  it("keeps concurrent automatic redates apart on the same account and refuses those past the day's budget", async () => {
    const w = await world();
    const posts = await Promise.all(Array.from({ length: 7 }, () => w.post(tomorrow(8))));
    const wanted = new Date(tomorrow(8).getTime() + 24 * HOUR);
    const results = await Promise.all(posts.map((post) => w.items.redateItem(w.W, post.id, wanted, person)));
    expect(results.filter((result) => result.ok)).toHaveLength(5);
    expect(results.filter((result) => !result.ok)).toEqual(Array(2).fill({ ok: false, reason: "account_day_full", day: "2026-11-04", limit: 5 }));
    const slots = (await w.reserved("2026-11-04")).map((slot) => slot.getTime()).sort((a, b) => a - b);
    expect(slots).toHaveLength(5);
    for (let i = 1; i < slots.length; i++) expect(slots[i]! - slots[i - 1]!).toBeGreaterThanOrEqual(PACE.gapMinutes * 60_000);
    await w.done();
  });

  it("keeps the wanted redating time when no legal slot remains that day", async () => {
    const w = await world();
    const post = await w.post(tomorrow(8));
    const wanted = new Date(tomorrow(21).getTime() + 24 * HOUR);
    expect(await w.items.redateItem(w.W, post.id, wanted, person)).toMatchObject({ ok: true });
    expect(await w.reserved("2026-11-04")).toEqual([wanted]);
    await w.done();
  });

  it("never lets many writers at once land inside the gap or go over the budget", async () => {
    const w = await world();
    await Promise.all(Array.from({ length: 10 }, () => w.post(tomorrow(8))));
    const slots = (await w.reserved("2026-11-03")).map((d) => d.getTime()).sort((a, b) => a - b);
    expect(slots.length).toBe(5);
    for (let i = 1; i < slots.length; i++) expect(slots[i]! - slots[i - 1]!).toBeGreaterThanOrEqual(PACE.gapMinutes * 60_000);
    await w.done();
  });

  it("leaves email to the Mailbox side", async () => {
    const w = await world();
    const e = await w.newTouch(await w.newPerson(), tomorrow(9));
    expect(e.at).toEqual(tomorrow(9));
    await w.done();
  });
});
