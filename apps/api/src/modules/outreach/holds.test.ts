// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { isHandWritten, type SentHeaders } from "./domain/hand-written";
import { companyOf, holdFor, type CertainHold, type HoldInput } from "./domain/holds";
import { sharedMailDomain } from "../people/index";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);
const hold = (start: number, expires: number, ended: number | null = null, reason = "Deal: Acme renewal"): CertainHold => ({
  reason,
  startedAt: day(start),
  expiresAt: day(expires),
  endedAt: ended === null ? null : day(ended),
});
const input = (now: number, over: Partial<HoldInput> = {}): HoldInput => ({
  now: day(now),
  own: [],
  company: [],
  lastWritten: null,
  released: { inferred: null, company: null },
  ...over,
});

test("no hold of any kind leaves the Person free", () => {
  expect(holdFor(input(100))).toEqual({ kind: "none" });
});

test("a certain hold lasts its term and then 90 more days", () => {
  const own = [hold(0, 30)];
  expect(holdFor(input(10, { own }))).toEqual({ kind: "certain", reason: "Deal: Acme renewal", until: day(120), running: true });
  // Past its term, only the wait is left.
  expect(holdFor(input(31, { own }))).toMatchObject({ kind: "certain", running: false });
  expect(holdFor(input(119, { own })).kind).toBe("certain");
  expect(holdFor(input(120, { own })).kind).toBe("none");
});

test("ending a certain hold early starts the 90-day wait from that day, never skips it", () => {
  const own = [hold(0, 30, 5)];
  expect(holdFor(input(6, { own }))).toMatchObject({ kind: "certain", until: day(95), running: false });
  expect(holdFor(input(95, { own })).kind).toBe("none");
});

test("of several certain holds, the one that keeps the Person out longest is shown", () => {
  const own = [hold(0, 30, null, "Skipped on approval"), hold(10, 60, null, "Deal in Pipedrive")];
  expect(holdFor(input(20, { own }))).toEqual({ kind: "certain", reason: "Deal in Pipedrive", until: day(150), running: true });
});

test("a hand-written email holds for 90 days, and a release covers only what came before it", () => {
  expect(holdFor(input(89, { lastWritten: day(0) }))).toEqual({ kind: "inferred", lastWritten: day(0) });
  expect(holdFor(input(90, { lastWritten: day(0) })).kind).toBe("none");
  expect(holdFor(input(10, { lastWritten: day(0), released: { inferred: day(5), company: null } })).kind).toBe("none");
  expect(holdFor(input(10, { lastWritten: day(8), released: { inferred: day(5), company: null } })).kind).toBe("inferred");
});

test("a colleague's active deal holds the Person until it ends or is released", () => {
  const company = [{ ...hold(0, 30), domain: "acme.com" }];
  expect(holdFor(input(10, { company }))).toEqual({ kind: "company", domain: "acme.com", reason: "Deal: Acme renewal" });
  expect(holdFor(input(30, { company })).kind).toBe("none");
  expect(holdFor(input(10, { company, released: { inferred: null, company: day(2) } })).kind).toBe("none");
  const newer = [...company, { ...hold(5, 30), domain: "acme.com" }];
  expect(holdFor(input(10, { company: newer, released: { inferred: null, company: day(2) } })).kind).toBe("company");
});

test("a certain hold outranks a guess, and a guess outranks a colleague's deal", () => {
  const all = { own: [hold(0, 30)], company: [{ ...hold(0, 30), domain: "acme.com" }], lastWritten: day(1) };
  expect(holdFor(input(10, all)).kind).toBe("certain");
  expect(holdFor(input(10, { ...all, own: [] })).kind).toBe("inferred");
});

test("a shared mail provider's address stands for no company", () => {
  expect(companyOf("Jane@Acme.com", sharedMailDomain)).toBe("acme.com");
  expect(companyOf("jane@gmail.com", sharedMailDomain)).toBeNull();
  expect(companyOf("jane@mail.yahoo.com", sharedMailDomain)).toBeNull();
  expect(companyOf("not-an-address", sharedMailDomain)).toBeNull();
  expect(companyOf("@acme.com", sharedMailDomain)).toBeNull();
});

const sent = (over: Partial<SentHeaders> = {}): SentHeaders => ({
  messageId: "<a@mail.gmail.com>",
  recipients: ["jane@acme.com"],
  xDirexAction: null,
  listUnsubscribe: null,
  precedence: null,
  ...over,
});

test("a plain email to a few people is hand-written", () => {
  expect(isHandWritten(sent(), new Set())).toBe(true);
  expect(isHandWritten(sent({ recipients: Array.from({ length: 10 }, (_, i) => `p${i}@acme.com`) }), new Set())).toBe(true);
});

test("Direx's sends, bulk mail and announcements are not hand-written", () => {
  expect(isHandWritten(sent({ xDirexAction: "act_1" }), new Set())).toBe(false);
  expect(isHandWritten(sent(), new Set(["<a@mail.gmail.com>"]))).toBe(false);
  expect(isHandWritten(sent({ listUnsubscribe: "<mailto:u@x.com>" }), new Set())).toBe(false);
  expect(isHandWritten(sent({ precedence: " Bulk " }), new Set())).toBe(false);
  expect(isHandWritten(sent({ recipients: Array.from({ length: 11 }, (_, i) => `p${i}@acme.com`) }), new Set())).toBe(false);
  expect(isHandWritten(sent({ recipients: [] }), new Set())).toBe(false);
});
