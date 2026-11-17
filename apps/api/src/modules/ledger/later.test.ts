// SPDX-License-Identifier: AGPL-3.0-only
// A check that says "later, not now" moves an approved Action on without a person: it stays scheduled
// with its approval, wakes at the new time, sends nothing now, and the hook hears of it after commit.
import { expect, test } from "vitest";
import type { CheckResult } from "./index";
import { fakeEffect, scheduledAction, testLedger } from "./test-effects";

const W = crypto.randomUUID();
const LATER = new Date("2026-11-03T09:00:00Z");

test("a later result keeps the approval, moves the time, sends nothing now, and tells the hook", async () => {
  const effect = fakeEffect("blind");
  let verdict: CheckResult = { kind: "later", reason: "mailbox_day_full", at: LATER };
  const moved: [string, Date][] = [];
  const { ledger, clock, wakes } = await testLedger({
    effects: { "test.email": effect.capability },
    checks: [async () => verdict],
    onLater: async (_w, actionId, at) => {
      moved.push([actionId, at]);
    },
  });
  const id = await scheduledAction(ledger, W, "test.email", "blind");
  await ledger.run(W, id);
  expect(effect.calls).toHaveLength(0);
  expect(await ledger.getAction(W, id)).toMatchObject({ state: "scheduled", dueAt: LATER });
  expect(moved).toEqual([[id, LATER]]);
  expect((await wakes(id)).map((d) => d.getTime())).toContain(LATER.getTime());
  // At the new time, with room, it sends on the same approval.
  verdict = { kind: "ok" };
  clock.at = LATER;
  await ledger.run(W, id);
  expect(effect.calls).toHaveLength(1);
  expect(await ledger.getAction(W, id)).toMatchObject({ state: "sent" });
});
