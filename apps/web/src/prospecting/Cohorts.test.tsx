// SPDX-License-Identifier: AGPL-3.0-only
// Cohorts: saving a new or changed filter, adding who it matches to a Campaign, and following the
// hand-over until it is done.
import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { choose, ownStatus, pick, withQueries } from "../testing";
import { Cohorts, Handover } from "./Cohorts";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const C = "00000000-0000-4000-8000-0000000000cc";
const H = "00000000-0000-4000-8000-0000000000dd";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const filter = { signals: [], countries: [], kinds: [], sources: [], verification: [], runs: [] };
const cohort = { id: ID, name: "Hiring in York", filter, createdBy: ID, createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z" };
const member = (o: Record<string, unknown> = {}) => ({
  addressId: "a1",
  email: "ana@shop.test",
  kind: "named",
  name: "Ana",
  role: "Founder",
  source: "guessed",
  pattern: null,
  verificationResult: "deliverable",
  verifiedAt: "2026-11-01T00:00:00.000Z",
  company: { id: "c1", domain: "shop.test", name: "Shop", country: "GB" },
  evidence: { pageUrl: "https://shop.test/team", readAt: "2026-11-01T00:00:00.000Z" },
  ...o,
});
const page = { ...cohort, count: 3, deliverable: 2, inCampaign: 0, usedBy: [], members: [member(), member({ addressId: "a2", email: "info@other.test", kind: "odd", name: null, role: null, source: "published", company: { id: "c2", domain: "other.test", name: null, country: null } })], next: null };
const campaigns = [{ id: C, title: "Autumn audits", status: "running" }, { id: H, title: "Q4 <i>push</i>", status: "scheduled" }, { id: ID, title: "Spring draft", status: "draft" }, { id: W, title: "Waiting one", status: "awaiting_signoff" }];

function show(el: ReactElement, at = "/") {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: [at] }) });
  const navigate = vi.spyOn(router, "navigate").mockResolvedValue(undefined as never);
  render(withQueries(<RouterContextProvider router={router}>{el}</RouterContextProvider>));
  return navigate;
}

/** Reads answer from `paths`; every other read is not found. */
function serve(paths: Record<string, () => unknown>) {
  return vi.spyOn(api, "GET").mockImplementation(((p: string) => (paths[p] ? reply(200, paths[p]()) : reply(404, { error: "not_found" }))) as never);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("saving a new cohort sends its filter and opens it; bad countries are refused", async () => {
  serve({
    "/api/w/{workspaceId}/prospecting/cohorts": () => ({ cohorts: [{ ...cohort, filter: { signals: ["hiring", "x"], countries: ["GB"], kinds: ["named"], sources: ["guessed"], verification: ["deliverable"], runs: [ID] } }] }),
    "/api/w/{workspaceId}/prospecting/runs": () => ({ runs: [] }),
  });
  let saves = 0;
  const post = vi.spyOn(api, "POST").mockImplementation(((path: string) => {
    if (path.endsWith("/count")) return reply(200, { count: 42 });
    saves += 1;
    return saves === 1 ? reply(400, { error: "unknown_value", field: "countries" }) : reply(201, { ...cohort, id: C });
  }) as never);
  const navigate = show(<Cohorts workspaceId={W} role="marketer" />);
  // Each segment in the list shows its size and its conditions.
  expect(await screen.findByText("42 People")).toBeTruthy();
  expect(await screen.findByText("Hiring or x · Country: United Kingdom · Found by 1 search · Named person · Guessed · Checked addresses")).toBeTruthy();
  // The builder stays hidden until New segment is pressed, and Cancel hides it again.
  expect(screen.queryByRole("form", { name: "New segment" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "New segment" }));
  await userEvent.click(within(screen.getByRole("form", { name: "New segment" })).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("form", { name: "New segment" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "New segment" }));
  expect(screen.queryByRole("button", { name: "New segment" })).toBeNull();
  const form = within(screen.getByRole("form", { name: "New segment" }));
  expect(form.getByText("People who work at a kept company where")).toBeTruthy();
  await userEvent.type(form.getByLabelText("Name"), " Founders ");
  await userEvent.click(form.getByLabelText("Hiring"));
  await userEvent.click(form.getByLabelText("Named person"));
  await pick(form.getByRole("button", { name: "Countries" }), "United Kingdom");
  // The save button says how many the filter matches, counted as it changes.
  const saveButton = await form.findByRole("button", { name: "Save segment of 42 People" });
  await userEvent.click(saveButton);
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/prospecting/cohorts", {
    params: { path: { workspaceId: W } },
    body: { name: "Founders", filter: { signals: ["hiring"], countries: ["GB"], kinds: ["named"], sources: [], verification: ["deliverable"], runs: [] } },
  });
  expect((await form.findByRole("alert")).textContent).toBe("Countries need two-letter codes, such as US or GB.");
  expect(navigate).not.toHaveBeenCalled();
  await userEvent.click(saveButton);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/w/$workspaceId/people/cohorts/$cohortId", params: { workspaceId: W, cohortId: C } }));
  expect(form.queryByRole("alert")).toBeNull();
}, 15_000);

