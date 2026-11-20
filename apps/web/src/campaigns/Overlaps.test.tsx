// SPDX-License-Identifier: AGPL-3.0-only
// Who it reached: counts per channel mix, a rate only where the API gives one, each outcome Person's
// Touches, and never a word that ranks a row or gives a channel credit.
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { api } from "../client";
import { withQueries } from "../testing";
import type { Overlaps as Data } from "./actions";
import { Overlaps } from "./Overlaps";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const kim = { personId: "00000000-0000-4000-8000-000000000001", name: "Kim Lee", email: "kim@acme.test", on: "2026-11-12", touches: [{ on: "2026-11-03", stepKey: "first", title: "First email", channel: "email" as const }, { on: "2026-11-05", stepKey: "dm", title: null, channel: "linkedin_dm" as const }] };
const sam = { personId: "00000000-0000-4000-8000-000000000002", name: null, email: "sam@acme.test", on: "2026-11-14", touches: [{ on: "2026-11-03", stepKey: "first", title: "First email", channel: "email" as const }] };
const full: Data = {
  kinds: [
    { kind: "interested", rows: [{ channels: ["email"], reached: 40, outcomes: 12, rate: 30 }, { channels: ["email", "linkedin_dm"], reached: 20, outcomes: 10, rate: 50 }, { channels: ["email", "linkedin_dm", "x_dm"], reached: 3, outcomes: 1, rate: null }], people: [kim, sam], more: 21 },
    { kind: "meeting", rows: [{ channels: ["email"], reached: 40, outcomes: 1, rate: null }, { channels: ["x_dm"], reached: 20, outcomes: 0, rate: null }], people: [sam], more: 0 },
    { kind: "deal", rows: [{ channels: ["email"], reached: 40, outcomes: 0, rate: null }, { channels: ["x_dm"], reached: 20, outcomes: 0, rate: null }], people: [], more: 0 },
  ],
  hasPosts: true,
};

async function show(data: Data) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    Promise.resolve(path === "/api/w/{workspaceId}/campaigns/{id}/overlaps" ? { data, response: new Response(null, { status: 200 }) } : { error: { error: "not_found" }, response: new Response(null, { status: 404 }) })) as never);
  render(withQueries(<Overlaps workspaceId={W} id={ID} />));
  return within(await screen.findByRole("region", { name: "Who it reached" }));
}
const rows = (table: HTMLElement) => within(table).getAllByRole("row").map((r) => Array.from(r.children, (c) => c.textContent));

test("each kind's table has a row per channel mix with its counts, a whole-percent rate or too few to compare", async () => {
  const s = await show(full);
  expect(rows(s.getByRole("table", { name: "Interested replies from People this Campaign reached" }))).toEqual([
    ["Channels", "People reached", "Replied interested", "Rate"],
    ["Email only", "40", "12", "30%"],
    ["Email and LinkedIn DM", "20", "10", "50%"],
    ["Email, LinkedIn DM and X DM", "3", "1", "too few to compare"],
  ]);
  const meetings = s.getByRole("table", { name: "Meetings with People this Campaign reached" });
  expect(rows(meetings)).toEqual([
    ["Channels", "People reached", "Had a meeting", "Rate"],
    ["Email only", "40", "1", "too few to compare"],
    ["X DM only", "20", "0", "too few to compare"],
  ]);
  expect(meetings.textContent).not.toContain("%");
  expect(meetings.closest(".overflow-x-auto")).toBeTruthy();
});

test("a kind with no outcomes says so in one line; deals name the People this Campaign reached", async () => {
  const s = await show(full);
  expect(s.getByRole("heading", { name: "Deals with People this Campaign reached" })).toBeTruthy();
  expect(s.queryByRole("table", { name: /Deals/ })).toBeNull();
  expect(s.getByText("None yet. 60 People reached so far.")).toBeTruthy();
});

