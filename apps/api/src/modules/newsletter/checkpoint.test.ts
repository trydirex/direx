// SPDX-License-Identifier: AGPL-3.0-only
// One Kit week end to end on the fakes, through the ledger and checks the worker runs: settings, the
// weekly job, writing, approving, the publish at the slot, the stats after it, and the next week,
// which nobody approves, skipped without Kit hearing of it. beehiiv's read-only path is in handoff.test.ts.
import { expect, test } from "vitest";
import { newsletterWorld, person } from "./fixtures/world";

const w = await newsletterWorld();

test("a Kit issue is made, written, approved, published at its slot and read back; an unapproved one is skipped", async () => {
  const { W } = await w.workspace({ connection: "kit", key: w.kit.key });
  await w.weekly.runOne(W);
  const { id } = await w.latestIssue(W);
  await w.desk.revise(W, id, { title: "Week 45", previewText: "What we shipped", markdown: "We **shipped** the desk." }, person.userId);
  const submitted = await w.desk.submit(W, id, person.userId);
  if (!submitted.ok) throw new Error(submitted.reason);
  expect(await w.items.approve(W, id, submitted.issue.item.revision, w.who)).toMatchObject({ ok: true });

  // Kit only schedules ahead, so it is due five minutes early and the broadcast goes at the slot itself.
  const actionId = (await w.items.actionIdOf(W, id))!;
  expect((await w.ledger.getAction(W, actionId))?.dueAt?.toISOString()).toBe("2026-11-10T07:55:00.000Z");
  w.clock.at = new Date("2026-11-10T07:55:00Z");
  await w.ledger.run(W, actionId);
  expect((await w.ledger.getAction(W, actionId))?.state).toBe("sent");
  const [broadcast] = [...w.kit.broadcasts.values()];
  expect(broadcast).toMatchObject({ subject: "Week 45", status: "scheduled", sendAt: "2026-11-10T08:00:00.000Z" });

  // Kit sends it; an hour later the numbers are read and shown.
  w.kit.complete(broadcast!.id);
  w.clock.at = new Date("2026-11-10T09:00:00Z");
  await w.afterSend.runOne(W);
  expect(await w.desk.get(W, id)).toMatchObject({ sentAt: "2026-11-10T08:00:00.000Z", stats: { recipients: expect.any(Number), clicks: 0, opens: 0 } });

  // The next week's draft appears on Sunday and nobody approves it.
  w.clock.at = new Date("2026-11-15T05:00:00Z");
  await w.weekly.runOne(W);
  const next = await w.latestIssue(W);
  expect(next.id).not.toBe(id);
  w.clock.at = new Date("2026-11-17T08:01:00Z");
  await w.weekly.runOne(W);
  expect((await w.items.view(W, next.id))?.state).toBe("cancelled");
  expect(w.kit.broadcasts.size).toBe(1);
});
