// SPDX-License-Identifier: AGPL-3.0-only
// The weekly job: the draft appears two days before the slot, once, and an issue nobody approved by
// the slot is cancelled with a notice instead of going out.
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createVault, rootKeyFromEnv } from "../credentials/index";
import { itemsWorld, person, POST } from "../items/fixtures/items";
import { seedMember } from "../identity/fixtures/member";
import { createNewsletter, newsletterKinds, newsletterWeekly, SKIPPED_KIND } from "./index";

const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });
const w = await itemsWorld({ kinds: newsletterKinds() });
const { W, items, clock } = w;
const newsletter = createNewsletter({ credentials: (ws) => vault.list(ws), lists: () => ["kit"] });
const weekly = newsletterWeekly({ items: () => items, lists: () => [{ connection: "kit", name: "Kit", publish: POST, publishDedupe: "blind", publishLeadMs: 0 }], credentials: (ws) => vault.list(ws), now: () => clock.at });

const db = await appClient();
afterAll(() => db.end());
async function rows(ws: string, sql: string) {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [ws]);
  const r = await db.query(sql);
  await db.query("commit");
  return r.rows;
}
async function listOn(ws: string, enabled = true) {
  const made = await vault.create({ workspaceId: ws, actorUserId: person.userId, scope: "workspace", kind: "api_key", key: "api_key:kit", connection: "kit", name: "Kit", meta: {}, value: { key: "x" } });
  if (!made.ok) throw new Error(made.reason);
  // Tuesday 09:00 in Berlin, which is 08:00 UTC in November.
  const r = await newsletter.saveSettings(ws, { list: "connected", credentialId: made.credential.id, weekday: 2, sendTime: "09:00", timeZone: "Europe/Berlin", enabled });
  if (!r.ok) throw new Error(r.reason);
}
await listOn(W);
const issues = () => rows(W, "select item_id, slot from newsletter_issues order by slot");

test("the draft appears two days before the slot at 06:00 local, once", async () => {
  clock.at = new Date("2026-11-08T04:59:00Z"); // Sunday 05:59 in Berlin
  await weekly.runOne(W);
  expect(await issues()).toHaveLength(0);

  clock.at = new Date("2026-11-08T05:00:00Z"); // Sunday 06:00 in Berlin
  await weekly.runOne(W);
  await weekly.runOne(W);
  const made = await issues();
  expect(made).toHaveLength(1);
  expect(new Date(made[0].slot).toISOString()).toBe("2026-11-10T08:00:00.000Z");
  const item = await items.view(W, made[0].item_id);
  expect(item).toMatchObject({ state: "draft", workArea: "newsletter", title: "Newsletter issue for Tuesday 09:00", warnings: [] });
  const [{ spec }] = await rows(W, `select a.spec from actions a join items i on i.action_id = a.id where i.id = '${made[0].item_id}'`);
  expect(spec).toEqual({ title: "", html: "", at: "2026-11-10T08:00:00.000Z", audience: { kind: "newsletter_list", credentialId: expect.any(String) } });
});

test("past the slot, an unapproved issue is cancelled and a notice says so, once; nothing is sent", async () => {
  const [issue] = await issues();
  await items.submitItem(W, issue.item_id, person);
  clock.at = new Date("2026-11-10T08:01:00Z");
  await weekly.runOne(W);
  await weekly.runOne(W);
  expect((await items.view(W, issue.item_id))?.state).toBe("cancelled");
  const notices = await rows(W, `select warnings from items where kind = '${SKIPPED_KIND}'`);
  expect(notices).toEqual([{ warnings: [{ code: "unspecified", text: "This week's issue was skipped: nobody approved it before Tuesday 09:00." }] }]);
  expect(w.post.calls).toHaveLength(0);
  // Next week's draft isn't due until Sunday.
  expect(await issues()).toHaveLength(1);
});

test("an issue after a long quiet spell says so", async () => {
  await rows(W, "update newsletter_settings set last_sent_at = '2026-10-01T08:00:00Z'");
  clock.at = new Date("2026-11-15T05:00:00Z");
  await weekly.runOne(W);
  const [, next] = await issues();
  expect((await items.view(W, next.item_id))?.warnings).toEqual([expect.objectContaining({ code: "unspecified", text: expect.stringContaining("More than 31 days") })]);
});

test("settings off makes nothing", async () => {
  const off = crypto.randomUUID();
  await seedMember(off, person.userId);
  await listOn(off, false);
  clock.at = new Date("2026-11-08T05:00:00Z");
  await weekly.runOne(off);
  expect(await rows(off, "select 1 from newsletter_issues")).toHaveLength(0);
});
