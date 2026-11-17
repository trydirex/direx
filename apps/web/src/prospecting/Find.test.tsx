// SPDX-License-Identifier: AGPL-3.0-only
// Find companies: reading a pasted list, and a search from the Strategy that drafts terms, works out
// the cost and runs only up to the spend limit a person sets.
import { afterEach, expect, test, vi } from "vitest";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role } from "../items/actions";
import { api } from "../client";
import { withQueries } from "../testing";
import { Find, type SearchState } from "./Find";

const W = "00000000-0000-4000-8000-0000000000aa";
const RUN = "00000000-0000-4000-8000-0000000000bb";
const OLD = "00000000-0000-4000-8000-0000000000cc";
const T = "00000000-0000-4000-8000-0000000000dd";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const at = { params: { path: { workspaceId: W } } };
const est = { searchUsd: 0.012, namesUsd: 2.5, verifyUsd: 1, totalUsd: 3.5121, limit: 25, namesFree: false, defaults: { namesUsdPerCompany: 0.1, verifyUsdPerAddress: 0.01, addressesPerCompany: 4 } };
const terms = (o: Record<string, unknown> = {}) => ({ runId: T, terms: ["dental clinics", "vets"], objective: "More audits", dropped: 1, proposedAt: "2026-11-08T10:00:00.000Z", ...o });

function show(role: Role, search?: SearchState) {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  render(withQueries(<RouterContextProvider router={router}>{<Find workspaceId={W} role={role} search={search} />}</RouterContextProvider>));
}

