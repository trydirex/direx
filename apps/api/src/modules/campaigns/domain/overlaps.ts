// SPDX-License-Identifier: AGPL-3.0-only
// Pure: which of a Campaign's Touches each Person got before an outcome, summed by channel mix. Credit is
// never split and no row is ranked by rate: rows only say how many People a mix reached and how many of them had it.

export const CHANNELS = ["email", "linkedin_dm", "x_dm"] as const;
export type Channel = (typeof CHANNELS)[number];
export const OVERLAP_KINDS = ["interested", "meeting", "deal"] as const;
export type OverlapKind = (typeof OVERLAP_KINDS)[number];
/** Outcomes a row needs, and at least one other row with it, before it shows a rate. */
export const MIN_TO_COMPARE = 10;
/** Outcome People listed per kind; the rest are counted in `more`. */
export const PEOPLE_CAP = 200;

/** One Touch: a sent email or a DM marked sent, on a day in the Workspace's time zone. */
export type Touch = { personId: string; on: string; stepKey: string; title: string | null; channel: Channel };
export type OverlapRow = { channels: Channel[]; reached: number; outcomes: number; rate: number | null };

// Pure: a rate only where two rows each have enough outcomes to compare; rows are never ranked by it.
export function withRates(rows: OverlapRow[], min = MIN_TO_COMPARE): OverlapRow[] {
  const enough = rows.filter((r) => r.outcomes >= min).length >= 2;
  return rows.map((r) => ({ ...r, rate: enough && r.outcomes >= min ? Math.round((r.outcomes / r.reached) * 100) : null }));
}

// A mix's place in the fixed channel order, so equal rows always come out the same way.
const orderOf = (channels: readonly Channel[]) => channels.map((c) => CHANNELS.indexOf(c)).join(",");
// Code-unit order: ISO days, ids and order keys compare as plain strings, whatever the locale.
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One kind's rows and outcome People. `firsts` holds each Person's first outcome day of the kind. A Person's
 * mix is their Touches on or before that day, or all of them without the outcome; a Person with no such Touch
 * is in no row and not listed. People are listed oldest outcome first, each with their Touches oldest first.
 */
export function overlapKind(touches: readonly Touch[], firsts: ReadonlyMap<string, string>, cap = PEOPLE_CAP) {
  const before = new Map<string, Touch[]>();
  for (const t of [...touches].sort((a, b) => cmp(a.on, b.on))) {
    const on = firsts.get(t.personId);
    if (on === undefined || t.on <= on) before.set(t.personId, [...(before.get(t.personId) ?? []), t]);
  }
  const rows = new Map<string, OverlapRow>();
  for (const [personId, got] of before) {
    const channels = CHANNELS.filter((c) => got.some((t) => t.channel === c));
    const key = orderOf(channels);
    const row = rows.get(key) ?? { channels, reached: 0, outcomes: 0, rate: null };
    row.reached += 1;
    if (firsts.has(personId)) row.outcomes += 1;
    rows.set(key, row);
  }
  const people = [...firsts]
    .filter(([personId]) => before.has(personId))
    .sort(([pa, a], [pb, b]) => cmp(a, b) || cmp(pa, pb))
    .map(([personId, on]) => ({ personId, on, touches: before.get(personId)!.map(({ on, stepKey, title, channel }) => ({ on, stepKey, title, channel })) }));
  return {
    rows: withRates([...rows.values()].sort((a, b) => b.reached - a.reached || cmp(orderOf(a.channels), orderOf(b.channels)))),
    people: people.slice(0, cap),
    more: Math.max(0, people.length - cap),
  };
}
