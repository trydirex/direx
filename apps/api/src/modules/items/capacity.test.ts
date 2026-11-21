// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";
import { mailboxCapacity, type CapacityPort, type PlaceTarget } from "./application/capacity";
import { itemsWorld, person, POST } from "./fixtures/items";

const OFF_PACE = { code: "unspecified" as const, text: "Off pace." };

/** A port that moves automatic times 7 minutes later, warns on exact ones, and records what it was asked. */
function spyPort() {
  const placed: PlaceTarget[] = [];
  const reserved: { actionId: string; slot: Date }[] = [];
  const port: CapacityPort = {
    ...mailboxCapacity,
    placeIn: async (_tx, _workspaceId, t) => {
      placed.push(t);
      return t.mode === "auto" ? { at: new Date(t.wanted.getTime() + 7 * 60_000) } : { at: t.wanted, warning: OFF_PACE };
    },
    reserveIn: async (tx, workspaceId, actionId, slot, now) => {
      reserved.push({ actionId, slot });
      return mailboxCapacity.reserveIn(tx, workspaceId, actionId, slot, now);
    },
  };
  return { port, placed, reserved };
}

describe("the capacity port", () => {
  it("keeps a time given without a placement, and only reserves it", async () => {
    const spy = spyPort();
    const { newPost, hours } = await itemsWorld({ capacity: spy.port });
    const i = await newPost({ plannedAt: hours(2) });
    expect(i.at).toEqual(hours(2));
    expect(spy.placed).toEqual([]);
    expect(spy.reserved.map((r) => r.slot)).toEqual([hours(2)]);
  });

  it("sets and reserves the time an automatic placement returns, seeded by the idempotency key", async () => {
    const spy = spyPort();
    const { items, W, hours } = await itemsWorld({ capacity: spy.port });
    const key = crypto.randomUUID();
    const i = await items.createActionItem(W, { idempotencyKey: key, capability: POST, dedupe: "blind", spec: { body: "hi" }, actor: person, placement: "auto", details: { title: "A post", channel: "post", warnings: [], plannedAt: hours(2) } });
    const moved = new Date(hours(2).getTime() + 7 * 60_000);
    expect(i.at).toEqual(moved);
    expect(spy.placed[0]).toMatchObject({ seed: key, mode: "auto", capability: POST, wanted: hours(2) });
    expect(spy.reserved.map((r) => r.slot)).toEqual([moved]);
  });

  it("keeps an exact time and adds the port's warning", async () => {
    const spy = spyPort();
    const { items, W, hours } = await itemsWorld({ capacity: spy.port });
    const i = await items.createActionItem(W, { idempotencyKey: crypto.randomUUID(), capability: POST, dedupe: "blind", spec: { body: "hi" }, actor: person, placement: "exact", details: { title: "A post", channel: "post", warnings: [], plannedAt: hours(2) } });
    expect(i.at).toEqual(hours(2));
    expect(i.warnings).toEqual([OFF_PACE]);
  });

  it("places a revision again, leaving its own Action out, and reserves the new time", async () => {
    const spy = spyPort();
    const { items, W, hours, newPost } = await itemsWorld({ capacity: spy.port });
    const i = await newPost({ plannedAt: hours(2) });
    const r = await items.reviseActionItem(W, i.id, { spec: { body: "new" }, actor: person, placement: "auto", details: { warnings: [], plannedAt: hours(5) } });
    expect(r.ok).toBe(true);
    const moved = new Date(hours(5).getTime() + 7 * 60_000);
    expect(spy.placed.at(-1)).toMatchObject({ mode: "auto", wanted: hours(5) });
    expect(spy.placed.at(-1)?.exceptActionId).toBeTruthy();
    expect(spy.reserved.at(-1)?.slot).toEqual(moved);
    if (r.ok) expect(r.item.at).toEqual(moved);
  });

  it("leaves a revision without a placement unplaced and unreserved, as email revisions are", async () => {
    const spy = spyPort();
    const { items, W, hours, newPost } = await itemsWorld({ capacity: spy.port });
    const i = await newPost({ plannedAt: hours(2) });
    await items.reviseActionItem(W, i.id, { spec: { body: "new" }, actor: person, details: { warnings: [] } });
    expect(spy.placed).toEqual([]);
    expect(spy.reserved).toHaveLength(1);
  });
});