test("each outcome Person lists their Touches before it, oldest first, with and N more", async () => {
  const s = await show(full);
  expect(s.getByText("Each Person and their Touches before it (23)")).toBeTruthy();
  expect(s.getByText("and 21 more")).toBeTruthy();
  const kimTouches = s.getByRole("list", { name: "Touches before it for Kim Lee" });
  expect(kimTouches.parentElement?.firstElementChild?.textContent).toBe("Kim Lee · Replied interested Thu 12 Nov");
  expect(within(kimTouches).getAllByRole("listitem").map((l) => l.textContent)).toEqual(["Tue 3 Nov · First email · Email", "Thu 5 Nov · dm · LinkedIn DM"]);
  expect(s.getAllByRole("list", { name: "Touches before it for sam@acme.test" })).toHaveLength(2);
  expect(s.getByText("· Meeting Sat 14 Nov")).toBeTruthy();
  expect(s.queryAllByText(/and \d+ more/)).toHaveLength(1);
});

test("the posts line shows only when the Campaign has a post step", async () => {
  const s = await show(full);
  expect(s.getByText("Posts reach no named People, so they aren't in these counts.")).toBeTruthy();
  cleanup();
  vi.restoreAllMocks();
  const t = await show({ ...full, hasPosts: false });
  expect(t.queryByText(/Posts reach/)).toBeNull();
});

test("a Campaign with no Touches says one line instead of empty tables", async () => {
  const none = { kinds: (["interested", "meeting", "deal"] as const).map((kind) => ({ kind, rows: [], people: [], more: 0 })), hasPosts: false };
  const s = await show(none);
  expect(s.getByText("Nothing to count yet. This fills in once an email goes out or a DM is marked sent.")).toBeTruthy();
  expect(s.queryByRole("table")).toBeNull();
  expect(s.queryByRole("heading", { level: 3 })).toBeNull();
});

test("a Person with no name or email still shows, and one Person reached reads in the singular", async () => {
  const s = await show({ kinds: [{ kind: "meeting", rows: [{ channels: ["email"], reached: 1, outcomes: 0, rate: null }], people: [], more: 0 }, { kind: "deal", rows: [{ channels: ["email"], reached: 1, outcomes: 1, rate: null }], people: [{ ...sam, email: null }], more: 0 }], hasPosts: false });
  expect(s.getByText("None yet. 1 Person reached so far.")).toBeTruthy();
  expect(s.getByText("No name or email")).toBeTruthy();
  expect(s.getByRole("list", { name: "Touches before it for this Person" })).toBeTruthy();
});

test("no word ranks a row or gives a channel credit", async () => {
  const s = await show(full);
  const text = (await screen.findByRole("region", { name: "Who it reached" })).textContent ?? "";
  expect(s.getAllByRole("table")).toHaveLength(2);
  expect(text).not.toMatch(/\b(best|top|winner|caused|drove)\b|from this Campaign/i);
});


test("returning to Overview refreshes reached counts even while the cached read is fresh", async () => {
  let data: Data = { kinds: [], hasPosts: false };
  const get = vi.spyOn(api, "GET").mockImplementation((() =>
    Promise.resolve({ data, response: new Response(null, { status: 200 }) })) as never);
  function OverviewVisit() {
    const [overview, setOverview] = useState(true);
    return <><button onClick={() => setOverview(!overview)}>Switch tab</button>{overview && <Overlaps workspaceId={W} id={ID} />}</>;
  }
  render(withQueries(<OverviewVisit />));
  expect(await screen.findByText("Nothing to count yet. This fills in once an email goes out or a DM is marked sent.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Switch tab" }));
  // A DM marked sent in Content changes the server's counts while Overview is unmounted.
  data = full;
  await userEvent.click(screen.getByRole("button", { name: "Switch tab" }));
  expect(await screen.findByRole("table", { name: "Interested replies from People this Campaign reached" })).toBeTruthy();
  expect(get).toHaveBeenCalledTimes(2);
});
