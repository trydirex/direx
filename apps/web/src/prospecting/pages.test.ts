// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Smoke test for finding and reviewing companies: what each role sees, every left-out reason in
// words, page text escaped, only web links, and each action calling its endpoint.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { beforeAll, expect, test, vi } from "vitest";
import { loadLaterFields } from "@/testing";
import { api } from "../client";
import { buttons, withQueries, withoutButtons, selectOptions } from "../testing";
import type { Item } from "../items/actions";
import { ItemPanel } from "../items/ItemPanel";
import { addToCampaign, checkAgain, companiesOf, draftTerms, droppedWords, estimate, keep, latestTerms, loadCohort, loadHandover, loadRun, filterChips, newFilter, presetRuns, reject, safeHref, saveCohort, saySearch, startPasted, startSearch, usdUp, type CohortPage, type Estimate, type ProposedTerms, type Company, type Handover as HandoverData, type Review, type Run as RunData } from "./actions";
import { Cohorts, Handover } from "./Cohorts";
import { CompanyReview } from "./CompanyReview";
import { Find, type SearchState } from "./Find";
import { Run } from "./Run";

// The date, time, number and file fields load on first use; a page rendered to a string shows them only once loaded.
beforeAll(loadLaterFields);

const W = "00000000-0000-4000-8000-0000000000aa";
const RUN = "00000000-0000-4000-8000-0000000000bb";
const OLD = "00000000-0000-4000-8000-0000000000cc";
// Screens link with the router and load through the query layer, so each render gets both.
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const html = (el: Parameters<typeof renderToString>[0]) => renderToString(withQueries(createElement(RouterContextProvider, { router, children: el }))).replaceAll("<!-- -->", "");

test("the find screen takes a pasted list, says honestly what the amount bounds, and shows no search box", () => {
  const page = html(createElement(Find, { workspaceId: W, role: "marketer" }));
  expect(page).toContain('name="websites"');
  expect(page).toContain("Hiring");
  expect(page).toContain("Blog not updated in 6 months");
  // A pasted list can't be stopped at an amount, so it has no limit field, and says so.
  expect(page).not.toContain('name="amount"');
  expect(page).toContain("Pasted websites have no spend limit: Direx reads every new company you paste, at most 200.");
  expect(page).not.toContain('type="search"');
  expect(html(createElement(Find, { workspaceId: W, role: "viewer" }))).not.toContain("Read these companies");
});

test("each pasted line says what happened, and a known company links to its run", () => {
  const results = [
    { line: 1, website: "acme.test", ok: true, companyId: "00000000-0000-4000-8000-000000000001", runId: RUN },
    { line: 2, website: "<script>x</script>", ok: false, reason: "invalid_website" as const },
    { line: 3, website: "www.acme.test", ok: false, reason: "duplicate" as const, sameAs: 1 },
    { line: 4, website: "beta.test", ok: false, reason: "already_known" as const, runId: OLD },
  ];
  const page = html(createElement(Find, { workspaceId: W, role: "marketer", initial: { runId: RUN, results } }));
  expect(page).toContain("added to this search");
  expect(page).toContain("not a website Direx can read");
  expect(page).toContain("same company as acme.test");
  expect(page).not.toContain("Line 1");
  expect(page).toContain(`/w/${W}/people/find/${OLD}`);
  expect(page).toContain("&lt;script&gt;");
  expect(page).not.toContain("<script>");
});

const proposed: ProposedTerms = { runId: RUN, terms: ["dentists in Leeds", "<b>clinics</b> in York"], objective: "More <i>bookings</i>", dropped: 2, proposedAt: "2026-11-02T10:00:00.000Z" };
const est: Estimate = { searchUsd: 1.5, namesUsd: 25, verifyUsd: 2, totalUsd: 28.5, limit: 25, namesFree: false, defaults: { namesUsdPerCompany: 1, verifyUsdPerAddress: 0.02, addressesPerCompany: 4 } };
const findPage = (search: SearchState, role: "marketer" | "contributor" | "viewer" = "marketer") => html(createElement(Find, { workspaceId: W, role, search }));

test("without a search installed the screen says so and offers only the pasted list", () => {
  const page = findPage({ available: false });
  expect(page).toContain("Searching for companies isn&#x27;t available here, so paste their websites.");
  expect(page).not.toContain("Draft terms from the Strategy");
  expect(page).not.toContain('name="terms"');
  expect(page).not.toContain("Work out the cost");
  expect(page).toContain('name="websites"');
  expect(page).toContain("Read these companies");
  expect(findPage({ available: true })).not.toContain("isn&#x27;t available here");
});

test("drafted terms fill the editable box, with the objective and how many were left out for holding Person data", () => {
  const page = findPage({ available: true, proposed });
  expect(page).toContain("Draft terms from the Strategy");
  // Astryx's Textarea shows the terms, and a hidden field carries them under the name "terms".
  expect(page).toMatch(/<textarea[^>]*>dentists in Leeds\n&lt;b&gt;clinics&lt;\/b&gt; in York<\/textarea>/);
  expect(page).toContain('name="terms"');
  expect(page).toContain("Objective: More &lt;i&gt;bookings&lt;/i&gt;");
  expect(page).toContain("2 terms were left out because they named a person or held an address.");
  expect(page).not.toContain("<b>clinics");
  expect(page).toContain("at most 20");
  expect(page).toContain('max="200"');
  expect(droppedWords({ dropped: 1, objective: null })).toBe("1 term was left out because it named a person or held an address. The objective was left out because it named a person or held an address.");
  expect(droppedWords({ dropped: 0, objective: "x" })).toBe("");
});