test("the count follows the filter as it changes, after a pause, and saves nothing", async () => {
  serve({ "/api/w/{workspaceId}/prospecting/cohorts": () => ({ cohorts: [] }), "/api/w/{workspaceId}/prospecting/runs": () => ({ runs: [] }) });
  const post = vi.spyOn(api, "POST").mockImplementation(((_: string, o: { body: { filter: { signals: string[]; signalMaxAgeDays?: number } } }) => reply(200, { count: o.body.filter.signalMaxAgeDays ? 7 : o.body.filter.signals.length ? 1234 : 2000 })) as never);
  show(<Cohorts workspaceId={W} role="marketer" />);
  // With no segments yet, the empty state offers New segment as well as the header.
  const empty = await screen.findByText("No segments yet");
  expect(within(empty.parentElement!).getByRole("button", { name: "New segment" })).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "New segment" }).length).toBe(2);
  await userEvent.click(within(empty.parentElement!).getByRole("button", { name: "New segment" }));
  const form = within(await screen.findByRole("form", { name: "New segment" }));
  expect(form.queryByRole("button", { name: "Count matches" })).toBeNull();
  await waitFor(() => expect(ownStatus(screen.getByRole("form", { name: "New segment" })).textContent).toBe("2,000 People match now."), { timeout: 3000 });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/cohorts/count", { params: { path: { workspaceId: W } }, body: { filter: { signals: [], countries: [], kinds: [], sources: [], verification: ["deliverable"], runs: [] } } });
  await userEvent.click(form.getByLabelText("Hiring"));
  await waitFor(() => expect(ownStatus(screen.getByRole("form", { name: "New segment" })).textContent).toBe("1,234 People match now."), { timeout: 3000 });
  expect(form.getByRole("button", { name: "Save segment of 1,234 People" })).toBeTruthy();
  await userEvent.type(await form.findByLabelText("Read in the last (days)"), "60");
  await userEvent.tab();
  // Each key restarts the pause before counting, which a slow machine can stretch past the default wait.
  await waitFor(() => expect(form.getByRole("button", { name: "Save segment of 7 People" })).toBeTruthy(), { timeout: 3000 });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/cohorts/count", expect.objectContaining({ body: { filter: expect.objectContaining({ signals: ["hiring"], signalMaxAgeDays: 60 }) } }));
  // Typing 6 then 0 is one count after the pause, not one per key.
  expect(post.mock.calls.filter((c) => (c[1] as { body: { filter: { signalMaxAgeDays?: number } } }).body.filter.signalMaxAgeDays === 6)).toEqual([]);
  expect(post.mock.calls.every((c) => c[0] === "/api/w/{workspaceId}/prospecting/cohorts/count")).toBe(true);
});

