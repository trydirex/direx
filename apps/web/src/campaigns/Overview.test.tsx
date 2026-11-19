// SPDX-License-Identifier: AGPL-3.0-only
// Each Measure says where its number came from. A counted one with nothing to count shows a dash,
// never a zero, and a person's correction shows Direx's count beside it.
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Tracking } from "../plans/actions";
import { Measures } from "./Overview";

afterEach(cleanup);

const basis = { kind: "assumption" } as const;
const show = (measures: Tracking["measures"], emailSent?: boolean) => {
  render(<Measures tracking={{ planned: 0, done: 0, skipped: 0, steps: [], measures }} emailSent={emailSent} />);
  return within(screen.getByRole("region", { name: "Measures" }));
};

test("a plan from before sources looks as it did: a person's reading, and no reading yet", () => {
  const m = show([
    { key: "s", label: "Signups", target: "200", basis, latest: { value: "142", observedOn: "2026-11-10", source: "person" } },
    { key: "m", label: "Meetings", target: "4", basis, latest: null },
  ]);
  expect(m.getByText("As of Tue 10 Nov, entered by a person")).toBeTruthy();
  expect(m.getByText("Meetings: target 4")).toBeTruthy();
  expect(m.getByText("No reading yet")).toBeTruthy();
  expect(m.queryByText(/Counted/)).toBeNull();
  expect(m.queryByText("-")).toBeNull();
});

test("a counted Measure with no reading shows a dash with a label and what it waits on; an external one has no reading yet", () => {
  const none = (key: string, source: Tracking["measures"][number]["source"]) => ({ key, label: key, target: "10", basis, source, latest: null });
  const m = show([none("replies", "replies"), none("interested", "interested_replies"), none("meetings", "meetings"), none("deals", "deals"), none("press", "external")], false);
  expect(m.getAllByText("-")).toHaveLength(4);
  for (const dash of m.getAllByText("-")) expect(dash.getAttribute("aria-hidden")).toBe("true");
  expect(m.getAllByText("No count yet")).toHaveLength(4);
  expect(m.queryByText("0")).toBeNull();
  expect(m.getByText("Counted by Direx from email replies. Waiting for the first email to go out.")).toBeTruthy();
  expect(m.getByText("Counted by Direx from replies labelled interested. Waiting for the first email to go out.")).toBeTruthy();
  expect(m.getByText("Counted by Direx from meetings marked on People. Mark a meeting on a Person. Direx counts marks each morning.")).toBeTruthy();
  expect(m.getByText("Counted by Direx from deals marked on People. Mark a deal on a Person. Direx counts marks each morning.")).toBeTruthy();
  expect(m.getByText("press: target 10")).toBeTruthy();
  expect(m.getByText("No reading yet")).toBeTruthy();
});

test("once an email has gone out, a reply count with no reading says the morning count brings it, not that it waits for an email", () => {
  const m = show([{ key: "replies", label: "Replies", target: "10", basis, source: "replies", latest: null }], true);
  expect(m.getByText("Counted by Direx from email replies. Direx counts each morning, so the first count comes with the next one.")).toBeTruthy();
  expect(m.queryByText(/Waiting for the first email/)).toBeNull();
});

test("a count says what Direx counted it from, and a correction shows the newest count beside it", () => {
  const m = show([
    { key: "r", label: "Replies", target: "20", basis, source: "replies", latest: { value: "6", observedOn: "2026-11-10", source: "system" } },
    {
      key: "i",
      label: "Interested",
      target: "5",
      basis,
      source: "interested_replies",
      latest: { value: "4", observedOn: "2026-11-12", source: "person" },
      readings: [
        { value: "3", observedOn: "2026-11-11", source: "system", at: "2026-11-11T07:00:00.000Z" },
        { value: "2", observedOn: "2026-11-11", source: "system", at: "2026-11-11T06:00:00.000Z" },
        { value: "1", observedOn: "2026-11-09", source: "system", at: "2026-11-09T06:00:00.000Z" },
        { value: "4", observedOn: "2026-11-12", source: "person", at: "2026-11-12T09:00:00.000Z" },
      ],
    },
    { key: "d", label: "Deals", target: "2", basis, source: "deals", latest: { value: "1", observedOn: "2026-11-12", source: "person" } },
  ]);
  expect(m.getByText("As of Tue 10 Nov, counted by Direx from email replies")).toBeTruthy();
  expect(m.getAllByText("As of Thu 12 Nov, entered by a person")).toHaveLength(2);
  expect(m.getByText("Counted by Direx from replies labelled interested: 3 as of Wed 11 Nov")).toBeTruthy();
  // A correction with no count yet has nothing to show beside it.
  expect(m.queryByText(/Counted by Direx from deals/)).toBeNull();
});