test("the cost is broken down, names and checking are called worst-case bounds, and the amount starts at the total", () => {
  const page = findPage({ available: true, proposed, estimate: est });
  expect(page).toContain("Search: $1.50");
  expect(page).toContain("Reading names, at most: $25.00 (25 companies at up to $1.00 each)");
  expect(page).toContain("Checking addresses, at most: $2.00 (up to 4 addresses a company at $0.02 each)");
  expect(page).toContain("Total, at most: $28.50");
  expect(page).toContain("Reading names and checking addresses are worst-case bounds");
  expect(page).toMatch(/name="confirmed"[^>]*value="28.50"/);
  expect(page).toContain("Search 25 companies · up to $28.50");
  expect(page).toContain("Direx&#x27;s estimate: about $28.50 for 25 companies.");
  expect(page).toContain("<summary");
  expect(page).toContain("How the estimate is made");
  expect(page).toContain("Spend up to, in US dollars");
  expect(findPage({ available: true, proposed })).not.toContain("Search 25 companies");
});

test("an upper bound rounds up to the cent, so the amount filled in covers the whole estimate", () => {
  const tiny = { ...est, searchUsd: 0.004, totalUsd: 10.804 };
  const page = findPage({ available: true, proposed, estimate: tiny });
  expect(page).toContain("Search: $0.01");
  expect(page).toContain("Total, at most: $10.81");
  expect(page).toMatch(/name="confirmed"[^>]*value="10.81"/);
  expect(usdUp(10.8)).toBe("$10.80");
});

test("search refusals are said in words", () => {
  expect(saySearch({ error: "no_strategy" })).toContain("Approve a Strategy");
  expect(saySearch({ error: "person_data", terms: ["Kim Lee", "kim@acme.test"] })).toBe("These terms look like they name a person or hold an address, so they can't be searched. Change or remove them: Kim Lee; kim@acme.test.");
  expect(saySearch({ error: "below_estimate", usd: 1.5 })).toBe("The search alone is estimated at $1.50. Set the spend limit to at least that.");
  expect(saySearch({ error: "not_available" })).toContain("isn't available here");
  expect(saySearch({ error: "no_route" })).toContain("write them yourself");
  expect(saySearch({ error: "something_new" })).toBe("That didn't go through. Try again.");
  const page = findPage({ available: true, note: saySearch({ error: "person_data", terms: ["<script>x</script>"] }) });
  expect(page).toContain('role="alert"');
  expect(page).toContain("&lt;script&gt;x&lt;/script&gt;");
  expect(page).not.toContain("<script>");
});

test("after a search each company says what happened, a known one links to its run, and the run can be followed", () => {
  const found: SearchState["found"] = {
    runId: RUN,
    status: "stopped",
    searchUsd: 1.5,
    results: [
      { domain: "acme.test", name: "<img src=x>Acme", ok: true, companyId: "00000000-0000-4000-8000-000000000001", runId: RUN },
      { domain: "beta.test", name: null, ok: false, reason: "already_known", runId: OLD },
      { domain: "gamma.test", name: "Gamma", ok: false, reason: "over_amount" },
    ],
  };
  const page = findPage({ available: true, found });
  expect(page).toContain(`/w/${W}/people/find/${RUN}">Open this search`);
  expect(page).toContain("&lt;img src=x&gt;Acme (acme.test): added to this search");
  expect(page).not.toContain("<img");
  expect(page).toContain("beta.test: already known, so it isn&#x27;t read or charged again");
  expect(page).toContain(`/w/${W}/people/find/${OLD}">See the search that found it`);
  expect(page).toContain("Gamma (gamma.test): left over, because the spend limit ran out before it could be read");
  expect(page).toContain("The search is counted at $1.50. The spend limit ran out, so some companies were left over.");
});

test("viewers see neither form, contributors may draft and price terms but not search, marketers may do both", () => {
  const viewer = findPage({ available: true, proposed, estimate: est }, "viewer");
  expect(viewer).not.toContain("<form");
  expect(viewer).not.toContain("Draft terms from the Strategy");
  const contributor = findPage({ available: true, proposed, estimate: est }, "contributor");
  expect(contributor).toContain("Draft terms from the Strategy");
  expect(contributor).toContain("Work out the cost");
  expect(contributor).toContain("Ask an Owner, Admin or Marketer to start the search.");
  expect(contributor).not.toContain("Search 25 companies");
  expect(contributor).not.toContain("Read these companies");
  const marketer = findPage({ available: true, proposed, estimate: est });
  expect(marketer).toContain("Search 25 companies · up to $28.50");
  expect(marketer).toContain("Read these companies");
});

