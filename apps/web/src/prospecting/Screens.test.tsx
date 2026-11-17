// SPDX-License-Identifier: AGPL-3.0-only
// The prospecting screens load through the query layer: a loading state first, then the data, and an
// error panel with Retry when the read fails.
import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { Cohorts, Handover } from "./Cohorts";
import { Run } from "./Run";
import { CompanyReview } from "./CompanyReview";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const show = (el: ReactElement) => render(withQueries(<RouterContextProvider router={router}>{el}</RouterContextProvider>));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** `path` answers with what `answer` gives; every other read is empty or not found. */
function serve(path: string, answer: () => Promise<unknown>) {
  vi.spyOn(api, "GET").mockImplementation(((p: string) => {
    if (p === path) return answer();
    if (p === "/api/w/{workspaceId}/prospecting/companies") return reply(200, { companies: [], next: null });
    if (p === "/api/w/{workspaceId}/campaigns") return reply(200, { campaigns: [] });
    return reply(404, { error: "not_found" });
  }) as never);
}

const loading = () => expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
const filter = { signals: [], countries: [], kinds: [], sources: [], verification: [], runs: [] };
const cohort = { id: ID, name: "Hiring in York", filter, createdBy: ID, createdAt: "2026-11-02T10:00:00.000Z", updatedAt: "2026-11-02T10:00:00.000Z" };
const run = {
  id: ID,
  terms: ["UK logistics firms", "freight forwarders", "3PL"],
  status: "done",
  confirmedUsd: 5,
  vendorCostUsd: 0,
  createdAt: "2026-11-02T10:00:00.000Z",
  finishedAt: null,
  progress: { companies: 0, readPending: 0, read: 0, notRead: 0, namesPending: 0, namesDone: 0, namesSkipped: 0 },
};
const handover = { id: ID, cohortId: ID, campaignId: ID, cohortName: "Hiring in York", campaignTitle: "Q4", status: "done", failureReason: null, createdAt: "2026-11-02T10:00:00.000Z", finishedAt: null, counts: { added: 3, joined: 0, conflict: 0, leftOut: 1 }, results: [], next: null };

test("a run shows a loading state, then its progress", async () => {
  serve("/api/w/{workspaceId}/prospecting/runs/{id}", () => reply(200, run));
  show(<Run workspaceId={W} role="marketer" id={ID} />);
  loading();
  // Named by what it looked for; how it went sits under the title.
  expect(await screen.findByRole("heading", { name: "UK logistics firms +2 terms" })).toBeTruthy();
  expect(screen.getByText("Search: Finished")).toBeTruthy();
  expect(screen.getByText("No companies yet")).toBeTruthy();
});

test("a missing run says so, with no Retry, which can't bring it back", async () => {
  serve("/api/w/{workspaceId}/prospecting/runs/{id}", () => reply(404, { error: "not_found" }));
  show(<Run workspaceId={W} role="marketer" id={ID} />);
  expect((await screen.findByRole("alert")).textContent).toContain("We couldn't find that search.");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("a company opens into its review on the search's page; A keeps and R rejects, but not while typing", async () => {
  const ITEM = "00000000-0000-4000-8000-0000000000cc";
  const company = { id: ID, domain: "acme.test", website: "https://acme.test/", name: "Acme", country: null, runId: ID, readStatus: "read", readReason: null, namesStatus: "done", namesReason: null, state: "in_review", reviewItemId: ITEM, addresses: [], signals: [] };
  const review = { companyId: ID, domain: "acme.test", website: "https://acme.test/", name: "Acme", country: null, names: { status: "done", reason: null }, signals: [], addresses: [{ id: "a1", email: "kim@acme.test", kind: "named", source: "published", name: "Kim Lee", role: null, pageUrl: "https://acme.test/team", readAt: "2026-11-02T10:00:00.000Z", personId: null, leftOut: null }] };
  vi.spyOn(api, "GET").mockImplementation(((p: string) => {
    if (p === "/api/w/{workspaceId}/prospecting/runs/{id}") return reply(200, { ...run, source: "search", progress: { ...run.progress, companies: 1, read: 1 } });
    if (p === "/api/w/{workspaceId}/prospecting/companies") return reply(200, { companies: [company], next: null });
    if (p === "/api/w/{workspaceId}/items/{id}") return reply(200, { item: { id: ITEM, revision: 2, state: "needs_approval" }, content: review });
    return reply(404, { error: "not_found" });
  }) as never);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, {})) as never);
  show(<Run workspaceId={W} role="marketer" id={ID} />);
  await userEvent.click(await screen.findByRole("button", { name: "Review" }));
  // The named person's address starts ticked.
  expect(await screen.findByRole("button", { name: "Accept and keep 1 address" })).toBeTruthy();
  // A typed into the search box is a letter, not a decision.
  await userEvent.type(screen.getByRole("searchbox", { name: "Search companies" }), "a");
  expect(post).not.toHaveBeenCalled();
  await userEvent.click(document.body);
  await userEvent.keyboard("a");
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: ITEM } }, body: { revision: 2, choice: "0" } });
  // Nothing else waits, so the review closes; open it again and R rejects.
  await userEvent.click(await screen.findByRole("button", { name: "Review" }));
  await screen.findByRole("button", { name: "Reject this company" });
  await userEvent.keyboard("r");
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: ITEM } }, body: { revision: 2, choice: "reject" } });
});

