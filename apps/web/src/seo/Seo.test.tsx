// SPDX-License-Identifier: AGPL-3.0-only
// SEO loads through the query layer: a loading state first, then Search Console's state, and an
// error panel with Retry when it can't be read.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries, choose } from "../testing";
import { Seo } from "./Seo";
import { BriefView, type BriefContent } from "./BriefView";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const off = { connected: false, siteUrl: null, properties: null, refusal: { reason: "not_connected" } };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("SEO shows a loading state, then what connecting does", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, off)) as never);
  render(withQueries(<Seo workspaceId={W} role="owner" />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await screen.findByRole("button", { name: "Connect Search Console" })).toBeTruthy();
});

test("when Search Console's state can't be read, SEO says so and Retry reads it again", async () => {
  let fail = true;
  vi.spyOn(api, "GET").mockImplementation((() => (fail ? reply(403, { error: "forbidden" }) : reply(200, off))) as never);
  render(withQueries(<Seo workspaceId={W} role="owner" />));
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "Connect Search Console" })).toBeTruthy();
});

const at = { params: { path: { workspaceId: W } } };
const summary = { siteUrl: "https://shop.test/", startDate: "2026-10-01", endDate: "2026-10-28", clicks: 1200, impressions: 34000, position: 11.2, daily: [], previous: { startDate: "2026-09-03", endDate: "2026-09-30", clicks: 1000, impressions: 34000, position: 12.6 } };
const none = { total: 0, top: [] };
const candidates = { previous: { startDate: "2026-09-01", endDate: "2026-09-28" }, nearPageOne: { total: 1, top: [{ query: "pricing plans", page: "https://shop.test/pricing", clicks: 3, impressions: 400, position: 11, positionBefore: 13 }] }, slipping: none, competing: none };
const picked = { connected: true, siteUrl: "https://shop.test/", properties: [{ siteUrl: "https://shop.test/", permissionLevel: "siteOwner" }, { siteUrl: "sc-domain:shop.test", permissionLevel: "siteOwner" }], refusal: null };

let history: { briefs: unknown[]; writing: { page: string; query: string }[] } = { briefs: [], writing: [] };
/** GET answers Search Console's state from `state()`, `sum` as the summary, candidates, `week` as the Briefs, and the Workspace time zone. */
function serve(state: () => unknown, sum: unknown = summary, week: unknown = { note: null, ranThisWeek: false }) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/seo/search-console") return reply(200, state());
    if (path === "/api/w/{workspaceId}/seo/search-console/summary") return reply(200, sum);
    if (path === "/api/w/{workspaceId}/seo/candidates") return reply(200, candidates);
    if (path === "/api/w/{workspaceId}/seo/briefs") return reply(200, week);
    if (path === "/api/w/{workspaceId}/seo/briefs/history") return reply(200, history);
    if (path === "/api/w/{workspaceId}/time-zone") return reply(200, { timeZone: "Europe/Berlin" });
    return reply(404, { error: "not_found" });
  }) as never);
}