test("the search calls reach their endpoints and pass refusals through", async () => {
  const body = { terms: ["dentists in Leeds"], limit: 25, signals: ["hiring" as const] };
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { runId: RUN } } as never);
  expect(await draftTerms(W)).toEqual({ ok: true, runId: RUN });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/terms", { params: { path: { workspaceId: W } } });
  post.mockResolvedValue({ error: { error: "no_strategy" } } as never);
  expect(await draftTerms(W)).toEqual({ ok: false, error: "no_strategy", terms: undefined, usd: undefined });

  post.mockResolvedValue({ data: est } as never);
  expect(await estimate(W, body)).toEqual({ ok: true, estimate: est });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/estimate", { params: { path: { workspaceId: W } }, body });
  post.mockResolvedValue({ error: { error: "not_available" } } as never);
  expect(await estimate(W, body)).toMatchObject({ ok: false, error: "not_available" });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/estimate", { params: { path: { workspaceId: W } }, body });
  post.mockResolvedValue({ error: { error: "forbidden" } } as never);
  expect(await estimate(W, body)).toMatchObject({ ok: false, error: "forbidden" });
  post.mockResolvedValue({ error: undefined } as never);
  expect(await estimate(W, body)).toMatchObject({ ok: false, error: "failed" });

  post.mockResolvedValue({ data: { runId: RUN, status: "done", searchUsd: 1.5, results: [] } } as never);
  expect(await startSearch(W, { ...body, confirmedUsd: 30 })).toEqual({ ok: true, runId: RUN, status: "done", searchUsd: 1.5, results: [] });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/runs", { params: { path: { workspaceId: W } }, body: { ...body, confirmedUsd: 30 } });
  post.mockResolvedValue({ error: { error: "below_estimate", usd: 1.5 } } as never);
  expect(await startSearch(W, { ...body, confirmedUsd: 1 })).toEqual({ ok: false, error: "below_estimate", terms: undefined, usd: 1.5 });
  post.mockResolvedValue({ error: { error: "person_data", terms: ["Kim Lee"] } } as never);
  expect(await estimate(W, body)).toEqual({ ok: false, error: "person_data", terms: ["Kim Lee"], usd: undefined });

  const get = vi.spyOn(api, "GET").mockResolvedValue({ data: { proposed }, response: new Response() } as never);
  expect(await latestTerms(W)).toEqual(proposed);
  expect(get).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/terms", { params: { path: { workspaceId: W } } });
  get.mockResolvedValue({ data: { proposed: null }, response: new Response() } as never);
  expect(await latestTerms(W)).toBeNull();
  vi.restoreAllMocks();
});

const run: RunData = {
  id: RUN,
  source: "pasted",
  terms: [],
  status: "running",
  signals: ["hiring"],
  confirmedUsd: 5,
  vendorCostUsd: 0,
  confirmedBy: "00000000-0000-4000-8000-0000000000dd",
  createdAt: "2026-11-02T10:00:00.000Z",
  finishedAt: null,
  progress: { companies: 2, readPending: 0, read: 1, notRead: 1, namesPending: 0, namesDone: 1, namesSkipped: 1 },
  unchecked: 0,
};
const company = (o: Partial<Company>): Company => ({
  id: crypto.randomUUID(),
  domain: "acme.test",
  website: "https://acme.test/",
  name: null,
  country: null,
  runId: RUN,
  readStatus: "read",
  readReason: null,
  namesStatus: "done",
  namesReason: null,
  state: "in_review",
  reviewItemId: null,
  addresses: [],
  signals: [],
  ...o,
});

test("a run shows progress and every company with why anything was left out", () => {
  const companies = [
    company({ name: "<b>Acme</b>", addresses: [{ email: "info@acme.test", kind: "generic", leftOutReason: "generic_address" }, { email: "kim@acme.test", kind: "named", leftOutReason: null }] }),
    company({ domain: "shy.test", readStatus: "not_read", readReason: "robots_txt", namesStatus: "skipped", namesReason: "site_not_read", state: "new" }),
  ];
  const page = html(createElement(Run, { workspaceId: W, id: RUN, role: "marketer", initial: { run, companies } }));
  expect(page).toContain("1 read, 1 not read");
  expect(page).toContain("2 of 2 companies read");
  // Counts as chips, and the main action opens the first company waiting for review.
  expect(page).toMatch(/<dt[^>]*>Found<\/dt><dd[^>]*>2<\/dd>/);
  expect(page).toMatch(/<dt[^>]*>Waiting for you<\/dt><dd[^>]*>1<\/dd>/);
  expect(page).toMatch(/<dt[^>]*>Kept<\/dt><dd[^>]*>0<\/dd>/);
  expect(page).toContain("Review 1 company");
  expect(page).toContain("2 addresses");
  expect(page).toContain("Not read: its robots.txt asks readers like Direx to stay away");
  expect(page).toContain("Names not read: the site wasn&#x27;t read");
  expect(page).toContain("info@acme.test (Shared inbox) left out: it&#x27;s a shared inbox");
  expect(page).toContain("Review it in Needs you");
  // A company with its review Item links straight to it in Review.
  expect(html(createElement(Run, { workspaceId: W, id: RUN, role: "marketer", initial: { run, companies: [company({ reviewItemId: "00000000-0000-4000-8000-0000000000e1" })] } }))).toContain(`href="/w/${W}/review/00000000-0000-4000-8000-0000000000e1"`);
  expect(page).toContain("&lt;b&gt;Acme&lt;/b&gt;");
  expect(page).toContain("isn&#x27;t counted here yet");
  // A pasted list has no limit, only Direx's estimate.
  expect(page).toContain("Direx estimated about $5.00. Pasted websites have no spend limit.");
  expect(page).not.toContain("Check again");
  // The review states are the filters, each with its count.
  for (const chip of ["All 2", "Waiting for you 1", "Kept 0", "Rejected 0", "Couldn&#x27;t read 1"]) expect(buttons(page, chip)).toHaveLength(1);
  // Nothing kept yet, so there is no segment to make.
  expect(page).not.toContain("Make a segment");
});

