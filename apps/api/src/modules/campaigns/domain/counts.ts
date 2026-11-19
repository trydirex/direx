// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a Campaign's counts say. Where Direx can't count, the answer is null, never a zero.

/** A number and who it rests on: what Direx saw, or what a person told Direx (a DM marked sent). */
export type Count = { n: number; source: "direx" | "person" } | null;
export type FunnelStep = { stepKey: string; title: string | null; type: string; dmChannel: string | null };
export type FunnelRow = { stepKey: string; title: string | null; kind: string; channel: string | null; sent: Count; replied: Count; interested: Count };
type PerStep = ReadonlyMap<string, number>;

// Pure: a count becomes a reading only when there was something to count from, and only when it moved.
export function nextReading(count: number, countable: boolean, lastSystem: string | null): string | null {
  if (!countable) return null;
  const value = String(count);
  return value === lastSystem ? null : value;
}

/** Each key's rows added up, such as sends per step or per channel. */
export function sumBy<K extends string>(rows: readonly ({ n: number } & Record<K, string>)[], key: K): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) out.set(r[key], (out.get(r[key]) ?? 0) + r.n);
  return out;
}

/** Distinct (step, Person) pairs as People per step, and as People across the Campaign, each once. */
export function tally(pairs: readonly { stepKey: string; personId: string }[]) {
  const byStep = new Map<string, number>();
  for (const p of pairs) byStep.set(p.stepKey, (byStep.get(p.stepKey) ?? 0) + 1);
  return { byStep, people: new Set(pairs.map((p) => p.personId)).size };
}

/** One funnel row per step: sent, replied and interested, each with its source, or null where Direx can't see it. */
export function stepFunnel(steps: readonly FunnelStep[], c: { emails: PerStep; dms: PerStep; posts: PerStep; replied: PerStep; interested: PerStep }): FunnelRow[] {
  const of = (m: PerStep, key: string, source: "direx" | "person"): NonNullable<Count> => ({ n: m.get(key) ?? 0, source });
  return steps.map((s) => {
    const row = { stepKey: s.stepKey, title: s.title, kind: s.type };
    if (s.type === "email") {
      const sent = of(c.emails, s.stepKey, "direx");
      // Nothing comes back on email that was never sent, so until one goes there is no reply count, not a zero.
      const back = (m: PerStep) => (sent.n ? of(m, s.stepKey, "direx") : null);
      return { ...row, channel: "email", sent, replied: back(c.replied), interested: back(c.interested) };
    }
    // Direx reads no DM replies, and a post's commenters aren't People, so neither step has a reply count.
    if (s.type === "dm") return { ...row, channel: s.dmChannel, sent: of(c.dms, s.stepKey, "person"), replied: null, interested: null };
    if (s.type === "post") return { ...row, channel: null, sent: of(c.posts, s.stepKey, "direx"), replied: null, interested: null };
    // A manual, brief or clips step sends nothing Direx counts.
    return { ...row, channel: null, sent: null, replied: null, interested: null };
  });
}
