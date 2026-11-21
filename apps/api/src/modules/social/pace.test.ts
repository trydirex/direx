// SPDX-License-Identifier: AGPL-3.0-only
import { socialNetworks } from "@direx/extensions";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOCIAL_PACE, offPace, offsetMinutes, paceOf, place, type SocialPace } from "./application/pace";

const UTC = "UTC";
const at = (iso: string) => new Date(iso);
const minutes = (n: number) => n * 60_000;
const NO_COLUMNS = { postingFrom: null, postingUntil: null, postingWeekends: null, gapMinutes: null };
const DAY: SocialPace = { from: 8 * 60, until: 20 * 60, weekends: true, gapMinutes: 60 };

describe("an account's pace", () => {
  it("takes the account's own values, then its Network's, then the fallback", () => {
    const network = { from: 7 * 60, until: 21 * 60, weekends: false, gapMinutes: 30 };
    expect(paceOf(NO_COLUMNS, network)).toEqual(network);
    expect(paceOf(NO_COLUMNS, undefined)).toEqual(DEFAULT_SOCIAL_PACE);
    expect(paceOf({ postingFrom: 9 * 60, postingUntil: 17 * 60, postingWeekends: true, gapMinutes: null }, network)).toEqual({ from: 9 * 60, until: 17 * 60, weekends: true, gapMinutes: 30 });
  });

  it("gives every first-party Network that publishes a pace inside one day", () => {
    const paced = socialNetworks().filter((n) => n.pace);
    expect(paced.map((n) => n.connection).sort()).toEqual(["bluesky", "facebook", "instagram", "linkedin", "linkedin_page", "mastodon", "threads", "x"]);
    for (const n of paced) expect(n.pace!.from < n.pace!.until && n.pace!.until <= 1440 && n.pace!.gapMinutes > 0).toBe(true);
  });
});

describe("the offset", () => {
  it("is 1 to 12 minutes, the same for one seed every time", () => {
    const seeds = Array.from({ length: 200 }, (_, i) => `key-${i}`);
    for (const s of seeds) expect(offsetMinutes(s)).toBe(offsetMinutes(s));
    const seen = new Set(seeds.map(offsetMinutes));
    expect([...seen].every((m) => m >= 1 && m <= 12)).toBe(true);
    expect(seen.size).toBe(12);
  });
});

describe("whether a time keeps the pace", () => {
  it("is outside the hours before opening, at closing and on a weekend that doesn't post", () => {
    expect(offPace(at("2026-11-23T07:59:00Z"), DAY, UTC, [])).toBe("outside_hours");
    expect(offPace(at("2026-11-23T20:00:00Z"), DAY, UTC, [])).toBe("outside_hours");
    expect(offPace(at("2026-11-21T10:00:00Z"), { ...DAY, weekends: false }, UTC, [])).toBe("outside_hours");
    expect(offPace(at("2026-11-23T10:00:00Z"), DAY, UTC, [])).toBeNull();
  });

  it("is inside the gap on either side of another post, and clear at the gap itself", () => {
    const other = [at("2026-11-23T10:00:00Z")];
    expect(offPace(at("2026-11-23T09:01:00Z"), DAY, UTC, other)).toBe("inside_gap");
    expect(offPace(at("2026-11-23T10:59:00Z"), DAY, UTC, other)).toBe("inside_gap");
    expect(offPace(at("2026-11-23T11:00:00Z"), DAY, UTC, other)).toBeNull();
  });
});

describe("placing a post", () => {
  const seed = "post-1";
  const off = minutes(offsetMinutes(seed));

  it("opens at the day's first time plus the offset, never on a quarter hour", () => {
    const t = place({ wanted: at("2026-11-23T06:00:00Z"), pace: DAY, timeZone: UTC, taken: [], seed })!;
    expect(t.getTime()).toBe(at("2026-11-23T08:00:00Z").getTime() + off);
    expect(t.getUTCMinutes() % 15).not.toBe(0);
  });

  it("keeps the gap from the account's other posts", () => {
    const taken = [at("2026-11-23T09:07:00Z")];
    const t = place({ wanted: at("2026-11-23T09:00:00Z"), pace: DAY, timeZone: UTC, taken, seed })!;
    expect(offPace(t, DAY, UTC, taken)).toBeNull();
    expect(t >= at("2026-11-23T09:00:00Z")).toBe(true);
  });

  it("gives a time it placed back unchanged, so re-placing never drifts", () => {
    const taken = [at("2026-11-23T12:00:00Z")];
    const once = place({ wanted: at("2026-11-23T11:30:00Z"), pace: DAY, timeZone: UTC, taken, seed })!;
    expect(place({ wanted: once, pace: DAY, timeZone: UTC, taken, seed })).toEqual(once);
    const shifted = new Date(once.getTime() + 86_400_000);
    expect(place({ wanted: shifted, pace: DAY, timeZone: UTC, taken: [], seed })).toEqual(shifted);
  });

  it("finds nothing on a day with no room, and never moves to another day", () => {
    const short: SocialPace = { from: 9 * 60, until: 10 * 60, weekends: true, gapMinutes: 60 };
    expect(place({ wanted: at("2026-11-23T09:00:00Z"), pace: short, timeZone: UTC, taken: [at("2026-11-23T09:30:00Z")], seed })).toBeNull();
    expect(place({ wanted: at("2026-11-23T19:59:00Z"), pace: DAY, timeZone: UTC, taken: [], seed })).toBeNull();
    expect(place({ wanted: at("2026-11-21T09:00:00Z"), pace: { ...DAY, weekends: false }, timeZone: UTC, taken: [], seed })).toBeNull();
  });

  it("works in the Workspace's time zone across a clock change", () => {
    // New York falls back on 2026-11-01, so 08:00 there is 13:00 UTC that day.
    const t = place({ wanted: at("2026-11-01T05:00:00Z"), pace: DAY, timeZone: "America/New_York", taken: [], seed })!;
    expect(t.getTime()).toBe(at("2026-11-01T13:00:00Z").getTime() + off);
    expect(offPace(t, DAY, "America/New_York", [])).toBeNull();
  });
});
