// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { activityLines, launchUndo, type ActivityRow } from "./domain/activity";

const at = (h: number) => new Date(Date.UTC(2026, 10, 10, h));
const step = (k: string) => ({ first: "First email", second: "Follow-up" })[k] ?? k;
const reason = (c: string) => (c === "mailbox_unchecked" ? "this Mailbox hasn't passed its unsubscribe check" : "see details");

test("a Campaign's activity reads as short lines, newest first, and leaves out internal steps", () => {
  const rows: ActivityRow[] = [
    { kind: "created", at: at(1) },
    { kind: "actions", stepKey: "first", fromState: null, toState: "needs_approval", reason: null, n: 14, at: at(2), byPerson: false },
    { kind: "actions", stepKey: "first", fromState: "needs_approval", toState: "scheduled", reason: null, n: 1, at: at(3), byPerson: true },
    { kind: "actions", stepKey: "first", fromState: "scheduled", toState: "claimed", reason: null, n: 1, at: at(4), byPerson: false },
    { kind: "actions", stepKey: "first", fromState: "dispatching", toState: "held", reason: "mailbox_unchecked", n: 2, at: at(5), byPerson: false },
    { kind: "actions", stepKey: "first", fromState: "dispatching", toState: "sent", reason: null, n: 1, at: at(6), byPerson: false },
    { kind: "actions", stepKey: "second", fromState: "scheduled", toState: "needs_approval", reason: null, n: 3, at: at(7), byPerson: false },
    { kind: "notice", title: "The launch moved to Tue 10 Nov", at: at(8) },
    { kind: "running", stepKey: "second", at: at(9) },
  ];
  expect(activityLines(rows, step, reason).map((l) => [l.text, l.by])).toEqual([
    ["Drafting Follow-up", "direx"],
    ["The launch moved to Tue 10 Nov", "direx"],
    ["3 drafts of Follow-up went back for approval", "direx"],
    ["Sent First email to 1 person", "direx"],
    ["Held 2 emails of First email: this Mailbox hasn't passed its unsubscribe check", "direx"],
    ["Approved 1 draft of First email", "person"],
    ["Drafted First email for 14 people", "direx"],
    ["Created the campaign from its plan", "person"],
  ]);
  expect(activityLines(rows, step, reason, 2)).toHaveLength(2);
});

test("only the latest launch move can be undone, back where it came from, while the launch is still where it put it", () => {
  const moved = (from: string, to: string, h: number, state = "needs_approval") => ({ kind: "launch_moved", payload: { campaignId: "c", from, to }, at: at(h), state });
  const notices = [moved("2026-11-03", "2026-11-05", 1, "cancelled"), moved("2026-11-05", "2026-11-06", 2), { kind: "other", payload: {}, at: at(3), state: null }];
  expect(launchUndo(notices, "launch_moved", "2026-11-06")?.undo).toEqual({ kind: "launch", on: "2026-11-05" });
  expect(launchUndo(notices, "launch_moved", "2026-11-06")?.notice).toBe(notices[1]);
  // Moved since by something else: nothing to undo.
  expect(launchUndo(notices, "launch_moved", "2026-11-09")).toBeNull();
  expect(launchUndo([], "launch_moved", null)).toBeNull();
  // Two moves at the same moment: the one still open is the newer.
  const same = [moved("2026-11-05", "2026-11-06", 4), moved("2026-11-06", "2026-11-05", 4, "cancelled")];
  expect(launchUndo(same, "launch_moved", "2026-11-06")?.undo).toEqual({ kind: "launch", on: "2026-11-05" });
});
