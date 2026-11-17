// SPDX-License-Identifier: AGPL-3.0-only
// Reading replies against the fake Gmail: full reads, history reads, text and bounces.
import type { CallContext, TriggerEvent } from "@direx/plugin-sdk";
import { afterEach, expect, test } from "vitest";
import { startFakeGmail, type FakeGmail } from "./fake-gmail";
import { FULL_READ_EVERY_MS, TEXT_CHARS } from "./history";
import { createGmailPlugin } from "./plugin";

const fakes: FakeGmail[] = [];
afterEach(() => fakes.splice(0).forEach((f) => f.stop()));

function setup(opts: Parameters<typeof startFakeGmail>[0] = {}) {
  const fake = startFakeGmail(opts);
  fakes.push(fake);
  const clock = { now: Date.parse("2026-11-02T09:00:00Z") };
  const plugin = createGmailPlugin({ baseUrl: fake.url, timeoutMs: 2_000, now: () => clock.now });
  const ctx: CallContext = {
    workspaceId: "00000000-0000-4000-8000-000000000001",
    idempotencyKey: "",
    credential: { accessToken: fake.token, expiresAt: "" },
    log: () => {},
  };
  const poll = (cursor: string | null) => plugin.triggers["email.received"]!.poll!(cursor, ctx);
  return { fake, clock, poll, ctx, plugin };
}

type Data = {
  gmailId: string;
  text: string;
  bounce: boolean;
  autoSubmitted: string;
  dsn: { recipients: { email: string; status: string | null }[] } | null;
  headers: { subject: string; from: string };
};
const ids = (events: TriggerEvent[]) => events.map((e) => e.eventId);
const data = (e: TriggerEvent) => e.data as Data;

test("the first poll reads the last week in full; later polls read history and move the cursor", async () => {
  const { fake, clock, poll } = setup();
  const a = fake.deliver({ from: "kim@example.com", subject: "Re: hello", text: "Sounds good" });
  fake.deliver({ from: "dana@example.com", subject: "mine", labelIds: ["SENT"] });
  const first = await poll(null);
  expect(ids(first.events)).toEqual([a]);
  expect(JSON.parse(first.cursor)).toEqual({ historyId: "1002", fullReadAt: clock.now });

  const lists = fake.calls.list;
  const b = fake.deliver({ from: "lee@example.com", subject: "Re: hello", text: "Not now" });
  const archived = fake.deliver({ from: "sam@example.com", subject: "Re: older", text: "Late reply", labelIds: ["CATEGORY_PERSONAL"] });
  fake.moveToInbox(archived);
  fake.deliver({ from: "x@example.com", subject: "draft", labelIds: ["DRAFT"] });
  fake.deliver({ from: "spam@example.com", subject: "win", labelIds: ["INBOX", "SPAM"] });
  fake.deliver({ from: "y@example.com", subject: "trash", labelIds: ["TRASH"] });
  fake.deliver({ from: "dana@example.com", subject: "sent by us", labelIds: ["SENT", "INBOX"] });
  clock.now += 60_000;
  const second = await poll(first.cursor);
  expect(ids(second.events)).toEqual([b, archived]);
  expect(fake.calls.list).toBe(lists);
  expect(JSON.parse(second.cursor)).toEqual({ historyId: "1009", fullReadAt: Date.parse("2026-11-02T09:00:00Z") });

  const third = await poll(second.cursor);
  expect(third.events).toEqual([]);
});

test("a lost history marker or a day since the last full read makes the next poll a full read", async () => {
  const { fake, clock, poll } = setup();
  const a = fake.deliver({ from: "kim@example.com", subject: "Re: hi", text: "yes" });
  const first = await poll(null);
  const b = fake.deliver({ from: "lee@example.com", subject: "Re: hi", text: "later" });
  fake.expireHistory();
  const lists = fake.calls.list;
  const again = await poll(first.cursor);
  expect(fake.calls.list).toBe(lists + 1);
  expect(ids(again.events)).toEqual([b, a]);

  const quiet = await poll(again.cursor);
  expect(quiet.events).toEqual([]);
  clock.now += FULL_READ_EVERY_MS;
  const daily = await poll(quiet.cursor);
  expect(ids(daily.events)).toEqual([b, a]);
  expect(JSON.parse(daily.cursor).fullReadAt).toBe(clock.now);
});

test("a history read over 40 pages fails the poll instead of returning part of it", async () => {
  const { fake, poll } = setup({ pageSize: 1 });
  const first = await poll(null);
  fake.padHistory(41);
  await expect(poll(first.cursor)).rejects.toThrow(/more than 40 pages; refusing a partial read/);
});