/** GET answers the saved terms from `saved()` and the terms run from `run()`, and says whether a search is installed. */
function serve(saved: () => unknown = () => null, run: () => unknown = () => ({ status: "running", statusReason: null }), searchAvailable = false) {
  return vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/prospecting/terms") return reply(200, { proposed: saved() });
    if (path === "/api/w/{workspaceId}/agents/runs/{id}") return reply(200, run());
    if (path === "/api/w/{workspaceId}/prospecting/estimate/per-company") return reply(200, { usd: 0.5, namesFree: false, searchAvailable });
    return reply(404, { error: "not_found" });
  }) as never);
}
/** POST answers each path with what `answers` gives for it. */
function answer(answers: Record<string, () => Promise<unknown>>) {
  return vi.spyOn(api, "POST").mockImplementation(((path: string) => (answers[path] ?? (() => reply(500, { error: "unexpected" })))()) as never);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A list row whose whole text matches, since a website in bold splits the row's text in two. */
const li = (re: RegExp) => (_: string, el: Element | null) => el?.tagName === "LI" && re.test(el.textContent ?? "");

test("pasting websites starts a run and shows what happened to each line", async () => {
  serve();
  let first = true;
  const post = answer({
    "/api/w/{workspaceId}/prospecting/runs/pasted": () => {
      if (first) return (first = false), reply(400, { error: "too_many", max: 200 });
      return reply(201, {
        runId: RUN,
        results: [
          { line: 1, website: "shop.test", ok: true },
          { line: 2, website: "nope", ok: false, reason: "invalid_website" },
          { line: 3, website: "shop.test", ok: false, reason: "duplicate", sameAs: 1 },
          { line: 4, website: "vet.test", ok: false, reason: "already_known", runId: OLD },
        ],
      });
    },
  });
  show("marketer");
  expect(await screen.findByText(/isn't available here, so paste their websites/)).toBeTruthy();
  // Whether a search is installed comes with the per-company price, so no estimate is asked for and refused.
  expect(post).not.toHaveBeenCalled();
  // Nothing pasted: it says so instead of doing nothing.
  await userEvent.click(screen.getByRole("button", { name: "Read these companies" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Paste at least one website, one per line.");
  expect(post).not.toHaveBeenCalled();
  await userEvent.type(screen.getByLabelText("Websites, one per line"), "shop.test\nnope\nhttps://www.Shop.test/about\nvet.test");
  await userEvent.click(screen.getByLabelText("Blog not updated in 6 months"));
  // No amount to type: Direx prices the list, each website once, at its worst case per company. A line that
  // isn't a website, or names one already pasted in another spelling, isn't counted.
  expect(await screen.findByText("About $1.00 for 2 companies, at most $0.50 each.")).toBeTruthy();
  expect(screen.queryByLabelText(/US dollars/)).toBeNull();
  const read = () => fireEvent.submit(screen.getByRole("button", { name: "Read these companies" }).closest("form")!);
  read();
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/prospecting/runs/pasted", { ...at, body: { websites: ["shop.test", "nope", "https://www.Shop.test/about", "vet.test"], signals: ["hiring"], confirmedUsd: 1 } });
  expect((await screen.findByRole("alert")).textContent).toBe("A search takes at most 200 new companies. Paste fewer.");

  read();
  const lines = within(await screen.findByRole("group", { name: "What happened to each website" }));
  expect(lines.getByRole("link", { name: "Open this search" }).getAttribute("href")).toBe(`/w/${W}/people/find/${RUN}`);
  expect(lines.getByText(li(/^shop\.test: added to this search/))).toBeTruthy();
  expect(lines.getByText(li(/^nope: not a website Direx can read/))).toBeTruthy();
  expect(lines.getByText(li(/^shop\.test: same company as shop\.test/))).toBeTruthy();
  expect(lines.getByRole("link", { name: "See the search that found it" }).getAttribute("href")).toBe(`/w/${W}/people/find/${OLD}`);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("drafting terms waits for the terms run, then fills them in", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let saved: unknown = terms({ runId: OLD, terms: ["old term"], objective: null, dropped: 0 });
    serve(() => saved, undefined, true);
    const post = answer({
      "/api/w/{workspaceId}/prospecting/terms": () => reply(202, { runId: T }),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    show("marketer");
    const box = (await screen.findByLabelText(/^Search terms/)) as HTMLTextAreaElement;
    await vi.waitFor(() => expect(box.value).toBe("old term"));
    expect(screen.getByText(/The objective was left out/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Draft terms from the Strategy" }));
    expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/prospecting/terms", at);
    expect(await screen.findByText("Direx is drafting terms. Nothing is searched yet.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Draft terms from the Strategy" }) as HTMLButtonElement).disabled).toBe(true);
    saved = terms();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(box.value).toBe("dental clinics\nvets"));
    expect(screen.queryByText("Direx is drafting terms. Nothing is searched yet.")).toBeNull();
    expect(screen.getByText(/Objective: More audits/)).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

test("a terms run that stops, a refused draft, and no search here each say so", async () => {
  serve(undefined, () => ({ status: "failed", statusReason: "no_route" }), true);
  let draft = () => reply(202, { runId: T });
  answer({ "/api/w/{workspaceId}/prospecting/terms": () => draft() });
  show("marketer");
  await userEvent.click(await screen.findByRole("button", { name: "Draft terms from the Strategy" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Drafting terms stopped (Stopped: no model is available for this yet). Write them yourself, or try again.");
  draft = () => reply(409, { error: "no_strategy" });
  await userEvent.click(screen.getByRole("button", { name: "Draft terms from the Strategy" }));
  expect(await screen.findByText(/Approve a Strategy that says who it's for first/)).toBeTruthy();
  draft = () => reply(404, { error: "not_available" });
  await userEvent.click(screen.getByRole("button", { name: "Draft terms from the Strategy" }));
  expect(await screen.findByText(/isn't available here, so paste their websites/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Draft terms from the Strategy" })).toBeNull();
});

test("bad terms are refused before anything is priced", async () => {
  serve();
  const post = answer({ "/api/w/{workspaceId}/prospecting/estimate": () => reply(400, { error: "person_data", terms: ["ana@shop.test"] }) });
  show("marketer", { available: true });
  const box = await screen.findByLabelText(/^Search terms/);
  const price = () => userEvent.click(screen.getByRole("button", { name: /^Work out the cost/ }));
  await userEvent.type(box, "   ");
  await price();
  expect((await screen.findByRole("alert")).textContent).toBe("Write at least one term, one per line.");
  await userEvent.clear(box);
  await userEvent.type(box, Array.from({ length: 21 }, (_, i) => `t${i}`).join("\n"));
  await price();
  expect((await screen.findByRole("alert")).textContent).toBe("Use at most 20 terms.");
  await userEvent.clear(box);
  await userEvent.click(box);
  await userEvent.paste("x".repeat(201));
  await price();
  expect((await screen.findByRole("alert")).textContent).toBe("Keep each term under 200 characters.");
  expect(post).not.toHaveBeenCalled();
  await userEvent.clear(box);
  await userEvent.type(box, "ana@shop.test");
  await price();
  expect((await screen.findByRole("alert")).textContent).toContain("Change or remove them: ana@shop.test.");
});

test("working out the cost, then searching for the confirmed amount, lists each company", async () => {
  serve();
  let run = () => reply(400, { error: "below_estimate", usd: 0.5 });
  const post = answer({ "/api/w/{workspaceId}/prospecting/estimate": () => reply(200, est), "/api/w/{workspaceId}/prospecting/runs": () => run() });
  show("marketer", { available: true });
  await userEvent.type(await screen.findByLabelText(/^Search terms/), "dental clinics\n\nvets");
  const limit = screen.getByLabelText(/^Number of companies/);
  await userEvent.clear(limit);
  await userEvent.type(limit, "10");
  await userEvent.click(within(screen.getByRole("region", { name: "Search from your Strategy" })).getByLabelText("Hiring"));
  await userEvent.click(screen.getByRole("button", { name: /^Work out the cost/ }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/estimate", { ...at, body: { terms: ["dental clinics", "vets"], limit: 10, signals: ["stale_blog"] } });
  const cost = within(await screen.findByRole("list", { name: "Cost" }));
  expect(cost.getByText("Search: $0.02")).toBeTruthy();
  expect(cost.getByText("Total, at most: $3.52")).toBeTruthy();
  // The search form's own amount; the paste form has one of the same name.
  const amount = within(screen.getByRole("button", { name: "Search 10 companies · up to $3.52" }).closest("form")!).getByLabelText("Spend up to, in US dollars") as HTMLInputElement;
  expect(amount.value).toBe("3.52");
  await userEvent.clear(amount);
  await userEvent.type(amount, "0.1");
  await userEvent.click(screen.getByRole("button", { name: /^Search 10 companies/ }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/prospecting/runs", { ...at, body: { terms: ["dental clinics", "vets"], limit: 10, signals: ["stale_blog"], confirmedUsd: 0.1 } });
  expect((await screen.findByRole("alert")).textContent).toBe("The search alone is estimated at $0.50. Set the spend limit to at least that.");

  run = () =>
    reply(201, {
      runId: RUN,
      status: "stopped",
      searchUsd: 0.01,
      results: [
        { domain: "a.test", name: "A Clinic", ok: true },
        { domain: "b.test", name: null, ok: false, reason: "over_amount" },
        { domain: "c.test", name: null, ok: false, reason: "already_known", runId: OLD },
      ],
    });
  await userEvent.click(screen.getByRole("button", { name: /^Search 10 companies/ }));
  const found = within(await screen.findByRole("region", { name: "What happened to each company" }));
  expect(found.getByText(/The spend limit ran out/)).toBeTruthy();
  expect(found.getByText(/A Clinic \(a\.test\): added to this search/)).toBeTruthy();
  expect(found.getByText(/b\.test: left over/)).toBeTruthy();
  expect(found.getByRole("link", { name: "See the search that found it" }).getAttribute("href")).toBe(`/w/${W}/people/find/${OLD}`);
  expect(screen.queryByRole("alert")).toBeNull();

  await userEvent.type(screen.getByLabelText(/^Search terms/), "\nfarms");
  expect(screen.queryByRole("list", { name: "Cost" })).toBeNull();
  // A changed search is priced again before it can run: the button goes back to working out the cost.
  expect(screen.getByRole("button", { name: "Work out the cost of 10 companies" })).toBeTruthy();
});

test("a search that finds nothing says so, and a Contributor can price but not search", async () => {
  serve();
  answer({ "/api/w/{workspaceId}/prospecting/estimate": () => reply(200, est) });
  show("contributor", { available: true, estimate: est, proposed: terms(), found: { runId: RUN, status: "done", searchUsd: 0, results: [] } });
  expect(screen.getByText("The search found no companies.")).toBeTruthy();
  expect(screen.getByText(/You can draft terms and work out the cost\. Ask an Owner, Admin or Marketer to start the search\./)).toBeTruthy();
  expect(screen.getByText("Ask an Owner, Admin or Marketer to start a search.")).toBeTruthy();
});

test("past runs are listed newest first, each a link to its run, so a run can be found again", async () => {
  const run = (id: string, o: Record<string, unknown>) => ({ id, source: "search", terms: [], status: "done", confirmedUsd: 4, vendorCostUsd: 1.25, companies: 12, createdAt: "2026-11-08T10:00:00.000Z", finishedAt: null, ...o });
  vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    path === "/api/w/{workspaceId}/prospecting/runs" ? reply(200, { runs: [run(RUN, { status: "running" }), run(OLD, { source: "pasted", companies: 1 })] }) : reply(404, { error: "not_found" })) as never);
  show("owner", { available: false });
  const list = within(await screen.findByRole("region", { name: "Past searches" }));
  const links = list.getAllByRole("link");
  expect(links.map((a) => a.getAttribute("href"))).toEqual([`/w/${W}/people/find/${RUN}`, `/w/${W}/people/find/${OLD}`]);
  expect(links[0]!.textContent).toMatch(/^Search, /);
  expect(links[1]!.textContent).toMatch(/^Pasted websites, /);
  expect(list.getByText("Running · 12 companies · $1.25 spent of up to $4.00")).toBeTruthy();
  expect(list.getByText("Done · 1 company · $1.25 spent, estimated about $4.00")).toBeTruthy();
});
