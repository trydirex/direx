// SPDX-License-Identifier: AGPL-3.0-only
// Reading Sent mail against the fake Gmail: 90 days back, headers only, resumed across polls.
import type { CallContext, TriggerEvent } from "@direx/plugin-sdk";
import { afterEach, expect, test } from "vitest";
import { gmailClient } from "./client";
import { startFakeGmail, type FakeGmail } from "./fake-gmail";
import { createGmailPlugin } from "./plugin";
import { addressesIn, pollSent } from "./sent";

const DAY = 86_400_000;
const fakes: FakeGmail[] = [];
afterEach(() => fakes.splice(0).forEach((f) => f.stop()));

function setup(opts: Parameters<typeof startFakeGmail>[0] = {}) {
  const fake = startFakeGmail(opts);
  fakes.push(fake);
  const clock = { now: Date.parse("2026-11-02T09:00:00Z") };
  const plugin = createGmailPlugin({ baseUrl: fake.url, timeoutMs: 2_000, now: () => clock.now });
  const ctx: CallContext = { workspaceId: "00000000-0000-4000-8000-000000000001", idempotencyKey: "", credential: { accessToken: fake.token, expiresAt: "" }, log: () => {} };
  const poll = (cursor: string | null) => plugin.triggers["mail.sent"]!.poll!(cursor, ctx);
  const client = gmailClient({ baseUrl: fake.url, fetch, timeoutMs: 2_000 });
  return { fake, clock, poll, client };
}

type Sent = { recipients: string[]; sentAt: number; listUnsubscribe: string | null; xDirexAction: string | null; messageId: string };
const data = (e: TriggerEvent) => e.data as Sent;

test("the first poll reads 90 days of Sent mail, headers only; the next reads since the last", async () => {
  const { fake, clock, poll } = setup();
  const recent = fake.sentMail({ to: "Kim Lee <Kim@Acme.test>", cc: "bo@acme.test", at: clock.now - 20 * DAY });
  fake.sentMail({ to: "old@acme.test", at: clock.now - 100 * DAY });
  const news = fake.sentMail({ to: "list@acme.test", at: clock.now - 2 * DAY, headers: { "List-Unsubscribe": "<mailto:u@x>" } });
  fake.deliver({ from: "kim@acme.test", subject: "Re: hi", text: "inbox mail is not Sent mail" });

  const first = await poll(null);
  expect(first.events.map((e) => e.eventId)).toEqual([news, recent]);
  expect(data(first.events[1]!)).toMatchObject({ recipients: ["kim@acme.test", "bo@acme.test"], sentAt: clock.now - 20 * DAY, listUnsubscribe: null });
  expect(data(first.events[0]!).listUnsubscribe).toBe("<mailto:u@x>");
  expect(JSON.stringify(first.events)).not.toMatch(/private/);

  // Nothing beyond metadata and the six headers was ever asked for: no body, no subject.
  const gets = fake.urls.filter((u) => u.startsWith("GET /messages/"));
  expect(gets.length).toBeGreaterThan(0);
  for (const u of gets) {
    expect(u).toContain("format=metadata");
    expect(u).not.toMatch(/format=(full|raw)|Subject/i);
  }

  clock.now += 60 * 60 * 1000;
  const later = fake.sentMail({ to: "new@acme.test", at: clock.now - 1000 });
  const second = await poll(first.cursor);
  // A day's overlap: earlier mail may come again, and the host drops what it has seen.
  expect(second.events.map((e) => e.eventId)).toContain(later);
  expect(second.events.map((e) => e.eventId)).not.toContain(recent);
});

test("a sweep that runs out of time keeps its page and carries on at the next poll", async () => {
  const { fake, clock, client } = setup({ pageSize: 2 });
  const ids = [1, 2, 3, 4, 5].map((d) => fake.sentMail({ to: `p${d}@acme.test`, at: clock.now - d * DAY }));
  const one = await pollSent(client, fake.token, null, clock.now, 0);
  expect(one.events).toHaveLength(2);
  expect(JSON.parse(one.cursor)).toHaveProperty("pageToken");
  const two = await pollSent(client, fake.token, one.cursor, clock.now + DAY, 0);
  const three = await pollSent(client, fake.token, two.cursor, clock.now + DAY, 0);
  expect([...one.events, ...two.events, ...three.events].map((e) => e.eventId)).toEqual(ids);
  // The finished sweep starts the next one a day before it began, not from the later poll's time.
  expect(JSON.parse(three.cursor)).toEqual({ since: Math.floor(clock.now / 1000) - 86_400 });
});

test("a page token Gmail no longer takes starts the sweep over", async () => {
  const { fake, clock, client } = setup({ pageSize: 1 });
  fake.sentMail({ to: "a@acme.test", at: clock.now - DAY });
  fake.sentMail({ to: "b@acme.test", at: clock.now - 2 * DAY });
  const one = await pollSent(client, fake.token, null, clock.now, 0);
  fake.failNext("list", 400, "invalidArgument");
  const two = await pollSent(client, fake.token, one.cursor, clock.now, 60_000);
  expect(two.events.map((e) => data(e).recipients[0])).toEqual(["a@acme.test", "b@acme.test"]);
});

test("addresses come out of display names, groups and odd spacing", () => {
  expect(addressesIn('"Lee, Kim" <KIM@acme.test>, bo@acme.test', "undisclosed-recipients:;")).toEqual(["kim@acme.test", "bo@acme.test"]);
  expect(addressesIn("", "")).toEqual([]);
});
