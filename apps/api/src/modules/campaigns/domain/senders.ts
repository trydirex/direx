// SPDX-License-Identifier: AGPL-3.0-only
// Pure: which of a step's Mailboxes each Person's email goes from, and when.

export type Sender = { credentialId: string; at: Date };

/**
 * `free` holds each of the step's Mailboxes with its free send times in order, earliest first, and
 * `keep` the Mailbox each Person's earlier email in the Campaign went from. A Person keeps that sender
 * while it is on the step, so a follow-up never reads like it came from a stranger. Everyone else takes
 * the earliest free time left on any Mailbox; on a tie the Mailboxes take turns, the one given fewer
 * emails first, then the step's order. A Person missing from the result has no time in the horizon.
 */
export function assignSenders(people: readonly string[], free: ReadonlyMap<string, readonly Date[]>, keep: ReadonlyMap<string, string>): Map<string, Sender> {
  const used = new Map([...free.keys()].map((m) => [m, 0]));
  const nextOf = (m: string) => free.get(m)![used.get(m)!];
  const out = new Map<string, Sender>();
  const give = (p: string, m: string) => {
    const at = nextOf(m);
    if (!at) return;
    used.set(m, used.get(m)! + 1);
    out.set(p, { credentialId: m, at });
  };
  const rest: string[] = [];
  for (const p of people) {
    const m = keep.get(p);
    if (m && free.has(m)) give(p, m);
    else rest.push(p);
  }
  for (const p of rest) {
    let best: string | undefined;
    for (const m of free.keys()) {
      const at = nextOf(m);
      if (!at) continue;
      const bestAt = best === undefined ? undefined : nextOf(best)!;
      if (!bestAt || at < bestAt || (at.getTime() === bestAt.getTime() && used.get(m)! < used.get(best!)!)) best = m;
    }
    if (best) give(p, best);
  }
  return out;
}