test("text is the plain part, else stripped HTML, else the snippet, capped and decoded safely", async () => {
  const { fake, poll } = setup();
  const plain = fake.deliver({ from: "a@example.com", subject: "1", text: "plain wins", html: "<p>html loses</p>" });
  const html = fake.deliver({ from: "b@example.com", subject: "2", html: "<style>p{}</style><p>Hello <b>there</b></p>" });
  const snippet = fake.deliver({ from: "c@example.com", subject: "3", snippet: "only a snippet" });
  const long = fake.deliver({ from: "d@example.com", subject: "4", text: "x".repeat(TEXT_CHARS + 1000) });
  const odd = fake.deliver({ from: "e@example.com", subject: "5", textBytes: Buffer.from("Grüße"), charset: "utf-7" });
  const latin = fake.deliver({ from: "f@example.com", subject: "6", textBytes: Buffer.from("Café", "latin1"), charset: "iso-8859-1" });
  const attached = fake.deliver({ from: "g@example.com", subject: "7", text: "see attached", attachment: true });
  const { events } = await poll(null);
  const text = (id: string) => data(events.find((e) => e.eventId === id)!).text;
  expect(text(plain)).toBe("plain wins");
  expect(text(html)).toBe("Hello there");
  expect(text(snippet)).toBe("only a snippet");
  expect(text(long)).toHaveLength(TEXT_CHARS);
  expect(text(odd)).toBe("Grüße");
  expect(text(latin)).toBe("Café");
  expect(text(attached)).toBe("see attached");
  expect(fake.calls.get).toBe(7);
});

test("mail from a mailer daemon or with a delivery-failure subject is flagged as a bounce", async () => {
  const { fake, poll } = setup();
  const daemon = fake.deliver({ from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)", text: "x" });
  const undeliverable = fake.deliver({ from: "postmaster@acme.example", subject: "Undeliverable: Hello", text: "x" });
  const reply = fake.deliver({ from: "kim@example.com", subject: "Re: Hello", text: "Thanks" });
  const { events } = await poll(null);
  const bounce = (id: string) => data(events.find((e) => e.eventId === id)!).bounce;
  expect([bounce(daemon), bounce(undeliverable), bounce(reply)]).toEqual([true, true, false]);
  expect(data(events.find((e) => e.eventId === reply)!).headers).toMatchObject({ from: "kim@example.com", subject: "Re: Hello" });
});

test("polling without a credential fails the poll", async () => {
  const { plugin, ctx } = setup();
  await expect(plugin.triggers["email.received"]!.poll!(null, { ...ctx, credential: null })).rejects.toThrow("mailbox not connected");
});

const NOTICE = { from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>", subject: "Delivery Status Notification (Failure)", text: "It failed" };

test("a delivery status part names each failed recipient and its status", async () => {
  const { fake, poll } = setup();
  fake.deliver({
    ...NOTICE,
    deliveryStatus: "Reporting-MTA: dns; googlemail.com\n\nFinal-Recipient: rfc822; Kim@Example.com\nAction: failed\nStatus: 5.1.1\n\nFinal-Recipient: rfc822; lee@example.com\nAction: failed\nStatus: 5.7.1\n",
  });
  const [e] = (await poll(null)).events;
  expect(data(e!).dsn).toEqual({
    recipients: [
      { email: "kim@example.com", status: "5.1.1" },
      { email: "lee@example.com", status: "5.7.1" },
    ],
  });
  expect(data(e!).text).toBe("It failed");
});

test("with no status part, X-Failed-Recipients still names who failed, with no status", async () => {
  const { fake, poll } = setup();
  fake.deliver({ ...NOTICE, headers: { "X-Failed-Recipients": "kim@example.com, Lee@example.com" } });
  const [e] = (await poll(null)).events;
  expect(data(e!).dsn).toEqual({
    recipients: [
      { email: "kim@example.com", status: null },
      { email: "lee@example.com", status: null },
    ],
  });
});

test("an ordinary reply has no delivery notice, even with a delivery-failure subject", async () => {
  const { fake, poll } = setup();
  fake.deliver({ from: "kim@example.com", subject: "Returned mail", text: "Hi" });
  const [e] = (await poll(null)).events;
  expect(data(e!).dsn).toBeNull();
  expect(data(e!).bounce).toBe(true);
});

test("the mail server's auto-reply headers come through, and a person's mail has none", async () => {
  const { fake, poll } = setup();
  fake.deliver({ from: "kim@example.com", subject: "Away", text: "x", headers: { "Auto-Submitted": "auto-replied" } });
  fake.deliver({ from: "lee@example.com", subject: "Away", text: "x", headers: { "X-Autoreply": "yes" } });
  fake.deliver({ from: "sam@example.com", subject: "Hi", text: "x" });
  const { events } = await poll(null);
  expect(events.map((e) => data(e).autoSubmitted).sort()).toEqual(["", "auto-replied", "auto-replied"]);
});
