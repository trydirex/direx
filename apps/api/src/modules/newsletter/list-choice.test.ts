// SPDX-License-Identifier: AGPL-3.0-only
// A tool whose account holds several lists: no issue until one is chosen, the approved spec names the
// list, an edit keeps it, and choosing another later changes only the next issue.
import { expect, test } from "vitest";
import { createVault, credentialLabel, rootKeyFromEnv } from "../credentials/index";
import { itemsWorld, person, POST } from "../items/fixtures/items";
import { createNewsletter, issueDesk, newsletterKinds, newsletterWeekly } from "./index";

const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });
const { W, items, clock } = await itemsWorld({ kinds: newsletterKinds(), resolvers: { credential: credentialLabel } });
const LISTS = { "api-many": [{ id: "a1", name: "Founders", subscriberCount: 340 }, { id: "b2", name: "Customers", subscriberCount: 1200 }], "api-one": [{ id: "c3", name: "Weekly", subscriberCount: 80 }] };
const keyOf = new Map<string, keyof typeof LISTS | "api-down">();
const newsletter = createNewsletter({
  credentials: (ws) => vault.list(ws),
  lists: () => ["mailchimp", "kit"],
  hasLists: (c) => c === "mailchimp",
  listsOf: async (_ws, credentialId) => {
    const key = keyOf.get(credentialId);
    if (key === "api-down") throw new Error("Mailchimp answered 503");
    return LISTS[key!];
  },
  setMeta: (ws, id, name, value) => vault.setMeta(ws, id, name, value),
});
const weekly = newsletterWeekly({
  items: () => items,
  lists: () => [
    { connection: "mailchimp", name: "Mailchimp", lists: "com.example.mailchimp/newsletter.lists", publish: POST, publishDedupe: "queryable", publishLeadMs: 0 },
    { connection: "kit", name: "Kit", lists: null, publish: POST, publishDedupe: "queryable", publishLeadMs: 0 },
  ],
  credentials: (ws) => vault.list(ws),
  now: () => clock.at,
});
const desk = issueDesk({ items: () => items });

async function key(connection: string, as: keyof typeof LISTS | "api-down") {
  const made = await vault.create({ workspaceId: W, actorUserId: person.userId, scope: "workspace", kind: "api_key", key: `api_key:${connection}:${as}`, connection, name: connection, meta: {}, value: { key: as } });
  if (!made.ok) throw new Error(made.reason);
  keyOf.set(made.credential.id, as);
  return made.credential.id;
}
const settings = (credentialId: string) => ({ list: "connected" as const, credentialId, weekday: 2, sendTime: "09:00", timeZone: "Europe/Berlin", enabled: true });
const issueItems = async () => (await items.list(W, { offset: 0, limit: 50 })).items.filter((i) => i.workArea === "newsletter");
const specOf = async (itemId: string) => (await items.detail(W, itemId))!.content as Record<string, unknown>;

const many = await key("mailchimp", "api-many");
const kit = await key("kit", "api-many");
const down = await key("mailchimp", "api-down");

test("an account with several lists gets no issue until one is chosen", async () => {
  expect(await newsletter.saveSettings(W, settings(many))).toMatchObject({ ok: true });
  expect((await newsletter.page(W)).platforms).toEqual([
    { connection: "mailchimp", name: "mailchimp", credentialId: many, hasLists: true, listId: null, listName: null },
    { connection: "kit", name: "kit", credentialId: kit, hasLists: false, listId: null, listName: null },
  ]);
  clock.at = new Date("2026-11-08T05:00:00Z"); // Sunday 06:00 in Berlin, the draft day for Tuesday 09:00
  await weekly.runOne(W);
  expect(await issueItems()).toHaveLength(0);
});

test("only a list the tool names can be chosen, and only on a key whose account holds several", async () => {
  expect(await newsletter.lists(W, many)).toEqual({ ok: true, lists: LISTS["api-many"] });
  expect(await newsletter.chooseList(W, many, "zz9")).toEqual({ ok: false, reason: "not_listed" });
  expect(await newsletter.chooseList(W, kit, "a1")).toEqual({ ok: false, reason: "no_lists" });
  expect(await newsletter.chooseList(W, crypto.randomUUID(), "a1")).toEqual({ ok: false, reason: "list_not_connected" });
  expect(await newsletter.lists(W, down)).toEqual({ ok: false, reason: "tool_unreachable" });
});

test("the chosen list goes into the issue's spec and title, and an edit keeps it", async () => {
  expect(await newsletter.chooseList(W, many, "a1")).toEqual({ ok: true, list: LISTS["api-many"][0] });
  expect((await newsletter.page(W)).platforms[0]).toMatchObject({ listId: "a1", listName: "Founders" });
  await weekly.runOne(W);
  const [issue] = await issueItems();
  expect(issue!.title).toBe("Newsletter issue for Tuesday 09:00, to Founders");
  expect(await specOf(issue!.id)).toMatchObject({ listId: "a1", audience: { kind: "newsletter_list", credentialId: many, listId: "a1", listName: "Founders" } });

  // Choosing another list later leaves this issue where it was approved to go.
  expect(await newsletter.chooseList(W, many, "b2")).toMatchObject({ ok: true });
  expect(await desk.revise(W, issue!.id, { title: "Week 45", markdown: "Hello." }, person.userId)).toMatchObject({ ok: true });
  expect(await specOf(issue!.id)).toMatchObject({ listId: "a1", audience: { listId: "a1" } });
});

test("an account with one list has it chosen when the settings are saved", async () => {
  const one = await key("mailchimp", "api-one");
  expect(await newsletter.saveSettings(W, settings(one))).toMatchObject({ ok: true });
  expect((await vault.list(W)).find((c) => c.id === one)?.meta).toEqual({ listId: "c3", listName: "Weekly" });
});

test("a tool with one list per account names none in its issue", async () => {
  expect(await newsletter.saveSettings(W, settings(kit))).toMatchObject({ ok: true });
  clock.at = new Date("2026-11-15T05:00:00Z"); // the next Sunday
  await weekly.runOne(W);
  const plain = (await issueItems()).find((i) => i.title === "Newsletter issue for Tuesday 09:00")!;
  const spec = await specOf(plain.id);
  expect(spec.listId).toBeUndefined();
  expect(spec.audience).toEqual({ kind: "newsletter_list", credentialId: kit });
});
