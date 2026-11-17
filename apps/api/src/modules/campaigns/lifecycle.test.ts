// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { lifecycle, STATUSES, type LifecycleInput } from "./domain/lifecycle";

const TODAY = "2026-11-12";
const base: LifecycleInput = { endsOn: "2026-12-31", paused: false, approved: true, waiting: false, launchOn: "2026-11-01" };

test.each<[string, Partial<LifecycleInput>, string, boolean]>([
  // Each state.
  ["ended past its end date", { endsOn: "2026-11-11" }, "ended", false],
  ["paused", { paused: true }, "paused", false],
  ["draft: never approved, nothing waiting", { approved: false }, "draft", false],
  ["draft again after a rejection: never approved, nothing waiting", { approved: false, waiting: false, launchOn: null }, "draft", false],
  ["awaiting sign-off: never approved, one waiting", { approved: false, waiting: true }, "awaiting_signoff", false],
  ["scheduled: approved, launch ahead", { launchOn: "2026-11-13" }, "scheduled", false],
  ["no launch date", { launchOn: null }, "no_launch_date", false],
  ["running", {}, "running", false],
  ["running on its launch day", { launchOn: TODAY }, "running", false],
  ["running on its last day", { endsOn: TODAY }, "running", false],
  // Precedence: the first match wins.
  ["ended beats paused", { endsOn: "2026-11-01", paused: true }, "ended", false],
  ["paused beats draft", { paused: true, approved: false }, "paused", false],
  ["paused beats awaiting sign-off", { paused: true, approved: false, waiting: true }, "paused", false],
  ["draft beats a launch ahead", { approved: false, launchOn: "2026-12-01" }, "draft", false],
  ["awaiting sign-off beats no launch date", { approved: false, waiting: true, launchOn: null }, "awaiting_signoff", false],
  ["scheduled with no end date", { endsOn: null, launchOn: "2026-12-01" }, "scheduled", false],
  // A later version waiting while an approved one runs is a marker, not a status.
  ["changes waiting on a running campaign", { waiting: true }, "running", true],
  ["changes waiting on a paused campaign", { waiting: true, paused: true }, "paused", true],
  ["changes waiting on an ended campaign", { waiting: true, endsOn: "2026-11-01" }, "ended", true],
])("%s", (_, over, status, changesWaiting) => {
  expect(lifecycle({ ...base, ...over }, TODAY)).toEqual({ status, changesWaiting });
});

test("every status is reachable", () => {
  const seen = new Set(
    [{ endsOn: "2026-01-01" }, { paused: true }, { approved: false }, { approved: false, waiting: true }, { launchOn: "2027-01-01" }, { launchOn: null }, {}].map((o) => lifecycle({ ...base, ...o }, TODAY).status),
  );
  expect([...seen].sort()).toEqual([...STATUSES].sort());
});