test("a count of 0 under the check filter says how many match with unchecked addresses", async () => {
  serve({ "/api/w/{workspaceId}/prospecting/cohorts": () => ({ cohorts: [] }), "/api/w/{workspaceId}/prospecting/runs": () => ({ runs: [] }) });
  vi.spyOn(api, "POST").mockImplementation(((_: string, o: { body: { filter: { verification: string[] } } }) => reply(200, { count: o.body.filter.verification.length ? 0 : 9 })) as never);
  show(<Cohorts workspaceId={W} role="marketer" />);
  await userEvent.click((await screen.findAllByRole("button", { name: "New segment" }))[0]!);
  await screen.findByRole("form", { name: "New segment" });
  await waitFor(() =>
    expect(ownStatus(screen.getByRole("form", { name: "New segment" })).textContent).toBe(
      "0 People match now. 9 People would match without the check filter: their addresses aren't checked yet, or didn't pass. Change Address quality to include them.",
    ),
  );
});

test("a link that names searches opens the builder first, set to them", async () => {
  const run = { id: ID, source: "search", terms: [], status: "done", companies: 4, confirmedUsd: 5, vendorCostUsd: 1, createdAt: "2026-11-02T10:00:00.000Z" };
  serve({ "/api/w/{workspaceId}/prospecting/cohorts": () => ({ cohorts: [cohort] }), "/api/w/{workspaceId}/prospecting/runs": () => ({ runs: [run] }) });
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, { count: 9 })) as never);
  show(<Cohorts workspaceId={W} role="marketer" />, `/?runs=${ID},${C}`);
  // Preset searches open the builder straight away, so there's no New segment to press.
  const form = await screen.findByRole("form", { name: "New segment" });
  expect(screen.queryByRole("button", { name: "New segment" })).toBeNull();
  // The builder comes before the list of segments.
  expect(form.compareDocumentPosition(await screen.findByRole("link", { name: "Hiring in York" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/prospecting/cohorts/count", { params: { path: { workspaceId: W } }, body: { filter: { ...filter, verification: ["deliverable"], runs: [ID, C] } } }));
  expect(await within(form).findByText(/^Search, 2 Nov, \d\d:\d\d · 4 companies$/)).toBeTruthy();
  expect(within(form).getByText("An earlier search")).toBeTruthy();
  expect(within(form).getByText("checked addresses only · named people and role addresses · any source")).toBeTruthy();
});

test("a Viewer reads cohorts but can't make one", async () => {
  serve({ "/api/w/{workspaceId}/prospecting/cohorts": () => ({ cohorts: [] }) });
  show(<Cohorts workspaceId={W} role="viewer" />);
  expect(await screen.findByText("Viewers can see segments but not change them. Ask an Owner or Admin for a different role.")).toBeTruthy();
  expect(screen.queryByRole("form", { name: "New segment" })).toBeNull();
  expect(screen.queryByRole("button", { name: "New segment" })).toBeNull();
});

test("one cohort lists who it matches, and adds them to a chosen Campaign", async () => {
  serve({ "/api/w/{workspaceId}/prospecting/cohorts/{id}": () => page, "/api/w/{workspaceId}/campaigns": () => ({ campaigns }) });
  let adds = 0;
  const post = vi.spyOn(api, "POST").mockImplementation(((path: string) => {
    if (path.endsWith("/preview")) return reply(200, { added: 1, skipped: [{ reason: "suppressed", count: 2 }] });
    if (path.endsWith("/count")) return reply(200, { count: 3 });
    return adds++ === 0 ? reply(404, { error: "not_found" }) : reply(201, { handoverId: H });
  }) as never);
  const navigate = show(<Cohorts workspaceId={W} role="marketer" id={ID} />);
  const who = within(await screen.findByRole("table", { name: "Who it matches" }));
  expect(screen.getByRole("heading", { name: "The first 2" })).toBeTruthy();
  const ana = who.getByText("ana@shop.test").closest("tr")!;
  expect(within(ana).getByText("Named person, guessed")).toBeTruthy();
  expect(within(ana).getByText("Ana (Founder)")).toBeTruthy();
  expect(within(ana).getByText("Shop, GB")).toBeTruthy();
  const info = who.getByText("info@other.test").closest("tr")!;
  expect(within(info).getByText("odd")).toBeTruthy();
  expect(within(info).getByText("other.test, country not known")).toBeTruthy();
  // Campaigns opens the list until a new Campaign can take a segment.
  expect(screen.getByRole("link", { name: "Go to Campaigns" }).getAttribute("href")).toBe(`/w/${W}/campaigns`);
  expect(screen.queryByText("Start a Campaign for this segment")).toBeNull();
  // Adding happens in a dialog opened from the header, not a section of the page.
  expect(screen.queryByRole("button", { name: "Add to the Campaign" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Add to a Campaign" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add to a Campaign" }));
  expect(dialog.getByText(/Only addresses that check deliverable go over/)).toBeTruthy();
  expect((dialog.getByRole("button", { name: "Add to the Campaign" }) as HTMLButtonElement).disabled).toBe(true);
  // A Campaign's name is text, never markup.
  const options = document.getElementById(dialog.getByRole("combobox").getAttribute("aria-controls")!)!;
  expect(within(options).getByRole("option", { name: "Q4 <i>push</i>" })).toBeTruthy();
  // Only a Campaign whose plan was approved takes People, so a Draft or one awaiting sign-off isn't offered.
  expect(within(options).queryByRole("option", { name: "Spring draft" })).toBeNull();
  expect(within(options).queryByRole("option", { name: "Waiting one" })).toBeNull();
  await choose("Campaign", "Autumn audits");
  // Before anything is added, the preview says what would happen, with the skips by reason.
  expect(await dialog.findByText("About 1 Person would be added, 2 left out.")).toBeTruthy();
  // The button promises the preview's number, not the segment's 3.
  const add = screen.getByRole("button", { name: "Add about 1 Person to Autumn audits" }) as HTMLButtonElement;
  expect(add.disabled).toBe(false);
  expect(screen.getByText("On your Do not contact list: 2")).toBeTruthy();
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/prospecting/cohorts/{id}/add-to-campaign/preview", { params: { path: { workspaceId: W, id: ID } }, body: { campaignId: C } });
  expect(post).not.toHaveBeenCalledWith("/api/w/{workspaceId}/prospecting/cohorts/{id}/add-to-campaign", expect.anything());
  await userEvent.click(add);
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/prospecting/cohorts/{id}/add-to-campaign", { params: { path: { workspaceId: W, id: ID } }, body: { campaignId: C } });
  expect((await screen.findByRole("alert")).textContent).toBe("That Campaign can't take people until its plan is approved. If it was deleted, reload the page.");
  await userEvent.click(add);
  await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: "/w/$workspaceId/people/handovers/$handoverId", params: { workspaceId: W, handoverId: H } }));
});

