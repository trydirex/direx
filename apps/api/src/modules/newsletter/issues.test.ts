// SPDX-License-Identifier: AGPL-3.0-only
// Writing an Issue: an edit re-renders the HTML into the spec and voids any approval, approving sets
// the send time to the slot, and a slot already gone can't be approved.
import { expect, test } from "vitest";
import { createVault, credentialLabel, rootKeyFromEnv } from "../credentials/index";
import { itemsWorld, person, POST } from "../items/fixtures/items";
import { createNewsletter, issueDesk, newsletterKinds, newsletterWeekly } from "./index";

const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });
const { W, items, clock, ledger, who } = await itemsWorld({ kinds: newsletterKinds(), resolvers: { credential: credentialLabel } });
const weekly = newsletterWeekly({ items: () => items, lists: () => [{ connection: "kit", name: "Kit", publish: POST, publishDedupe: "blind", publishLeadMs: 0 }], credentials: (ws) => vault.list(ws), now: () => clock.at });
const desk = issueDesk({ items: () => items });

const made = await vault.create({ workspaceId: W, actorUserId: person.userId, scope: "workspace", kind: "api_key", key: "api_key:kit", connection: "kit", name: "Kit", meta: {}, value: { key: "x" } });
if (!made.ok) throw new Error(made.reason);
const saved = await createNewsletter({ credentials: (ws) => vault.list(ws), lists: () => ["kit"] }).saveSettings(W, { list: "connected", credentialId: made.credential.id, weekday: 2, sendTime: "09:00", timeZone: "Europe/Berlin", enabled: true });
if (!saved.ok) throw new Error(saved.reason);

clock.at = new Date("2026-11-08T05:00:00Z"); // Sunday 06:00 in Berlin, the draft day for Tuesday 09:00
await weekly.runOne(W);
const { id } = (await items.list(W, { offset: 0, limit: 10 })).items.find((i) => i.workArea === "newsletter")!;
const SLOT = "2026-11-10T08:00:00.000Z";
const actionOf = async () => ledger.getAction(W, (await items.actionIdOf(W, id))!);

test("an empty issue can't be sent for approval", async () => {
  expect(await desk.submit(W, id, person.userId)).toEqual({ ok: false, reason: "issue_empty" });
  expect(await desk.get(W, crypto.randomUUID())).toBeNull();
});

test("an edit renders the Markdown into the spec and keeps the slot and list", async () => {
  const r = await desk.revise(W, id, { title: "Week 45", previewText: "  ", markdown: "## News\n\nWe **shipped** it. <script>x</script>" }, person.userId);
  expect(r).toMatchObject({ ok: true, issue: { title: "Week 45", previewText: "", slot: SLOT, item: { title: "Week 45" } } });
  if (!r.ok) return;
  expect(r.issue.html).toContain("<strong>shipped</strong>");
  expect(r.issue.html).toContain("&lt;script&gt;");
  expect((await actionOf())?.spec).toEqual({ title: "Week 45", html: r.issue.html, markdown: "## News\n\nWe **shipped** it. <script>x</script>", at: SLOT, audience: { kind: "newsletter_list", credentialId: made.credential.id } });
});

test("approving sets the send time to the slot, and an edit voids the approval", async () => {
  const submitted = await desk.submit(W, id, person.userId);
  if (!submitted.ok) throw new Error(submitted.reason);
  const approved = await items.approve(W, id, submitted.issue.item.revision, who);
  expect(approved).toMatchObject({ ok: true, item: { state: "scheduled" } });
  expect((await actionOf())?.dueAt?.toISOString()).toBe(SLOT);

  await desk.revise(W, id, { title: "Week 45, fixed", markdown: "Better." }, person.userId);
  expect((await desk.get(W, id))?.item.state).not.toBe("scheduled");
});

test("a slot already gone can't be approved", async () => {
  const again = await desk.submit(W, id, person.userId);
  const revision = again.ok ? again.issue.item.revision : (await desk.get(W, id))!.item.revision;
  clock.at = new Date("2026-11-10T08:00:01Z");
  expect(await items.approve(W, id, revision, who)).toEqual({ ok: false, reason: "slot_in_past" });
});

test("the issue list pages newest slot first, with the Item's title and state", async () => {
  clock.at = new Date("2026-11-15T05:00:00Z"); // the draft day for Tuesday 17 November
  await weekly.runOne(W);
  const first = await desk.list(W, null, 1);
  expect(first.issues).toMatchObject([{ slot: "2026-11-17T08:00:00.000Z", state: "draft", sentAt: null, stats: null }]);
  expect(first.next).toBe("2026-11-17T08:00:00.000Z");
  const second = await desk.list(W, new Date(first.next!), 1);
  expect(second).toMatchObject({ issues: [{ itemId: id, slot: SLOT, title: "Week 45, fixed" }], next: null });
  expect((await desk.list(crypto.randomUUID(), null, 10)).issues).toEqual([]);
});
