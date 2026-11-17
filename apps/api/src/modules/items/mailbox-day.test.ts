// SPDX-License-Identifier: AGPL-3.0-only
// A person's approval or move that would put a Mailbox's day over its limit is refused, naming the
// day and the limit; a move to a day with room goes through, and approving there works.
import { expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createVault, credentialLabel, rootKeyFromEnv } from "../credentials/index";
import { itemsWorld, person } from "./fixtures/items";

const SEND = "com.trydirex.gmail/email.send";

test("approving or moving into a Mailbox's full day is refused with the day and the limit; a day with room takes it", async () => {
  const { W, items, who, clock, submit } = await itemsWorld({ resolvers: { credential: credentialLabel } });
  const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });
  const made = await vault.create({ workspaceId: W, actorUserId: person.userId, scope: "workspace", kind: "api_key", key: "me@acme.test", name: "me@acme.test", meta: {}, value: { key: "x" } });
  if (!made.ok) throw new Error(made.reason);
  const mailbox = made.credential.id;
  const c = await appClient();
  await c.query("begin");
  await c.query("select set_config('app.workspace_id', $1, true)", [W]);
  // One a day.
  await c.query("update credentials set connection = 'imap_smtp', daily_limit = 1 where id = $1", [mailbox]);
  await c.query("commit");
  await c.end();

  const email = async (plannedAt: Date) =>
    submit(await items.createActionItem(W, { idempotencyKey: crypto.randomUUID(), capability: SEND, dedupe: "blind", spec: { to: "dana@example.com" }, credentialId: mailbox, actor: person, details: { title: "An email", channel: "email", warnings: [], plannedAt } }));
  // The clock is Monday 2 Nov 09:00 UTC.
  const tue = new Date("2026-11-03T10:00:00Z");
  const wed = new Date("2026-11-04T10:00:00Z");
  const first = await email(tue);
  const second = await email(new Date("2026-11-03T11:00:00Z"));

  // The first holds Tuesday's place; the second was planned there too, and can't be approved there.
  expect((await items.approve(W, first.id, first.revision, who)).ok).toBe(true);
  expect(await items.approve(W, second.id, second.revision, who)).toEqual({ ok: false, reason: "mailbox_day_full", day: "2026-11-03", limit: 1 });

  // A person moving it into Tuesday is refused the same way; Wednesday has room.
  expect(await items.moveItem(W, second.id, new Date("2026-11-03T15:00:00Z"), person)).toEqual({ ok: false, reason: "mailbox_day_full", day: "2026-11-03", limit: 1 });
  const moved = await items.moveItem(W, second.id, wed, person);
  expect(moved.ok).toBe(true);
  expect((await items.approve(W, second.id, moved.ok ? moved.item.revision : 0, who)).ok).toBe(true);
});