test("a search's companies show their Signals, open into a review in place, and the kept ones become a segment", () => {
  const signals = [{ type: "hiring", quote: "<b>We're hiring</b> a bookkeeper", pageUrl: "https://acme.test/careers", observedOn: "2026-11-02" }];
  const companies = [
    company({ name: "Acme", signals, reviewItemId: "00000000-0000-4000-8000-0000000000e1" }),
    company({ domain: "kept.test", state: "accepted" }),
    company({ domain: "gone.test", state: "rejected" }),
  ];
  const page = html(createElement(Run, { workspaceId: W, id: RUN, role: "marketer", initial: { run, companies } }));
  expect(page).toContain("Hiring</span>: <q>&lt;b&gt;We&#x27;re hiring&lt;/b&gt; a bookkeeper</q>");
  expect(page).toContain('href="https://acme.test/careers"');
  expect(page).toContain("read 2026-11-02");
  expect(buttons(page, "Review")).toHaveLength(1);
  expect(page).toContain("press A to keep it or R to reject it");
  expect(page).toContain("Review 1 company in Needs you");
  expect(page).toContain("You kept 1 company.");
  expect(page).toContain(`href="/w/${W}/people/cohorts?runs=${RUN}"`);
  expect(page).toContain("Make a segment from the 1 kept company");
  // A viewer can't decide or make segments, so neither is offered.
  const viewer = html(createElement(Run, { workspaceId: W, id: RUN, role: "viewer", initial: { run, companies } }));
  expect(viewer).not.toContain("Make a segment");
  expect(viewer).not.toContain("press A");
  // A search's amount is a limit.
  expect(html(createElement(Run, { workspaceId: W, id: RUN, role: "marketer", initial: { run: { ...run, source: "search" }, companies } }))).toContain("Spend up to $5.00.");
});

test("a run with unanswered addresses says so and offers Check again, which calls its endpoint", async () => {
  const page = html(createElement(Run, { workspaceId: W, id: RUN, role: "marketer", initial: { run: { ...run, unchecked: 3 }, companies: [] } }));
  expect(page).toContain("3 email addresses couldn&#x27;t be verified because your verification credits ran out");
  expect(page).toContain("Check again");
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { queued: 2 }, response: new Response(null, { status: 202 }) } as never);
  expect(await checkAgain(W, RUN)).toEqual({ queued: 2 });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/runs/{id}/check-again", { params: { path: { workspaceId: W, id: RUN } } });
  vi.restoreAllMocks();
});

const review: Review = {
  companyId: "00000000-0000-4000-8000-000000000003",
  domain: "acme.test",
  website: "javascript:alert(1)",
  name: "<img src=x onerror=alert(1)>",
  country: { code: "CA", quote: "Toronto, <i>ON</i>" },
  names: { status: "done", reason: null },
  signals: [{ type: "hiring", quote: "<script>steal()</script> We're hiring", pageUrl: "https://acme.test/careers", observedOn: "2026-11-02" }],
  addresses: [
    { id: "a1", email: "kim@acme.test", kind: "named", source: "published", name: "Kim Lee", role: "CEO", pageUrl: "https://acme.test/team", readAt: "2026-11-02T10:00:00.000Z", personId: null, leftOut: null },
    { id: "a2", email: "info@other.test", kind: "generic", source: "published", name: null, role: null, pageUrl: "data:text/html,x", readAt: "2026-11-02T10:00:00.000Z", personId: null, leftOut: "other_domain" },
  ],
};
const item = { id: "00000000-0000-4000-8000-000000000004", revision: 3, state: "needs_approval" as const };
const reviewPage = (role: "marketer" | "viewer" = "marketer") => html(createElement(CompanyReview, { workspaceId: W, item, review, role, onSettle: () => {} }));

test("page text on a review is escaped and only web addresses become links", () => {
  const page = reviewPage();
  expect(page).not.toContain("<script>");
  expect(page).not.toContain("<img");
  expect(page).not.toContain("<i>ON");
  expect(page).toContain("&lt;script&gt;steal()&lt;/script&gt;");
  expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
  expect(page).not.toContain("javascript:");
  expect(page).not.toContain("data:text");
  expect(page).toContain('href="https://acme.test/careers" target="_blank" rel="noopener noreferrer"');
  expect(page).toContain("Toronto, &lt;i&gt;ON&lt;/i&gt;");
  // The country by its name, not its code.
  expect(page).toContain("Country: Canada");
  expect(safeHref("https://a.test/x")).toBe("https://a.test/x");
  expect(safeHref("javascript:alert(1)")).toBeUndefined();
  expect(safeHref("not a url")).toBeUndefined();
});