test("the cohort list shows a loading state, then each cohort as a link", async () => {
  serve("/api/w/{workspaceId}/prospecting/cohorts", () => reply(200, { cohorts: [cohort] }));
  show(<Cohorts workspaceId={W} role="viewer" />);
  loading();
  expect((await screen.findByRole("link", { name: "Hiring in York" })).getAttribute("href")).toBe(`/w/${W}/people/cohorts/${ID}`);
});

test("when the cohorts can't be read, the list says so and Retry reads them again", async () => {
  let fail = true;
  serve("/api/w/{workspaceId}/prospecting/cohorts", () => (fail ? reply(403, { error: "forbidden" }) : reply(200, { cohorts: [] })));
  show(<Cohorts workspaceId={W} role="viewer" />);
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No segments yet")).toBeTruthy();
});

test("one cohort shows a loading state, then its count; a missing one says so", async () => {
  serve("/api/w/{workspaceId}/prospecting/cohorts/{id}", () => reply(200, { ...cohort, count: 2, deliverable: 1, inCampaign: 0, usedBy: [], members: [], next: null }));
  show(<Cohorts workspaceId={W} role="marketer" id={ID} />);
  loading();
  expect((await screen.findByLabelText("This segment now")).textContent).toBe("People2Checked deliverable1In a Campaign0");
  cleanup();
  serve("/api/w/{workspaceId}/prospecting/cohorts/{id}", () => reply(404, { error: "not_found" }));
  show(<Cohorts workspaceId={W} role="marketer" id={ID} />);
  expect((await screen.findByRole("alert")).textContent).toContain("We couldn't find that segment.");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("a hand-over shows a loading state, then its counts; a missing one says so, with no Retry", async () => {
  let fail = false;
  serve("/api/w/{workspaceId}/prospecting/handovers/{id}", () => (fail ? reply(404, { error: "not_found" }) : reply(200, handover)));
  show(<Handover workspaceId={W} id={ID} />);
  loading();
  expect((await screen.findByLabelText("So far")).textContent).toBe("Added3Already in Direx0Needs your decision0Left out1");
  // Nothing waits for a decision, so there is no button for one.
  expect(screen.queryByRole("link", { name: /need your decision/ })).toBeNull();
  expect(screen.getByRole("link", { name: "Open the Campaign" }).getAttribute("href")).toBe(`/w/${W}/campaigns/${ID}`);
  cleanup();
  fail = true;
  show(<Handover workspaceId={W} id={ID} />);
  expect((await screen.findByRole("alert")).textContent).toContain("We couldn't find that hand-over.");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

test("with every address unticked, Accept is off and says why; ticking one again clears the reason", async () => {
  serve("/api/w/{workspaceId}/strategy", () => reply(404, { error: "not_found" }));
  const review = { companyId: ID, domain: "acme.test", website: "https://acme.test/", name: "Acme", country: null, names: { status: "done", reason: null }, signals: [], addresses: [{ id: "a1", email: "kim@acme.test", kind: "named", source: "published", name: "Kim Lee", role: null, pageUrl: "https://acme.test/team", readAt: "2026-11-02T10:00:00.000Z", personId: null, leftOut: null }] };
  show(<CompanyReview workspaceId={W} item={{ id: ID, revision: 1, state: "needs_approval" }} review={review as never} role="marketer" onSettle={() => {}} />);
  await userEvent.click(screen.getByRole("checkbox", { name: "kim@acme.test" }));
  const accept = screen.getByRole("button", { name: "Accept and keep 0 addresses" });
  expect(document.getElementById(accept.getAttribute("aria-describedby")!)?.textContent).toBe("Tick an address to keep, or reject this company.");
  await userEvent.click(screen.getByRole("checkbox", { name: "kim@acme.test" }));
  expect(screen.queryByText("Tick an address to keep, or reject this company.")).toBeNull();
});
