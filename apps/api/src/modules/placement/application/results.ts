// SPDX-License-Identifier: AGPL-3.0-only
// What a Mailbox's Placement checks found, by ISO week, plain and content checks apart: how many it
// sent, how many reports counted, and each verdict that at least 3 counted reports agree on, with both
// counts. Fewer than 3 agreeing reports show no verdict. While the member list is bootstrap every
// answer says so. Also every report this Mailbox sent other members, so its person can see them.
import type { UnsignedList } from "../domain/list";
import { listState, reportsSent, sentByWeek, type PlacementTx } from "../adapters/repo";

/** Reports that must agree before a verdict shows. */
export const AGREEING = 3;
export const FEWER_THAN_AGREEING = "fewer than 3 matching reports";
export const BOOTSTRAP_NOTE = "The Placement circle is still starting: fewer than 3 people sign its member list, so one person decides who is in it.";
/** Weeks and sent reports one answer carries. */
const WEEKS = 12;
const REPORTS = 100;

export type KindResult = { sent: number; counted: number; verdicts: { verdict: string; reports: number }[]; note: string | null };
export type WeekResult = { week: string; plain: KindResult; content: KindResult; difference: { verdict: string; plain: number; content: number }[] };
type Counted = { week: string; kind: string; verdict: string | null; n: number };

function kindResult(rows: Counted[]): KindResult {
  const sent = rows.reduce((s, r) => s + r.n, 0);
  const reported = rows.filter((r) => r.verdict !== null);
  const verdicts = reported
    .filter((r) => r.n >= AGREEING)
    .map((r) => ({ verdict: r.verdict!, reports: r.n }))
    .sort((a, b) => b.reports - a.reports || a.verdict.localeCompare(b.verdict));
  return { sent, counted: reported.reduce((s, r) => s + r.n, 0), verdicts, note: verdicts.length ? null : FEWER_THAN_AGREEING };
}

/** Rows grouped by week, kind and reported verdict, as weeks newest first. Plain and content never share a count. */
export function weekResults(rows: Counted[]): WeekResult[] {
  const weeks = [...new Set(rows.map((r) => r.week))].sort().reverse().slice(0, WEEKS);
  return weeks.map((week) => {
    const of = (kind: string) => kindResult(rows.filter((r) => r.week === week && r.kind === kind));
    const plain = of("plain");
    const content = of("content");
    // Only verdicts shown on both sides, so the difference never reveals a count under 3.
    const difference = plain.verdicts.flatMap((p) => content.verdicts.filter((c) => c.verdict === p.verdict).map((c) => ({ verdict: p.verdict, plain: p.reports, content: c.reports })));
    return { week, plain, content, difference };
  });
}

/** This Mailbox's results and the reports it sent; the caller has checked it is in the Workspace. */
export async function resultsIn(tx: PlacementTx, credentialId: string) {
  const list = (await listState(tx))?.list as UnsignedList | undefined;
  // No trusted list yet claims no more than a bootstrap one.
  const bootstrap = list?.bootstrap ?? true;
  const weeks = weekResults(await sentByWeek(tx, credentialId));
  const reports = (await reportsSent(tx, credentialId, REPORTS)).map((r) => ({ ...r, verdict: r.verdict!, at: r.at.toISOString() }));
  return { bootstrap, bootstrapNote: bootstrap ? BOOTSTRAP_NOTE : null, weeks, reportsSent: reports };
}
export type Results = Awaited<ReturnType<typeof resultsIn>>;
