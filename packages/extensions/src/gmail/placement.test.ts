// SPDX-License-Identifier: AGPL-3.0-only
// Placement checks on the receiving side against the fake Gmail, which fails any get of a guarded
// check that could carry its body, snippet or subject. A read finds a check by search and gets its
// labels and Message-ID only; the reply poll and mail.from never fetch one; an archive takes INBOX
// off and nothing else, and never touches a check in spam.
import type { CallContext, SkipMail, TriggerEvent } from "@direx/plugin-sdk";
import { afterEach, expect, test } from "vitest";
import { startFakeGmail, type FakeGmail } from "./fake-gmail";
import { checkQuery } from "./placement";
import { createGmailPlugin } from "./plugin";

const fakes: FakeGmail[] = [];
afterEach(() => fakes.splice(0).forEach((f) => f.stop()));

const AT = Date.parse("2026-11-02T10:00:00Z");
const MEMBER = "kim@circle.test";
const check: SkipMail = { from: MEMBER, subject: "Thursday", notSubject: "ref 0a1b2c3d", after: AT - 10 * 60_000, before: AT + 60 * 60_000 };

function setup() {
  const fake = startFakeGmail();
  fakes.push(fake);
  const plugin = createGmailPlugin({ baseUrl: fake.url, timeoutMs: 2_000, now: () => AT + 2 * 3_600_000 });
  const ctx: CallContext = { workspaceId: "00000000-0000-4000-8000-000000000001", idempotencyKey: "k", credential: { accessToken: fake.token, expiresAt: "" }, log: () => {} };
  const read = (input: unknown) => plugin.queries["placement.read"]!(input, ctx);
  const archive = async (messageId: string) => {
    const a = plugin.effects["placement.archive"]!;
    return a.execute((await a.prepare({ messageId }, ctx)).spec, ctx);
  };
  /** A check from MEMBER, guarded so a body read fails. */
  const deliver = (labelIds: string[], extra: { subject?: string; at?: number } = {}) => {
    const id = fake.deliver({ from: `Kim <${MEMBER}>`, subject: extra.subject ?? "Thursday", text: "Hi, does Thursday morning still work?", labelIds, at: extra.at ?? AT + 60_000 });
    fake.guard(id);
    return id;
  };
  return { fake, plugin, ctx, read, archive, deliver };
}

test("the search names the sender, the subject phrase, the other tag left out and the window in seconds; nothing can widen it", () => {
  expect(checkQuery(check)).toBe(`from:${MEMBER} subject:"Thursday" -subject:"ref 0a1b2c3d" after:${(AT - 600_000) / 1000} before:${(AT + 3_600_000) / 1000}`);
  expect(checkQuery({ ...check, subject: 'a "b" (c) {d}' })).toContain('subject:"a b c d"');
  expect(() => checkQuery({ ...check, from: "kim@circle.test OR from:anyone" })).toThrow("one email address");
  expect(() => checkQuery({ ...check, subject: '"()"' })).toThrow("empty");
});

test("each label set maps to where the check landed, read through labels and the Message-ID only", async () => {
  const cases: [string[], object][] = [
    [["INBOX", "UNREAD"], { inbox: true, spam: false, otherTab: false }],
    [["INBOX", "CATEGORY_PERSONAL"], { inbox: true, spam: false, otherTab: false }],
    [["INBOX", "CATEGORY_PROMOTIONS"], { inbox: true, spam: false, otherTab: true }],
    [["INBOX", "CATEGORY_UPDATES"], { inbox: true, spam: false, otherTab: true }],
    [["SPAM"], { inbox: false, spam: true, otherTab: false }],
    [["CATEGORY_PERSONAL"], { inbox: false, spam: false, otherTab: false }],
  ];
  for (const [labels, where] of cases) {
    const { fake, read, deliver } = setup();
    deliver(labels);
    expect(await read(check)).toEqual({ found: true, messageId: expect.stringMatching(/^<in-\d+@example\.com>$/), ...where });
    expect(fake.bodyReads).toEqual([]);
    // Labels and the one header only: no snippet, no subject, no body ever crossed the wire.
    expect(fake.urls.filter((u) => u.startsWith("GET /messages/"))).toEqual([expect.stringContaining("format=metadata&metadataHeaders=Message-ID&fields=id%2ClabelIds%2Cpayload%2Fheaders")]);
    expect(fake.calls.modify).toBe(0);
  }
});