test("a review shows each address's kind, source, name and role, and a left-out one can't be picked", () => {
  const page = reviewPage();
  expect(page).toContain("Named person, published, Kim Lee (CEO)");
  expect(page).toContain("Left out: it&#x27;s on another domain than the company&#x27;s.");
  const boxes = [...page.matchAll(/<input type="checkbox"[^>]*>/g)].map((m) => m[0]);
  expect(boxes).toHaveLength(2);
  expect(boxes[0]).not.toContain("disabled");
  expect(boxes[1]).toContain("disabled");
  // A named person's address starts ticked; a left-out one never is.
  expect(boxes[0]).toContain('checked=""');
  expect(boxes[1]).not.toContain('checked=""');
  expect(buttons(page, "Accept and keep 1 address")).toHaveLength(1);
  expect(page).toContain("Reject this company");
  expect(page).not.toContain("Dismiss");
  expect(reviewPage("viewer")).not.toContain("Reject this company");
});

test("a review lists the people Direx would guess for, and with none kept Accept only guesses for them", async () => {
  const leftOutOnly = { ...review, addresses: [review.addresses[1]!] };
  const withPeople = html(createElement(CompanyReview, { workspaceId: W, item, review: { ...leftOutOnly, guessFor: [{ name: "Dan Lee", role: "Owner" }] }, role: "marketer", onSettle: () => {} }));
  expect(withPeople).toContain("Dan Lee (Owner)");
  expect(buttons(withPeople, "Accept and guess addresses for 1 person")).toEqual([expect.not.stringMatching(/ disabled=""/)]);
  // An older review has no people listed, so nothing kept leaves Accept off.
  const none = html(createElement(CompanyReview, { workspaceId: W, item, review: leftOutOnly, role: "marketer", onSettle: () => {} }));
  expect(buttons(none, "Accept and keep 0 addresses")).toEqual([expect.stringMatching(/ disabled=""/)]);
  // A disabled Accept says why, and the button points at the reason.
  expect(none).toContain("No address here can be kept, so reject this company.");
  expect(buttons(none, "Accept and keep 0 addresses")[0]).toMatch(/aria-describedby="/);
  expect(withPeople).not.toContain("so reject this company");
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: {} } as never);
  expect(await keep(W, item, [])).toBeNull();
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: item.id } }, body: { revision: 3, choice: "none" } });
  post.mockRestore();
});

test("in the Item panel a company review offers Accept and Reject, not Dismiss or a bare Accept", () => {
  const full: Item = { ...item, kind: "company_review", reason: null, reasonCode: null, title: "Review Acme", workArea: "prospecting", channel: "email", groupKey: null, groupLabel: null, at: null, warnings: [{ code: "untrusted_source", text: "Read from the company's own website" }], clean: false, movable: false, decideBy: null, snoozedUntil: null, createdAt: "2026-11-02T10:00:00.000Z" };
  const page = html(createElement(ItemPanel, { workspaceId: W, id: item.id, role: "marketer", onChange: () => {}, onClose: () => {}, initial: { item: full, content: review, timeline: [], ruleGrantedBy: null } }));
  expect(page).toContain("Reject this company");
  expect(page).toContain("Accept and keep");
  expect(page).not.toContain("Dismiss");
  expect(page).not.toContain("<pre");
  expect(buttons(page, "Accept")).toHaveLength(0);
});

test("each action calls its endpoint with the right choice", async () => {
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { runId: RUN, results: [] } } as never);
  expect(await startPasted(W, { websites: ["acme.test"], signals: ["hiring"], confirmedUsd: 5 })).toEqual({ ok: true, runId: RUN, results: [] });
  expect(post.mock.calls[0]![0]).toBe("/api/w/{workspaceId}/prospecting/runs/pasted");
  post.mockResolvedValue({ data: {} } as never);
  expect(await keep(W, item, [0, 2])).toBeNull();
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: item.id } }, body: { revision: 3, choice: "0,2" } });
  expect(await reject(W, item)).toBeNull();
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: item.id } }, body: { revision: 3, choice: "reject" } });
  post.mockResolvedValue({ error: { error: "too_many", max: 200 } } as never);
  expect(await startPasted(W, { websites: ["a.test"], signals: [], confirmedUsd: 0 })).toEqual({ ok: false, error: "too_many", max: 200 });

  const get = vi
    .spyOn(api, "GET")
    .mockResolvedValueOnce({ data: { companies: [company({ id: "c1" }), company({ id: "c2" })], next: "00000000-0000-4000-8000-000000000009" } } as never)
    .mockResolvedValueOnce({ data: { companies: [company({ id: "c3" })], next: null } } as never);
  expect((await companiesOf(W, RUN)).map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
  expect(get).toHaveBeenCalledTimes(2);
  // The run is filtered by the API, and the second page carries the first page's cursor.
  expect(get.mock.calls[0]![1]).toEqual({ params: { path: { workspaceId: W }, query: { runId: RUN, cursor: undefined } } });
  expect(get.mock.calls[1]![1]).toEqual({ params: { path: { workspaceId: W }, query: { runId: RUN, cursor: "00000000-0000-4000-8000-000000000009" } } });
  vi.restoreAllMocks();
});

