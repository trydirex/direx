// SPDX-License-Identifier: AGPL-3.0-only
// Campaigns lists every Campaign, Drafts too, and starts a new one: its plan and Campaign are made together and
// it opens on the Campaign's Plan tab (ADR 0023). The Strategy lives on Brand; its editor is tested here on its own.
import { afterEach, expect, test, vi } from "vitest";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role } from "../items/actions";
import { api } from "../client";
import { withQueries, choose } from "../testing";
import { Campaigns } from "../campaigns/List";
import { Strategy } from "./Strategy";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const RUN = "00000000-0000-4000-8000-0000000000cc";
const CAMP = "00000000-0000-4000-8000-0000000000dd";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const at = { params: { path: { workspaceId: W } } };
const body = { schemaVersion: 1, whoFor: "Ops leads", personas: [], positioning: "The audit", channels: [], assumptions: [] };
const strategy = (o: Record<string, unknown> = {}) => ({ id: ID, currentVersion: 1, current: body, draft: body, draftRevision: 3, missing: [], waiting: null, notes: [], citedReadings: [], ...o });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show(screenEl: React.ReactElement) {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  render(withQueries(<RouterContextProvider router={router}>{screenEl}</RouterContextProvider>));
  return router;
}
const campaignsPage = (role: Role = "marketer") => show(<Campaigns workspaceId={W} role={role} />);
const strategyPage = (role: Role = "marketer") => show(<Strategy workspaceId={W} role={role} facts={[]} />);
/** The Campaigns page with Start a campaign open. */
async function starting(role: Role = "marketer") {
  const router = campaignsPage(role);
  await userEvent.click(screen.getByRole("button", { name: "New campaign" }));
  return router;
}

/** GET answers from the given functions; anything else is not found. */
function serve(o: { strategy?: () => Promise<unknown>; campaigns?: () => Promise<unknown>; campaignOf?: () => Promise<unknown> }) {
  return vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/strategy") return (o.strategy ?? (() => reply(200, strategy())))();
    if (path === "/api/w/{workspaceId}/campaigns") return (o.campaigns ?? (() => reply(200, { campaigns: [] })))();
    if (path === "/api/w/{workspaceId}/plans/{id}/campaign") return (o.campaignOf ?? (() => reply(200, { campaignId: CAMP })))();
    if (path === "/api/w/{workspaceId}/facts") return reply(200, { facts: [] });
    if (path === "/api/w/{workspaceId}/agents/runs/{id}") return reply(200, { status: "running" });
    return reply(404, { error: "not_found" });
  }) as never);
}
/** POST answers each path with what `answers` gives for it. */
function answer(answers: Record<string, () => Promise<unknown>>) {
  return vi.spyOn(api, "POST").mockImplementation(((path: string) => (answers[path] ?? (() => reply(500, { error: "unexpected" })))()) as never);
}

test("New campaign opens Start a campaign in a dialog, and Cancel closes it", async () => {
  serve({});
  await starting();
  const form = within(await screen.findByRole("dialog", { name: "Start a campaign" }));
  expect(form.getByLabelText("Name")).toBeTruthy();
  expect(form.getByLabelText("What do you want this campaign to do?")).toBeTruthy();
  expect(form.getByRole("button", { name: "Write it myself" })).toBeTruthy();
  await userEvent.click(form.getByRole("button", { name: "Cancel" }));
  await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Start a campaign" })).toBeNull());
  expect(screen.getByRole("button", { name: "New campaign" })).toBeTruthy();
});