test("a Campaign the API refuses says its plan must be approved first, and can't be added to", async () => {
  serve({ "/api/w/{workspaceId}/prospecting/cohorts/{id}": () => page, "/api/w/{workspaceId}/campaigns": () => ({ campaigns }) });
  vi.spyOn(api, "POST").mockImplementation(((path: string) => (path.endsWith("/count") ? reply(200, { count: 3 }) : reply(404, { error: "not_found" }))) as never);
  show(<Cohorts workspaceId={W} role="marketer" id={ID} />);
  await userEvent.click(await screen.findByRole("button", { name: "Add to a Campaign" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Add to a Campaign" }));
  await choose("Campaign", "Autumn audits");
  expect(await dialog.findByText("That Campaign can't take people until its plan is approved. If it was deleted, reload the page.")).toBeTruthy();
  expect((dialog.getByRole("button", { name: "Add to Autumn audits" }) as HTMLButtonElement).disabled).toBe(true);
});

test("a cohort larger than a page reads the rest on Show more", async () => {
  const get = vi.spyOn(api, "GET").mockImplementation(((path: string, o: { params: { query?: { cursor?: string } } }) => {
    if (path === "/api/w/{workspaceId}/campaigns") return reply(200, { campaigns });
    if (o.params.query?.cursor === "m2") return reply(200, { ...page, members: [member({ addressId: "a3", email: "cy@third.test" })], next: null });
    return reply(200, { ...page, next: "m2" });
  }) as never);
  show(<Cohorts workspaceId={W} role="marketer" id={ID} />);
  await screen.findByRole("table", { name: "Who it matches" });
  await userEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(await screen.findByText(/cy@third\.test/)).toBeTruthy();
  expect(get).toHaveBeenCalledWith("/api/w/{workspaceId}/prospecting/cohorts/{id}", { params: { path: { workspaceId: W, id: ID }, query: { cursor: "m2" } } });
  expect(screen.getByRole("heading", { name: "Everyone it matches" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

test("when the Campaigns can't be read, Add to Campaign says so instead of No Campaign yet", async () => {
  vi.spyOn(api, "POST").mockImplementation((() => reply(200, { count: 1 })) as never);
  serve({ "/api/w/{workspaceId}/prospecting/cohorts/{id}": () => ({ ...page, members: [member()], count: 1 }) });
  show(<Cohorts workspaceId={W} role="owner" id={ID} />);
  await userEvent.click(await screen.findByRole("button", { name: "Add to a Campaign" }));
  const add = await screen.findByRole("dialog", { name: "Add to a Campaign" });
  expect(await within(add).findByRole("alert")).toBeTruthy();
  expect(within(add).queryByText(/There's no Campaign to add them to yet/)).toBeNull();
});

test("Can email? says Yes only for a checked deliverable address, and why not otherwise", async () => {
  const rows = [
    member(),
    member({ addressId: "a2", email: "b@x.test", verificationResult: null, verifiedAt: null }),
    member({ addressId: "a3", email: "c@x.test", verificationResult: "catch_all" }),
    member({ addressId: "a4", email: "d@x.test", verificationResult: "invalid" }),
    member({ addressId: "a5", email: "e@x.test", verificationResult: "unknown" }),
    member({ addressId: "a6", email: "f@x.test", company: { id: "c6", domain: "x.ca", name: null, country: "CA" } }),
    member({ addressId: "a7", email: "g@x.test", source: "published", company: { id: "c7", domain: "y.ca", name: null, country: "CA" } }),
  ];
  serve({ "/api/w/{workspaceId}/prospecting/cohorts/{id}": () => ({ ...page, members: rows, count: rows.length }) });
  show(<Cohorts workspaceId={W} role="viewer" id={ID} />);
  const table = await screen.findByRole("table", { name: "Who it matches" });
  expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Email", "Person", "Company", "Checked", "Can email?", "Source"]);
  const said = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[4]!.textContent);
  expect(said).toEqual(["Yes", "Not checked yet", "Can't tell", "Not deliverable", "Couldn't be checked", "No, a guessed address in Canada", "Yes"]);
});

test("changing a cohort saves its filter and reads it again", async () => {
  let current = { ...page, members: [member()], count: 1, filter: { ...filter, signals: ["hiring"], countries: ["GB"] } };
  vi.spyOn(api, "POST").mockImplementation((() => reply(200, { count: 1 })) as never);
  const get = serve({ "/api/w/{workspaceId}/prospecting/cohorts/{id}": () => current, "/api/w/{workspaceId}/campaigns": () => ({ campaigns: [] }) });
  const put = vi.spyOn(api, "PUT").mockImplementation((() => {
    current = { ...current, name: "Hiring anywhere", filter: { ...current.filter, countries: [] } };
    return reply(200, current);
  }) as never);
  show(<Cohorts workspaceId={W} role="owner" id={ID} />);
  expect(await screen.findByRole("heading", { name: "Everyone it matches" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Add to a Campaign" }));
  expect(await screen.findByText(/There's no Campaign to add them to yet\./)).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const form = within(screen.getByRole("form", { name: "Change this segment" }));
  expect((form.getByLabelText("Hiring") as HTMLInputElement).checked).toBe(true);
  const name = form.getByLabelText("Name");
  await userEvent.clear(name);
  await userEvent.type(name, "Hiring anywhere");
  await userEvent.click(form.getByRole("button", { name: "Clear all Countries" }));
  await userEvent.click(await form.findByRole("button", { name: "Save segment of 1 Person" }));
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/prospecting/cohorts/{id}", {
    params: { path: { workspaceId: W, id: ID } },
    body: { name: "Hiring anywhere", filter: { signals: ["hiring"], countries: [], kinds: [], sources: [], verification: [], runs: [] } },
  });
  expect(await screen.findByRole("heading", { name: "Hiring anywhere", level: 1 })).toBeTruthy();
  expect((get.mock.calls as unknown[][]).filter((c) => c[0] === "/api/w/{workspaceId}/prospecting/cohorts/{id}").length).toBeGreaterThan(1);
});

test("a Viewer reads one cohort but can't change it", async () => {
  serve({ "/api/w/{workspaceId}/prospecting/cohorts/{id}": () => ({ ...page, count: 0, members: [] }) });
  show(<Cohorts workspaceId={W} role="viewer" id={ID} />);
  expect(await screen.findByText("Viewers can see segments but not change them or add them to a Campaign. Ask an Owner or Admin for a different role.")).toBeTruthy();
  expect(screen.getByLabelText("This segment now").textContent).toBe("People0Checked deliverable2In a Campaign0");
});

test("a running hand-over is checked until done, and Show more reads the next page", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const first = { id: H, cohortId: ID, campaignId: C, cohortName: "Hiring in York", campaignTitle: "Autumn audits", status: "running", createdAt: "2026-11-02T10:00:00.000Z", finishedAt: null, counts: { added: 0, joined: 0, conflict: 0, leftOut: 0 }, results: [], next: null };
    const done = {
      ...first,
      status: "done",
      counts: { added: 1, joined: 0, conflict: 1, leftOut: 0 },
      results: [
        { addressId: "a1", email: "ana@shop.test", status: "added", reason: null, personId: "p1", conflictItemId: null, missing: [] },
        { addressId: "a2", email: "bo@shop.test", status: "conflict", reason: null, personId: "p2", conflictItemId: "i1", missing: [] },
      ],
      next: "cur1",
    };
    let calls = 0;
    const get = vi.spyOn(api, "GET").mockImplementation(((_: string, o: { params: { query: { cursor?: string } } }) => {
      if (o.params.query.cursor === "cur1") return reply(200, { ...done, results: [{ addressId: "a3", email: "cy@shop.test", status: "left_out", reason: "suppressed", personId: null, conflictItemId: null, missing: [] }], next: "cur2" });
      if (o.params.query.cursor === "cur2") return reply(404, { error: "not_found" });
      calls += 1;
      return reply(200, calls === 1 ? first : done);
    }) as never);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    show(<Handover workspaceId={W} id={H} />);
    expect(await screen.findByRole("heading", { name: "Adding Hiring in York to Autumn audits" })).toBeTruthy();
    expect(screen.getByText("No addresses handled yet")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await screen.findByRole("heading", { name: "Added Hiring in York to Autumn audits" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Decide" }).getAttribute("href")).toBe(`/w/${W}/review/i1`);
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText("cy@shop.test")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Left out: on your Do not contact list. (1)" })).toBeTruthy();
    expect(get).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/handovers/{id}", { params: { path: { workspaceId: W, id: H }, query: { cursor: "cur1" } } });
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(get).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/handovers/{id}", { params: { path: { workspaceId: W, id: H }, query: { cursor: "cur2" } } });
    expect(screen.getAllByRole("listitem").length).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});
