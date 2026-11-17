// SPDX-License-Identifier: AGPL-3.0-only
// Lost wakes: an overdue Action is woken again, across Workspaces, through a function that returns only ids.
import { expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { fakeEffect, scheduledAction, testLedger } from "./test-effects";

const CAP = "test.sweep";
const fake = fakeEffect("blind");
const { boss, clock, ledger } = await testLedger({ effects: { [CAP]: fake.capability }, now: () => clock.at });
const W1 = crypto.randomUUID();
const W2 = crypto.randomUUID();

test("an approved Action whose wake never came is found and woken; one not yet due is left alone", async () => {
  clock.at = new Date(Date.now() - 3_600_000);
  const stranded = await scheduledAction(ledger, W1, CAP, "blind");
  const other = await scheduledAction(ledger, W2, CAP, "blind");
  clock.at = new Date(Date.now() + 3_600_000);
  const future = await scheduledAction(ledger, W1, CAP, "blind");
  const wakes = async (id: string) => (await boss.findJobs("ledger.dispatch", { data: { actionId: id } })).length;
  const before = [await wakes(stranded), await wakes(other), await wakes(future)];
  expect(await ledger.sweep()).toBeGreaterThanOrEqual(2);
  expect([await wakes(stranded), await wakes(other), await wakes(future)]).toEqual([before[0]! + 1, before[1]! + 1, before[2]!]);
  // The wake alone does the work: nothing else moved the row.
  clock.at = new Date();
  await ledger.run(W1, stranded);
  expect((await ledger.getAction(W1, stranded))!.state).toBe("sent");
});

test("outside a Workspace the app sees no Action; the sweep function returns ids and nothing else", async () => {
  const c = await appClient();
  try {
    expect((await c.query("select * from actions")).rows).toEqual([]);
    await expect(c.query("select * from system.system_audit")).rejects.toThrow(/permission denied/);
    const { rows } = await c.query("select * from system.overdue_actions(1)");
    expect(Object.keys(rows[0] ?? { workspace_id: 1, action_id: 1 }).sort()).toEqual(["action_id", "workspace_id"]);
  } finally {
    await c.end();
  }
});