const COHORT = "00000000-0000-4000-8000-0000000000ee";
const CAMPAIGN = "00000000-0000-4000-8000-0000000000ff";
const filter = { signals: ["hiring"], countries: ["CA", "US"], kinds: ["named"], sources: ["guessed"], verification: ["deliverable"], runs: [RUN], signalMaxAgeDays: 60 };
const member = (o: Partial<CohortPage["members"][number]>): CohortPage["members"][number] => ({
  addressId: crypto.randomUUID(),
  email: "kim@acme.test",
  kind: "named",
  name: "Kim Lee",
  role: "CEO",
  source: "published",
  pattern: null,
  verificationResult: "deliverable",
  verifiedAt: "2026-11-01T09:00:00.000Z",
  company: { id: "00000000-0000-4000-8000-000000000001", domain: "acme.test", name: "Acme", country: "US" },
  evidence: { pageUrl: "https://acme.test/team", readAt: "2026-11-01T08:00:00.000Z", snapshotId: "00000000-0000-4000-8000-000000000002" },
  ...o,
});
const cohort: CohortPage = {
  id: COHORT,
  name: "<b>Hiring</b> in North America",
  filter,
  createdBy: "00000000-0000-4000-8000-0000000000dd",
  createdAt: "2026-11-02T10:00:00.000Z",
  updatedAt: "2026-11-02T10:00:00.000Z",
  count: 1234,
  deliverable: 1000,
  inCampaign: 42,
  usedBy: [{ campaignId: CAMPAIGN, title: "Q4 <i>push</i>", people: 42, lastAddedAt: "2026-11-03T09:00:00.000Z" }],
  members: [
    member({}),
    member({ email: "sam@beta.test", name: "<script>x()</script>", source: "guessed", pattern: "first", verificationResult: "catch_all", verifiedAt: null, company: { id: "00000000-0000-4000-8000-000000000005", domain: "beta.test", name: null, country: null }, evidence: { pageUrl: "javascript:alert(1)", readAt: "2026-11-01T08:00:00.000Z", snapshotId: "00000000-0000-4000-8000-000000000006" } }),
    member({ email: "sales@gamma.test", kind: "function", name: null, role: null, verificationResult: null, verifiedAt: null }),
  ],
  next: "00000000-0000-4000-8000-000000000007",
};
const campaigns = [{ id: CAMPAIGN, planId: "00000000-0000-4000-8000-000000000008", title: "Q4 <i>push</i>", ownerUserId: "00000000-0000-4000-8000-0000000000dd", draftingMode: "per_person", paused: false, status: "no_launch_date" as const, changesWaiting: false, goal: null, startsOn: null, launchOn: null, endsOn: null, planned: 0, done: 0, sent: 0, replied: 0, needApproval: 0, measure: null, channels: [] }];
const cohortEl = (role: "marketer" | "contributor" | "viewer" = "marketer") => withQueries(createElement(RouterContextProvider, { router, children: createElement(Cohorts, { workspaceId: W, role, id: COHORT, initial: { cohort, campaigns } }) }));
const cohortPage = (role: "marketer" | "contributor" | "viewer" = "marketer") => html(createElement(Cohorts, { workspaceId: W, role, id: COHORT, initial: { cohort, campaigns } }));

test("a cohort shows its numbers, its filter as chips, and its first page, each with kind, a guessed label, its check and company", () => {
  const page = cohortPage();
  expect(page).toMatch(/<h1[^>]*>&lt;b&gt;Hiring&lt;\/b&gt; in North America<\/h1>/);
  expect(page).toMatch(/<dt[^>]*>People<\/dt><dd[^>]*>1,234<\/dd>/);
  expect(page).toMatch(/<dt[^>]*>Checked deliverable<\/dt><dd[^>]*>1,000<\/dd>/);
  expect(page).toMatch(/<dt[^>]*>In a Campaign<\/dt><dd[^>]*>42<\/dd>/);
  expect(page).toContain("The first 3");
  // One row per address: who, their company, the check and where it was found.
  expect(page).toMatch(/<th[^>]*>Email<\/th><th[^>]*>Person<\/th><th[^>]*>Company<\/th><th[^>]*>Checked<\/th><th[^>]*>Can email\?<\/th><th[^>]*>Source<\/th>/);
  expect(page).toContain("kim@acme.test");
  expect(page).toContain("Kim Lee (CEO)");
  expect(page).toContain("Deliverable, checked 2026-11-01");
  expect(page).toContain("Acme, US");
  expect(page).toContain("Named person, guessed");
  expect(page).toContain("Can&#x27;t tell, the domain accepts every address");
  expect(page).toContain("beta.test, country not known");
  expect(page).toContain("sales@gamma.test");
  expect(page).toContain("Role address");
  expect(page).toContain("Not checked yet");
  for (const chip of ["Hiring, read in the last 60 days", "Country: Canada or United States", "Found by 1 search", "Named person", "Guessed", "Checked addresses"]) expect(page).toContain(`>${chip}</li>`);
});

