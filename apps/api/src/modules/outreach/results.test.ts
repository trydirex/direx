// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { replyResults, type ResultFacts } from "./domain/results";

const base: ResultFacts = { replies: { now: 0, before: 0 }, optedOut: { now: 0, before: 0 }, sent: { now: 0, before: 0 }, bySubject: [], pausedOn: [] };

test("no replies in either window gives nothing to explain", () => {
  expect(replyResults({ ...base, sent: { now: 40, before: 10 } })).toEqual([]);
});

test("replies carry only the facts Direx holds: sends, pauses and which email they answered; opt-outs show only when there are some", () => {
  const f: ResultFacts = {
    ...base,
    replies: { now: 5, before: 2 },
    sent: { now: 30, before: 12 },
    bySubject: [{ subject: "Café intro", replies: 4, optedOut: 0 }, { subject: "Hello", replies: 1, optedOut: 0 }],
    pausedOn: [new Date("2026-10-30T09:00:00Z")],
  };
  expect(replyResults(f)).toEqual([
    {
      key: "replies",
      label: "Replies to outreach, last 7 days",
      now: 5,
      before: 2,
      facts: ["Emails sent: 30 in the last 7 days, 12 in the 7 days before", "A campaign was paused on 30 Oct", "4 of the 5 replies answered the email 'Café intro'", "1 of the 5 replies answered the email 'Hello'"],
    },
  ]);
  const leaving = replyResults({ ...f, optedOut: { now: 2, before: 0 }, bySubject: [{ subject: "Trade list", replies: 3, optedOut: 2 }] });
  expect(leaving[1]).toEqual({
    key: "opt_outs",
    label: "Asked to stop, last 7 days",
    now: 2,
    before: 0,
    facts: ["Emails sent: 30 in the last 7 days, 12 in the 7 days before", "A campaign was paused on 30 Oct", "2 of the 2 opt-outs came from replies to 'Trade list'"],
  });
});