test("Connect Search Console sends the person to Google, and a missing client says what to set", async () => {
  serve(() => off);
  const assign = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(500, { error: "unexpected" })) as never).mockImplementationOnce((() => reply(200, { url: "https://accounts.google.com/o/oauth2" })) as never);
  render(withQueries(<Seo workspaceId={W} role="marketer" />));
  await userEvent.click(await screen.findByRole("button", { name: "Connect Search Console" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/connections/{connection}/start", { params: { path: { workspaceId: W, connection: "google_search_console" } } });
  expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2");
  post.mockImplementationOnce((() => reply(404, { error: "unknown_connection" })) as never);
  await userEvent.click(screen.getByRole("button", { name: "Connect Search Console" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Set DIREX_GOOGLE_CLIENT_ID");
});

test("a connection that needs reconnecting offers Reconnect", async () => {
  serve(() => ({ connected: true, siteUrl: null, properties: null, refusal: { reason: "needs_reconnecting" } }));
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(500, { error: "failed" })) as never);
  render(withQueries(<Seo workspaceId={W} role="owner" />));
  await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
  expect(post).toHaveBeenCalledOnce();
  expect(await screen.findByText("That didn't work. Try again.")).toBeTruthy();
});

test("an Owner changes the site; a refusal keeps the form, a save reloads the page", async () => {
  let state: unknown = picked;
  serve(() => state);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(500, { error: "unexpected" })) as never).mockImplementationOnce((() => reply(400, { error: "not_listed" })) as never);
  render(withQueries(<Seo workspaceId={W} role="owner" />));
  expect((await screen.findByText("Clicks", { selector: "dt" })).nextElementSibling!.textContent).toBe("1,200");
  expect(screen.getByText("Impressions", { selector: "dt" }).nextElementSibling!.textContent).toBe("34,000");
  expect(screen.getByText("+20% vs previous 28 days")).toBeTruthy();
  expect(screen.getByText("0% vs previous 28 days")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Change site" }));
  await choose("Site", "sc-domain:shop.test");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/seo/search-console/property", { ...at, body: { siteUrl: "sc-domain:shop.test" } });
  expect(await screen.findByText("This Google account can't see that property. Pick one from the list.")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Site" })).toBeTruthy();

  post.mockImplementationOnce((() => reply(200, {})) as never);
  state = { ...picked, siteUrl: "sc-domain:shop.test" };
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Saved.")).toBeTruthy();
  expect(await screen.findByText("Site: sc-domain:shop.test")).toBeTruthy();
});

test("writing this week's Briefs now shows what started, or why it can't", async () => {
  serve(() => picked);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(500, { error: "unexpected" })) as never).mockImplementationOnce((() => reply(409, { error: "already_ran" })) as never);
  render(withQueries(<Seo workspaceId={W} role="admin" />));
  await userEvent.click(await screen.findByRole("button", { name: "Write this week's Briefs now" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/seo/briefs/run", at);
  expect(await screen.findByText("This week's Briefs have already been started.")).toBeTruthy();

  post.mockImplementationOnce((() => reply(200, { at: "2026-11-09T10:00:00.000Z", by: "person", started: [{ query: "seo audit", page: "https://shop.test/audit" }], skipped: [], stopped: null })) as never);
  await userEvent.click(screen.getByRole("button", { name: "Write this week's Briefs now" }));
  expect(await screen.findByText(/Started 9 November 2026 by hand/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "/audit" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open Review" }).getAttribute("href")).toBe(`/w/${W}/review`);
  expect(screen.queryByRole("button", { name: "Write this week's Briefs now" })).toBeNull();
});

test("without the earlier 28 days on record, the tiles show no comparison", async () => {
  serve(() => picked, { ...summary, previous: null });
  render(withQueries(<Seo workspaceId={W} role="owner" />));
  expect((await screen.findByText("Clicks", { selector: "dt" })).nextElementSibling!.textContent).toBe("1,200");
  expect(screen.queryByText(/vs previous/)).toBeNull();
  expect(screen.queryByText(/Up from|Down from/)).toBeNull();
});

test("a run that started nothing says when it began in the Workspace time zone", async () => {
  serve(() => picked, summary, { ranThisWeek: true, note: { week: "2026-11-02", at: "2026-11-02T06:00:01.000Z", by: "schedule", started: [], skipped: [], stopped: null } });
  render(withQueries(<Seo workspaceId={W} role="owner" />));
  expect(await screen.findByText(/began at 07:00 Europe\/Berlin time/)).toBeTruthy();
});

test("Copy as Markdown copies the Brief and says so", async () => {
  const c = { page: "https://shop.test/a", query: "q", why: "", others: [], brief: { gaps: [], cantTell: null, steered: [] }, markdown: "# Brief", readAt: "2026-11-06T09:00:00.000Z" } satisfies BriefContent;
  const copy = vi.fn(() => Promise.resolve());
  render(withQueries(<BriefView c={c} copy={copy} />));
  await userEvent.click(screen.getByRole("button", { name: "Copy as Markdown" }));
  expect(copy).toHaveBeenCalledWith("# Brief");
  expect(await screen.findByText("Copied.")).toBeTruthy();
});

test("Write a Brief starts one for that row, which then says it's being written; a refusal says why", async () => {
  serve(() => picked);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(409, { error: "brief_waiting" })) as never);
  render(withQueries(<Seo workspaceId={W} role="marketer" />));
  await userEvent.click(await screen.findByRole("button", { name: "Write a Brief" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/seo/briefs/write", { ...at, body: { page: "https://shop.test/pricing", query: "pricing plans" } });
  expect(await screen.findByText("A Brief for this page and search is already waiting on you.")).toBeTruthy();
  post.mockImplementationOnce((() => {
    history = { briefs: [], writing: [{ page: "https://shop.test/pricing", query: "pricing plans" }] };
    return reply(202, { runId: "r1" });
  }) as never);
  await userEvent.click(screen.getByRole("button", { name: "Write a Brief" }));
  expect(await screen.findByRole("button", { name: "Writing the Brief" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  history = { briefs: [], writing: [] };
});

test("the page header holds the site, Change site and the run button; the numbers come first, then this week's Briefs, the lists, and Did it help", async () => {
  serve(() => picked);
  render(withQueries(<Seo workspaceId={W} role="owner" />));
  const run = await screen.findByRole("button", { name: "Write this week's Briefs now" });
  const header = screen.getByRole("heading", { level: 1 }).closest("header")!;
  expect(header.contains(run)).toBe(true);
  expect(header.contains(screen.getByRole("button", { name: "Change site" }))).toBe(true);
  expect(header.textContent).toContain("Site: https://shop.test/");
  expect(screen.getByText("Times people clicked through from search")).toBeTruthy();
  const order = [screen.getByText("Clicks", { selector: "dt" }), await screen.findByRole("region", { name: "This week's Briefs" }), await screen.findByRole("region", { name: "Close to page one: small wins" }), await screen.findByRole("region", { name: "Briefs" })];
  for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a Marketer sees the numbers but not the run button or Change site", async () => {
  serve(() => picked);
  render(withQueries(<Seo workspaceId={W} role="marketer" />));
  await screen.findByRole("region", { name: "This week's Briefs" });
  expect(screen.queryByRole("button", { name: "Write this week's Briefs now" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Change site" })).toBeNull();
  expect(screen.getByText("This week's Briefs haven't been written yet.")).toBeTruthy();
});