test("a cohort lists the Campaigns it was handed to, and offers a new one", () => {
  const page = cohortPage();
  expect(page).toMatch(new RegExp(`href="/w/${W}/campaigns/${CAMPAIGN}"[^>]*>Q4 &lt;i&gt;push&lt;/i&gt;</a>`));
  // A date as people read it, in their locale, not an ISO string.
  expect(page).toMatch(/42 People added, last on (3 Nov|Nov 3)</);
  expect(page).toMatch(new RegExp(`href="/w/${W}/campaigns"[^>]*>Go to Campaigns</a>`));
  expect(page).not.toContain('href="#add-to-campaign"');
  expect(cohortPage("viewer")).not.toContain("Go to Campaigns");
  expect(html(createElement(Cohorts, { workspaceId: W, role: "viewer", id: COHORT, initial: { cohort: { ...cohort, usedBy: [] } } }))).toContain("Not in a Campaign yet.");
});

test("Add to Campaign says plainly who goes over, never promises the segment's size, and viewers only read", () => {
  const page = cohortPage("contributor");
  // The Campaign choice and its preview wait in a closed dialog, opened from the header (Cohorts.test.tsx).
  expect(page).toMatch(/<dialog[^>]*>[\s\S]*Only addresses that check deliverable go over/);
  expect(page).toContain("you&#x27;ll see what happened to each one");
  expect(buttons(page, "Add to a Campaign")).toHaveLength(1);
  // Closed, the dialog offers no Campaign select; a Campaign's name as text is checked there.
  expect(selectOptions(cohortEl("contributor")).Campaign).toBeUndefined();
  expect(buttons(page, "Add to the Campaign")).toEqual([expect.stringMatching(/ disabled=""/)]);
  expect(page).not.toContain("Add 1,234");
  expect(page).toContain("Save segment");
  const viewer = cohortPage("viewer");
  expect(viewer).not.toContain("Add to the Campaign");
  expect(viewer).not.toContain("<form");
  expect(viewer).toContain("can see segments but not change them");
  expect(html(createElement(Cohorts, { workspaceId: W, role: "viewer", initial: { cohorts: [cohort] } }))).not.toContain("<form");
});

test("page text on a cohort is escaped and only web addresses become links", () => {
  const page = cohortPage();
  expect(page).toContain("&lt;b&gt;Hiring&lt;/b&gt;");
  expect(page).toContain("&lt;script&gt;x()&lt;/script&gt;");
  expect(page).not.toContain("<script>");
  expect(page).not.toContain("<b>Hiring");
  expect(page).not.toContain("javascript:");
  expect(page).toContain('href="https://acme.test/team" target="_blank" rel="noopener noreferrer"');
});

test("a new segment starts from checked addresses and any searches a link names; the edit form starts from the saved one", async () => {
  const a = "00000000-0000-4000-8000-0000000000a1";
  const b = "00000000-0000-4000-8000-0000000000b2";
  expect(newFilter()).toEqual({ signals: [], countries: [], kinds: [], sources: [], verification: ["deliverable"], runs: [] });
  expect(newFilter([a])).toMatchObject({ runs: [a] });
  expect(presetRuns(`?runs=${a},${b.toUpperCase()},${a}`)).toEqual([a, b]);
  expect(presetRuns(`?runs=${encodeURIComponent(JSON.stringify([a]))}`)).toEqual([a]);
  expect(presetRuns("?runs=not-a-search")).toEqual([]);
  expect(presetRuns("")).toEqual([]);
  expect(filterChips(newFilter())).toEqual(["Checked addresses"]);
  expect(filterChips({ ...newFilter(), verification: [] })).toEqual(["Every kept address"]);
  expect(filterChips({ ...newFilter([a, b]), verification: ["invalid", "unknown"], signalMaxAgeDays: 1 })).toEqual(["Any Signal read in the last 1 day", "Found by 2 searches", "Check: Not deliverable or Couldn't be checked"]);

  const boxes = [...cohortPage().matchAll(/<label[^>]*><input type="checkbox"[^>]*?( checked="")?\/> ([^<]+)<\/label>/g)].filter((m) => m[1]).map((m) => m[2]);
  expect(boxes).toEqual(["Hiring", "Named person", "Guessed", "Deliverable"]);
  expect(cohortPage()).toMatch(/value="60"/);

  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { id: COHORT } } as never);
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: { id: COHORT } } as never);
  expect(await saveCohort(W, { name: "N", filter })).toEqual({ ok: true, cohort: { id: COHORT } });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/cohorts", { params: { path: { workspaceId: W } }, body: { name: "N", filter } });
  await saveCohort(W, { name: "N", filter }, COHORT);
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/cohorts/{id}", { params: { path: { workspaceId: W, id: COHORT } }, body: { name: "N", filter } });
  put.mockResolvedValue({ error: { error: "unknown_value", field: "countries", value: "X" } } as never);
  expect(await saveCohort(W, { name: "N", filter }, COHORT)).toEqual({ ok: false, error: "unknown_value", field: "countries" });

  post.mockResolvedValue({ data: { handoverId: OLD } } as never);
  expect(await addToCampaign(W, COHORT, CAMPAIGN)).toEqual({ ok: true, handoverId: OLD });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/cohorts/{id}/add-to-campaign", { params: { path: { workspaceId: W, id: COHORT } }, body: { campaignId: CAMPAIGN } });
  post.mockResolvedValue({ error: { error: "not_found" } } as never);
  expect(await addToCampaign(W, COHORT, CAMPAIGN)).toEqual({ ok: false, error: "not_found" });
  vi.restoreAllMocks();
});

