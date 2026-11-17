// SPDX-License-Identifier: AGPL-3.0-only
// Pairing, check identity and send time: every install computes the same pairs, subjects and windows
// from the day and the trusted list, a removed member never pairs, and checks go only to Google MX.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { googleMx, type ResolveMx } from "./application/mx";
import { contentSubject, expectedAt, matchWindow, pairDay, probeIdentity, receiversFor, seed, sendersTo, type PairMember } from "./application/pairing";
import { plainSubject } from "./application/render";

const FOUNDERS = ["founder@contosohq.example", "dominik@trydirex.com"];
const RECEIVERS = ["r1@circle.test", "r2@circle.test", "r3@circle.test"];
const member = (address: string, listed_at = "2026-11-10"): PairMember => ({ address, listed_at });
const BOOTSTRAP = [...FOUNDERS, ...RECEIVERS].map((a) => member(a));
const LIST_HASH = "ab".repeat(32);
const DAY = seed(new Date("2026-11-12T08:00:00Z"), LIST_HASH);

test("the seed is the UTC date and the list hash, and changes with either", () => {
  expect(seed(new Date("2026-11-12T23:59:59Z"), LIST_HASH)).toEqual(DAY);
  expect(DAY.day).toBe("2026-11-12");
  expect(seed(new Date("2026-11-13T00:00:00Z"), LIST_HASH).value).not.toBe(DAY.value);
  expect(seed(new Date("2026-11-12T08:00:00Z"), "cd".repeat(32)).value).not.toBe(DAY.value);
});

test("bootstrap pairs both founder Mailboxes with every receiver, and each receiver expects both", () => {
  for (const f of FOUNDERS) expect(receiversFor(DAY, f, BOOTSTRAP)).toEqual(expect.arrayContaining(RECEIVERS));
  for (const r of RECEIVERS) expect(sendersTo(DAY, r, BOOTSTRAP)).toEqual(expect.arrayContaining(FOUNDERS));
});

test("sender and receiver compute the same pairs, subjects and windows, whatever the order or case they hold", () => {
  const shuffled = [...BOOTSTRAP].reverse().map((m) => ({ ...m, address: m.address.toUpperCase() }));
  const sendSide = receiversFor(DAY, FOUNDERS[0]!, BOOTSTRAP);
  expect(receiversFor(seed(new Date("2026-11-12T16:00:00Z"), LIST_HASH), FOUNDERS[0]!.toUpperCase(), shuffled).map((a) => a.toLowerCase())).toEqual(sendSide);
  for (const r of RECEIVERS) {
    for (const kind of ["plain", "content"] as const) {
      const sent = probeIdentity(DAY, member(FOUNDERS[0]!), member(r), kind);
      expect(probeIdentity(DAY, member(FOUNDERS[0]!.toUpperCase()), member(r.toUpperCase()), kind)).toEqual(sent);
    }
  }
});

test("a removed member is never paired, either way", () => {
  const removed = "r2@circle.test";
  const after = BOOTSTRAP.filter((m) => m.address !== removed);
  for (let d = 1; d <= 28; d++) {
    const s = seed(new Date(Date.UTC(2026, 10, 10 + d)), LIST_HASH);
    for (const m of after) expect(receiversFor(s, m.address, after)).not.toContain(removed);
    expect(receiversFor(s, removed, after)).toEqual([]);
    expect(sendersTo(s, removed, after)).toEqual([]);
  }
});

test("a member listed later joins pairing from its listed day", () => {
  const late = member("late@circle.test", "2026-11-13");
  expect(receiversFor(DAY, FOUNDERS[0]!, [...BOOTSTRAP, late])).not.toContain(late.address);
  expect(receiversFor(seed(new Date("2026-11-13T00:00:00Z"), LIST_HASH), FOUNDERS[0]!, [...BOOTSTRAP, late])).toContain(late.address);
  expect(() => pairDay(DAY, member(FOUNDERS[0]!), late)).toThrow();
});

test("from 10 members a sender pairs with the top K, and the choice moves day to day", () => {
  const many = Array.from({ length: 30 }, (_, i) => member(`m${i}@circle.test`));
  const today = receiversFor(DAY, "m0@circle.test", many);
  expect(today).toHaveLength(8);
  expect(new Set(today).size).toBe(8);
  expect(receiversFor(seed(new Date("2026-11-13T08:00:00Z"), LIST_HASH), "m0@circle.test", many)).not.toEqual(today);
  expect(receiversFor(DAY, "m0@circle.test", many, 3)).toEqual(today.slice(0, 3));
});