test("no hit is not found; a check outside its window, from someone else, or carrying the content tag is not this check", async () => {
  const { fake, read } = setup();
  fake.deliver({ from: MEMBER, subject: "Thursday", labelIds: ["INBOX"], at: AT + 2 * 3_600_000 });
  fake.deliver({ from: "lee@circle.test", subject: "Thursday", labelIds: ["INBOX"], at: AT });
  fake.deliver({ from: MEMBER, subject: "Thursday plans (ref 0a1b2c3d)", labelIds: ["INBOX"], at: AT });
  expect(await read(check)).toEqual({ found: false });
});

test("a Gmail error is an error, never a check that went missing", async () => {
  const { fake, read } = setup();
  fake.failNext("list", 500);
  await expect(read(check)).rejects.toThrow("Gmail 500");
  await expect(read({ ...check, from: "not an address" })).rejects.toThrow();
});

test("the reply poll and mail.from never fetch an expected check, and still read everything else", async () => {
  const { fake, plugin, ctx, deliver } = setup();
  const probe = deliver(["INBOX", "UNREAD"]);
  const reply = fake.deliver({ from: MEMBER, subject: "Re: invoice", text: "A real reply", labelIds: ["INBOX"], at: AT });
  const poll = (cursor: string | null) => plugin.triggers["email.received"]!.poll!(cursor, { ...ctx, skip: [check] });
  const first = await poll(null);
  expect(first.events.map((e: TriggerEvent) => e.eventId)).toEqual([reply]);
  // Arriving between polls, through history.
  const later = deliver(["INBOX"], { at: AT + 2 * 60_000 });
  const other = fake.deliver({ from: "lee@example.com", subject: "Thursday", text: "Not a check", at: AT });
  expect((await poll(first.cursor)).events.map((e: TriggerEvent) => e.eventId)).toEqual([other]);
  const from = (await plugin.queries["mail.from"]!({ email: MEMBER, skip: [check] }, ctx)) as { events: TriggerEvent[] };
  expect(from.events.map((e) => e.eventId)).toEqual([reply]);
  expect(fake.bodyReads).toEqual([]);
  expect([probe, later].every((id) => !fake.urls.some((u) => u.startsWith(`GET /messages/${id}`)))).toBe(true);
  await expect(plugin.queries["mail.from"]!({ email: MEMBER, skip: [{ from: MEMBER }] }, ctx)).rejects.toThrow("skip list");
});

test("without a skip list the poll would have fetched the check in full, which the guard refuses", async () => {
  const { plugin, ctx, deliver } = setup();
  deliver(["INBOX"]);
  await expect(plugin.triggers["email.received"]!.poll!(null, ctx)).rejects.toThrow("Gmail 403");
});

test("an archive takes INBOX off a check in the inbox once, never adds a label, and never touches one in spam", async () => {
  const { fake, archive, deliver } = setup();
  const inbox = deliver(["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"]);
  const spam = deliver(["SPAM", "UNREAD"]);
  // The fake numbers Message-IDs in delivery order.
  expect(await archive("<in-1@example.com>")).toEqual({ kind: "sent", providerRef: inbox });
  expect(fake.labelsOf(inbox)).toEqual(["UNREAD", "CATEGORY_PROMOTIONS"]);
  // Again: already out of the inbox, nothing more to change.
  expect(await archive("<in-1@example.com>")).toEqual({ kind: "sent", providerRef: inbox });
  expect(await archive("<in-2@example.com>")).toMatchObject({ kind: "refused", permanent: true, detail: expect.stringContaining("spam") });
  expect(fake.labelsOf(spam)).toEqual(["SPAM", "UNREAD"]);
  expect(await archive("<gone@example.com>")).toMatchObject({ kind: "refused", permanent: true });
  expect(fake.modifies).toEqual([{ id: inbox, add: [], remove: ["INBOX"], before: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"] }]);
  expect(fake.bodyReads).toEqual([]);
});

test("an archive spec is one Message-ID and nothing that could widen the search", async () => {
  const { plugin, ctx } = setup();
  const a = plugin.effects["placement.archive"]!;
  await expect(a.prepare({ messageId: "<x@y> OR in:anywhere" }, ctx)).rejects.toThrow();
  await expect(a.prepare({ messageId: "<x@y>", addLabelIds: ["INBOX"] }, ctx)).rejects.toThrow();
  expect(await a.execute({ messageId: "x@y" }, ctx)).toMatchObject({ kind: "refused", permanent: true });
});