test("writing a plan yourself creates it and opens its Campaign on the Plan tab", async () => {
  const get = serve({});
  const post = answer({ "/api/w/{workspaceId}/plans": () => reply(200, { id: ID }) });
  const router = await starting();
  await userEvent.type(await screen.findByLabelText("Name"), "Q4");
  await userEvent.click(screen.getByRole("button", { name: "Write it myself" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/plans", { ...at, body: { title: "Q4" } });
  await vi.waitFor(() => expect(router.history.location.href).toBe(`/w/${W}/campaigns/${CAMP}?tab=plan`));
  expect(get).toHaveBeenCalledWith("/api/w/{workspaceId}/plans/{id}/campaign", { params: { path: { workspaceId: W, id: ID } } });
});

test("drafting a plan creates it, starts the run and opens its Campaign's Plan tab on that run", async () => {
  serve({});
  const post = answer({ "/api/w/{workspaceId}/plans": () => reply(200, { id: ID }), "/api/w/{workspaceId}/plans/{id}/draft-run": () => reply(200, { runId: RUN }) });
  const router = await starting();
  await userEvent.type(await screen.findByLabelText("Name"), "Q4");
  await userEvent.click(await screen.findByRole("button", { name: "Draft plan" }));
  expect(await screen.findByText("Say what you want this campaign to do first.")).toBeTruthy();
  await userEvent.type(screen.getByLabelText("What do you want this campaign to do?"), "Book 4 meetings");
  await userEvent.click(screen.getByRole("button", { name: "Draft plan" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/plans", { ...at, body: { title: "Q4", request: "Book 4 meetings" } });
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/plans/{id}/draft-run", { params: { path: { workspaceId: W, id: ID } } });
  await vi.waitFor(() => expect(router.history.location.href).toBe(`/w/${W}/campaigns/${CAMP}?tab=plan&run=${RUN}`));
});

test("a refused draft run opens the Campaign's Plan tab with the refusal, and a refused plan says why", async () => {
  serve({});
  let id: string | undefined = ID;
  answer({ "/api/w/{workspaceId}/plans": () => reply(id ? 200 : 400, id ? { id } : { error: "request: Too big: expected string to have <=1000 characters" }), "/api/w/{workspaceId}/plans/{id}/draft-run": () => reply(409, { error: "no_route" }) });
  const router = await starting();
  await userEvent.type(await screen.findByLabelText("Name"), "Q4");
  await userEvent.type(screen.getByLabelText("What do you want this campaign to do?"), "Book");
  await userEvent.click(await screen.findByRole("button", { name: "Draft plan" }));
  await vi.waitFor(() => expect(router.history.location.href).toBe(`/w/${W}/campaigns/${CAMP}?tab=plan&notice=no_route`));
  id = undefined;
  await userEvent.click(screen.getByRole("button", { name: "Write it myself" }));
  expect(await screen.findByText("Say what you want in up to 1,000 characters.")).toBeTruthy();
});

test("what the campaign should do stops at the 1,000 characters the API takes, and counts them", async () => {
  serve({});
  await starting();
  const box = (await screen.findByLabelText("What do you want this campaign to do?")) as HTMLTextAreaElement;
  await userEvent.type(box, "Book 4");
  const counter = box.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent ?? "");
  expect(counter.some((t) => t.includes("6") && t.includes("1,000"))).toBe(true);
});

test("a new plan whose Campaign can't be found leads back to Campaigns", async () => {
  serve({ campaignOf: () => reply(404, { error: "not_found" }) });
  answer({ "/api/w/{workspaceId}/plans": () => reply(200, { id: ID }) });
  const router = await starting();
  await userEvent.type(await screen.findByLabelText("Name"), "Q4");
  await userEvent.click(screen.getByRole("button", { name: "Write it myself" }));
  await vi.waitFor(() => expect(router.history.location.href).toBe(`/w/${W}/campaigns`));
});

test("with no approved Strategy Direx can't draft yet, and Start a campaign points to Brand for it", async () => {
  serve({ strategy: () => reply(200, strategy({ currentVersion: null, current: null, draft: null, draftRevision: 0 })) });
  await starting();
  expect(await screen.findByText(/Direx drafts a plan from your Strategy, so approve that first\./)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open Brand" }).getAttribute("href")).toBe(`/w/${W}/brand`);
  expect(screen.queryByRole("button", { name: "Draft plan" })).toBeNull();
  expect(screen.getByRole("button", { name: "Write it myself" })).toBeTruthy();
});

test("a marketer drafts, saves and submits the Strategy", async () => {
  serve({ strategy: () => reply(200, strategy({ currentVersion: null, current: null, draft: null, draftRevision: 0 })) });
  const post = answer({ "/api/w/{workspaceId}/strategy/draft-run": () => reply(200, { runId: RUN }), "/api/w/{workspaceId}/strategy/submit": () => reply(422, { error: "incomplete", missing: [{ path: "channels", message: "channels_now_out_of_range" }] }) });
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { revision: 1, missing: [] })) as never);
  strategyPage();
  const s = within(await screen.findByRole("region", { name: "Strategy" }));
  expect((await s.findByText("Write the Strategy")).closest("details")!.open).toBe(false);
  await userEvent.click(s.getByText("Write the Strategy"));
  await userEvent.type(s.getByLabelText("Tell Direx about the business"), "Audits");
  await userEvent.click(s.getByRole("button", { name: "Draft it for me" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/strategy/draft-run", { ...at, body: { request: "Audits" } });
  expect(await s.findByText("Direx is drafting this. Nothing is sent.")).toBeTruthy();
  await userEvent.type(s.getByLabelText("Who we're for"), "Ops");
  await userEvent.click(s.getByRole("button", { name: "Add a persona" }));
  await userEvent.type(s.getByLabelText("Persona"), "Ana");
  await userEvent.click(s.getByRole("button", { name: "Add a channel" }));
  await userEvent.type(s.getByLabelText("Channel"), "Email");
  await choose("When", "Later", s);
  await choose("Comes from", "A named source", s);
  await userEvent.type(s.getByLabelText("Source"), "Survey");
  await userEvent.click(s.getByRole("button", { name: "Add an assumption" }));
  await userEvent.type(s.getByLabelText("Assumption"), "Price");
  await userEvent.click(s.getByRole("button", { name: "Save draft" }));
  const saved = put.mock.calls[0]![1] as { body: { revision: number; body: Record<string, unknown> } };
  expect(saved.body.revision).toBe(0);
  expect(saved.body.body).toMatchObject({ whoFor: "Ops", personas: [{ name: "Ana" }], channels: [{ label: "Email", timing: "later", basis: { kind: "source", label: "Survey" } }], assumptions: [{ text: "Price" }] });
  await userEvent.click(s.getByRole("button", { name: "Send for sign-off" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/strategy/submit", { ...at, body: { revision: 1 } });
  expect(await s.findByText(/Still needed: 1 to 3 channels for now\./)).toBeTruthy();
});

test("an approved Strategy shows as a closed summary", async () => {
  serve({});
  strategyPage();
  const s = within(await screen.findByRole("region", { name: "Strategy" }));
  expect(await s.findByText("Who we're for: Ops leads")).toBeTruthy();
  expect(s.getByText("Edit Strategy").closest("details")!.open).toBe(false);
});

test("a Viewer sees the campaigns but can't start one", async () => {
  serve({});
  campaignsPage("viewer");
  expect(await screen.findByText("No campaigns yet.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New campaign" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Start a campaign" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Write it myself" })).toBeNull();
});

test("with no campaigns, Start a campaign in the empty state opens the form", async () => {
  serve({});
  campaignsPage();
  await userEvent.click(await screen.findByRole("button", { name: "Start a campaign" }));
  expect(await screen.findByRole("dialog", { name: "Start a campaign" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Start a campaign" })).toBeNull();
});

test("Campaigns shows a loading state, then every campaign, each linking to its page", async () => {
  serve({ campaigns: () => reply(200, { campaigns: [{ id: ID, planId: RUN, title: "Q4 outreach", paused: true, status: "paused", changesWaiting: false, goal: "Book 4 meetings", startsOn: "2026-11-01", endsOn: "2099-11-30", planned: 6, done: 2, sent: 40, replied: 3, needApproval: 5, measure: { label: "meetings", target: "4", value: "3" }, channels: ["email", "dm"] }] }) });
  show(<Campaigns workspaceId={W} role="marketer" />);
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  const list = within(await screen.findByRole("table", { name: "Campaigns" }));
  expect(list.getByRole("link", { name: "Q4 outreach" }).getAttribute("href")).toBe(`/w/${W}/campaigns/${ID}`);
  expect(list.getByText("Paused")).toBeTruthy();
  expect(list.getByRole("link", { name: "5 need approval" }).getAttribute("href")).toBe(`/w/${W}/campaigns/${ID}?tab=drafts`);
  expect(list.getByText(/^\w+,? 1 Nov to \w+,? 30 Nov$/)).toBeTruthy();
  expect(list.getByText("Book 4 meetings")).toBeTruthy();
  expect(list.getAllByRole("img").map((m) => m.getAttribute("aria-label"))).toEqual(["Email", "Social posts"]);
  expect(list.getByText("3 / 4 meetings (75%)")).toBeTruthy();
  expect(screen.getByRole("button", { name: "New campaign" })).toBeTruthy();
});

test("each campaign row says the server's status: draft, awaiting sign-off, starts later, running, ended, paused or no date", async () => {
  const c = (id: string, title: string, o: object) => ({ id, planId: RUN, title, paused: false, goal: null, startsOn: null, endsOn: null, planned: 0, done: 0, sent: 0, replied: 0, needApproval: 0, measure: null, channels: [], ...o });
  serve({
    campaigns: () =>
      reply(200, {
        campaigns: [
          c("00000000-0000-4000-8000-000000000001", "Later", { status: "scheduled", startsOn: "2099-03-03", endsOn: "2099-04-01" }),
          c("00000000-0000-4000-8000-000000000002", "Now", { status: "running", startsOn: "2020-01-01", endsOn: "2099-01-01" }),
          c("00000000-0000-4000-8000-000000000003", "Done", { status: "ended", startsOn: "2020-01-01", endsOn: "2020-02-01" }),
          c("00000000-0000-4000-8000-000000000004", "Held", { status: "paused", startsOn: "2020-01-01", endsOn: "2099-01-01", paused: true }),
          c("00000000-0000-4000-8000-000000000005", "Undated", { status: "no_launch_date" }),
          c("00000000-0000-4000-8000-000000000006", "Fresh", { status: "draft" }),
          c("00000000-0000-4000-8000-000000000007", "Sent off", { status: "awaiting_signoff" }),
        ],
      }),
  });
  show(<Campaigns workspaceId={W} role="marketer" />);
  const list = within(await screen.findByRole("table", { name: "Campaigns" }));
  const card = (name: string) => within(list.getByRole("link", { name }).closest("tr")!);
  expect(card("Later").getByText(/^Starts \w+,? 3 Mar$/)).toBeTruthy();
  expect(card("Now").getByText("Running")).toBeTruthy();
  expect(card("Done").getByText("Ended")).toBeTruthy();
  expect(card("Held").getByText("Paused")).toBeTruthy();
  expect(card("Undated").getByText("No launch date")).toBeTruthy();
  expect(card("Fresh").getByText("Draft")).toBeTruthy();
  expect(card("Sent off").getByText("Awaiting sign-off")).toBeTruthy();
  expect(card("Sent off").getByRole("link", { name: "Sign off plan" }).getAttribute("href")).toBe(`/w/${W}/campaigns/00000000-0000-4000-8000-000000000007?tab=plan`);
  expect(card("Undated").getByText("Pick a launch date")).toBeTruthy();
  expect(card("Now").getByText("Nothing waiting")).toBeTruthy();
  expect(card("Fresh").getByText("No dates yet")).toBeTruthy();
  expect(card("Fresh").getByText("Measure not set")).toBeTruthy();
  // Grouped by what needs a person, in this order; Paused sits with the running ones.
  const groups = list.getAllByRole("columnheader").filter((h) => h.getAttribute("colspan"));
  expect(groups.map((h) => h.textContent)).toEqual(["Needs you", "Running and scheduled", "Drafts", "Ended"]);
  expect(list.getAllByRole("link").map((l) => l.textContent).filter((t) => t !== "Sign off plan")).toEqual(["Undated", "Sent off", "Later", "Now", "Held", "Fresh", "Done"]);
});

test("a Draft is listed in the one Campaigns table, under Drafts, and links to its Campaign", async () => {
  const draft = { id: CAMP, planId: ID, title: "Q1 launch", paused: false, status: "draft", changesWaiting: false, goal: null, startsOn: null, endsOn: null, planned: 0, done: 0, sent: 0, replied: 0, needApproval: 0, measure: null, channels: [] };
  serve({ campaigns: () => reply(200, { campaigns: [draft] }) });
  campaignsPage("viewer");
  const list = within(await screen.findByRole("table", { name: "Campaigns" }));
  expect(list.getByRole("link", { name: "Q1 launch" }).getAttribute("href")).toBe(`/w/${W}/campaigns/${CAMP}`);
  expect(list.getByText("Draft")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Draft plans" })).toBeNull();
  expect(screen.queryByText("No campaigns yet.")).toBeNull();
});

test("when campaigns can't be read, Campaigns says so and Retry reads them again; a Viewer gets no New campaign", async () => {
  let fail = true;
  serve({ campaigns: () => (fail ? reply(500, { error: "failed" }) : reply(200, { campaigns: [] })) });
  show(<Campaigns workspaceId={W} role="viewer" />);
  expect((await screen.findByRole("alert")).textContent).toContain("That didn't work. Try again.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("No campaigns yet.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New campaign" })).toBeNull();
});

test("each persona's Remove button names its line, so two rows can be told apart", async () => {
  serve({ strategy: () => reply(200, strategy({ currentVersion: null, current: null, draft: { ...body, personas: [{ name: "Ana" }, { name: "Bo" }] } })) });
  strategyPage();
  const s = within(await screen.findByRole("region", { name: "Strategy" }));
  expect(await s.findByRole("button", { name: "Remove persona 1" })).toBeTruthy();
  expect(s.getByRole("button", { name: "Remove persona 2" })).toBeTruthy();
});

test("saving the Strategy says so, and a refusal shows beside the buttons that caused it", async () => {
  serve({ strategy: () => reply(200, strategy({ currentVersion: null, current: null, draft: null, draftRevision: 0 })) });
  answer({ "/api/w/{workspaceId}/strategy/submit": () => reply(422, { error: "incomplete", missing: [{ path: "channels", message: "channels_now_out_of_range" }] }), "/api/w/{workspaceId}/strategy/draft-run": () => reply(409, { error: "busy" }) });
  vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { revision: 1, missing: [] })) as never);
  strategyPage();
  const s = within(await screen.findByRole("region", { name: "Strategy" }));
  await s.findByLabelText("Who we're for");
  await userEvent.type(s.getByLabelText("Who we're for"), "Ops");
  await userEvent.click(s.getByRole("button", { name: "Save draft" }));
  expect((await s.findByText("Draft saved.")).closest('[role="status"]')).toBeTruthy();
  // Editing again clears it.
  await userEvent.type(s.getByLabelText("Who we're for"), "!");
  expect(s.queryByText("Draft saved.")).toBeNull();

  await userEvent.click(s.getByRole("button", { name: "Send for sign-off" }));
  const refusal = await s.findByText(/Still needed: 1 to 3 channels for now\./);
  const submit = s.getByRole("button", { name: "Send for sign-off" });
  expect(submit.compareDocumentPosition(refusal) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  // Draft it for me says why it can't start right under itself.
  await userEvent.type(s.getByLabelText("Tell Direx about the business"), "Audits");
  const draft = s.getByRole("button", { name: "Draft it for me" });
  await userEvent.click(draft);
  const why = (await s.findAllByRole("alert")).find((a) => draft.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING && !a.textContent?.includes("Still needed"));
  expect(why).toBeTruthy();
});

test("when someone else saved the Strategy first, the typed edit stays over theirs, and saving again keeps both", async () => {
  let latest = strategy();
  serve({ strategy: () => reply(200, latest) });
  const put = vi.spyOn(api, "PUT").mockImplementation(((_: string, o: { body: { revision: number } }) => {
    if (o.body.revision === 4) return reply(200, { revision: 5, missing: [] });
    latest = strategy({ draft: { ...body, positioning: "The fast audit" }, draftRevision: 4 });
    return reply(409, { error: "stale_revision" });
  }) as never);
  strategyPage();
  const s = within(await screen.findByRole("region", { name: "Strategy" }));
  await userEvent.clear(await s.findByLabelText("Who we're for"));
  await userEvent.type(s.getByLabelText("Who we're for"), "Founders");
  await userEvent.click(s.getByRole("button", { name: "Save draft" }));
  expect(await s.findByText("Someone else saved this draft while you were editing and changed Positioning. Your edits are still here, on top of theirs. Save again to keep them.")).toBeTruthy();
  expect((s.getByLabelText("Who we're for") as HTMLTextAreaElement).value).toBe("Founders");
  await userEvent.click(s.getByRole("button", { name: "Save draft" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/strategy/draft", { ...at, body: { revision: 4, body: { ...body, whoFor: "Founders", positioning: "The fast audit" } } });
  expect(await s.findByText("Draft saved.")).toBeTruthy();
});