test("each check is expected at a whole minute between 09:00 and 17:00 UTC, and the window brackets it", () => {
  for (const r of RECEIVERS) {
    for (const seq of [0, 1]) {
      const at = expectedAt(DAY, FOUNDERS[1]!, r, seq);
      expect(at.toISOString().slice(0, 10)).toBe("2026-11-12");
      expect(at.getUTCHours()).toBeGreaterThanOrEqual(9);
      expect(at.getUTCHours()).toBeLessThan(17);
      expect(at.getUTCSeconds()).toBe(0);
      expect(matchWindow(DAY, FOUNDERS[1]!, r, seq)).toEqual({ after: new Date(at.getTime() - 10 * 60_000), before: new Date(at.getTime() + 60 * 60_000) });
    }
  }
});

test("a plain check's subject follows the pair's listed days, not the day's seed, so 60 days pass before a repeat", () => {
  const [a, b] = [member(FOUNDERS[0]!, "2026-11-01"), member("r1@circle.test", "2026-11-05")];
  expect(pairDay(DAY, a, b)).toBe(7);
  expect(probeIdentity(DAY, a, b, "plain").subject).toBe(plainSubject(a.address, b.address, 7));
  expect(probeIdentity(seed(new Date("2026-11-12T08:00:00Z"), "ef".repeat(32)), a, b, "plain").subject).toBe(plainSubject(a.address, b.address, 7));
  const subjects = new Set(Array.from({ length: 60 }, (_, d) => probeIdentity(seed(new Date(Date.UTC(2026, 10, 5 + d)), LIST_HASH), a, b, "plain").subject));
  expect(subjects.size).toBe(60);
});

test("a content check carries a seed-derived tag after the step's subject, and only a content check does", () => {
  const id = probeIdentity(DAY, member(FOUNDERS[0]!), member("r1@circle.test"), "content");
  expect(id.subject).toMatch(/^ref [0-9a-f]{8}$/);
  expect(contentSubject("Alex, a question for Example Ltd", id)).toBe(`Alex, a question for Example Ltd (${id.subject})`);
  expect(probeIdentity(DAY, member(FOUNDERS[0]!), member("r2@circle.test"), "content").subject).not.toBe(id.subject);
  expect(probeIdentity(seed(new Date("2026-11-13T08:00:00Z"), LIST_HASH), member(FOUNDERS[0]!), member("r1@circle.test"), "content").subject).not.toBe(id.subject);
  expect(() => contentSubject("x", probeIdentity(DAY, member(FOUNDERS[0]!), member("r1@circle.test"), "plain"))).toThrow();
});

const mx =
  (...hosts: string[]): ResolveMx =>
  async () =>
    hosts.map((exchange, priority) => ({ exchange, priority }));

test("only domains whose every MX host is Google take checks", async () => {
  expect(await googleMx("contosohq.example", mx("ASPMX.L.GOOGLE.COM.", "alt1.aspmx.l.google.com", "alt4.aspmx.l.google.com", "aspmx2.googlemail.com"))).toBe(true);
  expect(await googleMx("trydirex.com", mx("smtp.google.com"))).toBe(true);
  expect(await googleMx("other.test", mx("mx.other.test"))).toBe(false);
  expect(await googleMx("mixed.test", mx("aspmx.l.google.com", "mx.filter.test"))).toBe(false);
  expect(await googleMx("lookalike.test", mx("aspmx.l.google.com.evil.test", "alt5.aspmx.l.google.com"))).toBe(false);
  expect(await googleMx("none.test", mx())).toBe(false);
  expect(
    await googleMx("down.test", async () => {
      throw new Error("ENOTFOUND");
    }),
  ).toBe(false);
});

test("pairing and the MX check ask no server: no fetch, no HTTP, no Direx host", () => {
  for (const file of ["pairing.ts", "mx.ts"]) {
    const src = readFileSync(join(import.meta.dirname, "application", file), "utf8");
    const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.every((i) => ["node:crypto", "node:dns/promises", "../domain/list", "./render"].includes(i!))).toBe(true);
    expect(src).not.toMatch(/fetch|https?:|direx\.com|trydirex/i);
  }
});
