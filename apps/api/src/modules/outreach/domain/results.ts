// SPDX-License-Identifier: AGPL-3.0-only
// Home's replies and opt-outs over the last 7 days against the 7 before, each with only the facts Direx holds
// about that window. The sentence behind each is written from these and nothing else.

export type ResultFacts = {
  replies: { now: number; before: number };
  optedOut: { now: number; before: number };
  sent: { now: number; before: number };
  /** The emails this window's replies answered, most replies first. */
  bySubject: { subject: string; replies: number; optedOut: number }[];
  pausedOn: Date[];
};
/** One of Home's numbers as `result_why` reads it. */
export type HomeResult = { key: string; label: string; now: number; before: number; facts: string[] };

const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** Nothing to explain when neither window had a reply. */
export function replyResults(f: ResultFacts): HomeResult[] {
  if (f.replies.now === 0 && f.replies.before === 0) return [];
  const shared = [
    `Emails sent: ${f.sent.now} in the last 7 days, ${f.sent.before} in the 7 days before`,
    ...f.pausedOn.map((d) => `A campaign was paused on ${day(d)}`),
  ];
  const out: HomeResult[] = [
    {
      key: "replies",
      label: "Replies to outreach, last 7 days",
      now: f.replies.now,
      before: f.replies.before,
      facts: [...shared, ...f.bySubject.map((s) => `${s.replies} of the ${f.replies.now} replies answered the email '${s.subject}'`)],
    },
  ];
  if (f.optedOut.now > 0 || f.optedOut.before > 0)
    out.push({
      key: "opt_outs",
      label: "Asked to stop, last 7 days",
      now: f.optedOut.now,
      before: f.optedOut.before,
      facts: [...shared, ...f.bySubject.filter((s) => s.optedOut > 0).map((s) => `${s.optedOut} of the ${f.optedOut.now} opt-outs came from replies to '${s.subject}'`)],
    });
  return out;
}