test("a hand-over shows progress and every address's result in plain words", () => {
  const r = (o: Partial<HandoverData["results"][number]>): HandoverData["results"][number] => ({ addressId: crypto.randomUUID(), email: "a@acme.test", status: "added", reason: null, personId: null, conflictItemId: null, missing: [], ...o });
  const h: HandoverData = {
    id: OLD,
    cohortId: COHORT,
    campaignId: CAMPAIGN,
    cohortName: "<b>UK</b> firms",
    campaignTitle: "Q4 push",
    status: "running",
    failureReason: null,
    createdAt: "2026-11-02T10:00:00.000Z",
    finishedAt: null,
    counts: { added: 2, joined: 1, conflict: 1, leftOut: 6 },
    results: [
      r({ email: "<img src=x>@acme.test" }),
      r({ email: "nocountry@acme.test", missing: ["country", "basis"] }),
      r({ status: "joined" }),
      r({ status: "conflict", conflictItemId: "00000000-0000-4000-8000-000000000009" }),
      ...["not_deliverable", "guess_in_canada", "suppressed", "already_contacted", "removed", "bad_country"].map((reason) => r({ status: "left_out", reason })),
    ],
    next: "00000000-0000-4000-8000-000000000010",
  };
  const page = html(createElement(Handover, { workspaceId: W, id: OLD, initial: h }));
  expect(page).toMatch(/<h1[^>]*>Adding &lt;b&gt;UK&lt;\/b&gt; firms to Q4 push<\/h1>/);
  expect(page).toContain("In progress.");
  expect(page).toMatch(/<dt[^>]*>Added<\/dt><dd[^>]*>2<\/dd>/);
  expect(page).toMatch(/<dt[^>]*>Already in Direx<\/dt><dd[^>]*>1<\/dd>/);
  expect(page).toMatch(/<dt[^>]*>Needs your decision<\/dt><dd[^>]*>1<\/dd>/);
  expect(page).toMatch(/<dt[^>]*>Left out<\/dt><dd[^>]*>6<\/dd>/);
  // The main action opens the first address waiting for a decision.
  expect(page).toMatch(new RegExp(`href="/w/${W}/review/00000000-0000-4000-8000-000000000009"[^>]*>1 need your decision`));
  expect(page).toContain("No country is known, so they stay out of drafts until someone enters it. Gets no draft until these are recorded: basis.");
  expect(page).toContain(`href="/w/${W}/review/00000000-0000-4000-8000-000000000009"`);
  for (const words of ["not deliverable when checked", "a guessed address for someone in Canada", "on your Do not contact list", "this Person was already written to", "removed from this Campaign earlier", "the country isn&#x27;t a two-letter code"])
    expect(page).toContain(`Left out: ${words}`);
  // Left-outs are grouped by why: one heading per reason, with how many it covered.
  expect(page.match(/<h3[^>]*>Left out: /g)).toHaveLength(6);
  expect(page).toContain("&lt;img src=x&gt;@acme.test");
  expect(page).not.toContain("<img");
  expect(page).toContain("Show more");
  expect(page).toContain(`/w/${W}/campaigns/${CAMPAIGN}`);
});

test("a hand-over whose job gave up says it stopped and why", () => {
  const h: HandoverData = { id: OLD, cohortId: COHORT, campaignId: CAMPAIGN, cohortName: "UK firms", campaignTitle: "Q4 push", status: "failed", failureReason: "the Campaign refused the batch", createdAt: "2026-11-02T10:00:00.000Z", finishedAt: "2026-11-02T10:05:00.000Z", counts: { added: 3, joined: 0, conflict: 0, leftOut: 0 }, results: [], next: null };
  const page = html(createElement(Handover, { workspaceId: W, id: OLD, initial: h }));
  expect(page).toContain("Adding UK firms to Q4 push stopped");
  expect(html(createElement(Handover, { workspaceId: W, id: OLD, initial: { ...h, status: "done", failureReason: null } }))).toMatch(/<h1[^>]*>Added UK firms to Q4 push<\/h1>/);
  expect(page).toContain("It stopped before the end: the Campaign refused the batch.");
});

test("only a 404 reads as gone; a failed or restarting server is tried again", async () => {
  const get = vi.spyOn(api, "GET");
  get.mockResolvedValueOnce({ data: undefined, response: new Response(null, { status: 404 }) } as never);
  expect(await loadHandover(W, RUN)).toBeNull();
  get.mockResolvedValueOnce({ data: undefined, response: new Response(null, { status: 502 }) } as never);
  expect(await loadHandover(W, RUN)).toBeUndefined();
  get.mockRejectedValueOnce(new TypeError("Failed to fetch"));
  expect(await loadRun(W, RUN)).toBeUndefined();
  get.mockResolvedValueOnce({ data: undefined, response: new Response(null, { status: 500 }) } as never);
  expect(await loadCohort(W, RUN)).toBeUndefined();
  get.mockRestore();
});
