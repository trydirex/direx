// SPDX-License-Identifier: AGPL-3.0-only
// One plan loads through the query layer: a loading state, then the plan, and an error panel with
// Retry. Saving, submitting, drafting and tracking each call their endpoint.
import { afterEach, expect, test, vi } from "vitest";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Role } from "../items/actions";
import { api } from "../client";
import { choose, pick, withQueries } from "../testing";
import { Plan } from "./Plan";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const RUN = "00000000-0000-4000-8000-0000000000cc";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const one = { params: { path: { workspaceId: W, id: ID } } };
const body = {
  schemaVersion: 1,
  goal: "4 meetings",
  audience: "Ops leads",
  startsOn: "2026-11-01",
  endsOn: "2026-11-30",
  steps: [{ key: "first", on: "2026-11-03", title: "First email" }],
  measures: [{ key: "meetings", label: "Meetings", target: "4", basis: { kind: "assumption" } }],
  budget: [{ label: "Mailbox", amountCents: null, currency: "USD", billedBy: "your_account" }],
  assumptions: [{ text: "Which line works" }],
};
const tracking = { planned: 1, done: 0, skipped: 0, steps: [{ ...body.steps[0], status: "open" }], measures: [{ ...body.measures[0], latest: null }] };
const plan = (o: Record<string, unknown> = {}) => ({ id: ID, title: "Q4", request: "Book 4 meetings", currentVersion: 1, archived: false, current: body, draft: body, draftRevision: 5, strategyVersion: 1, missing: [], waiting: null, tracking, notes: [], ...o });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show(o: { role?: Role; runId?: string; notice?: string } = {}) {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  render(withQueries(<RouterContextProvider router={router}>{<Plan workspaceId={W} id={ID} role={o.role ?? "marketer"} runId={o.runId} notice={o.notice} />}</RouterContextProvider>));
}

/** The plan answers from `read`; a run has finished; anything else is not found. */
function serve(read: () => Promise<unknown> = () => reply(200, plan())) {
  return vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/plans/{id}") return read();
    if (path === "/api/w/{workspaceId}/facts") return reply(200, { facts: [] });
    if (path === "/api/w/{workspaceId}/agents/runs/{id}") return reply(200, { status: "succeeded", statusReason: null, proposals: [], costMicros: "0", unevaluated: false });
    return reply(404, { error: "not_found" });
  }) as never);
}
function answer(answers: Record<string, () => Promise<unknown>>) {
  return vi.spyOn(api, "POST").mockImplementation(((path: string) => (answers[path] ?? (() => reply(200, {})))()) as never);
}

test("a plan shows a loading state, then the plan; the way back is its Campaign's, so it has none of its own", async () => {
  serve();
  show();
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await screen.findByRole("heading", { level: 1, name: "Q4" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Campaigns" })).toBeNull();
  expect(screen.getByText("Planned 1, done 0, skipped 0")).toBeTruthy();
});

test("when the plan can't be read, it says so and Retry reads it again", async () => {
  let fail = true;
  serve(() => (fail ? reply(403, { error: "forbidden" }) : reply(200, plan())));
  show();
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Q4" })).toBeTruthy();
});

test("a marketer edits every line, saves the draft and submits it, and a refusal says what is missing", async () => {
  serve();
  const post = answer({ "/api/w/{workspaceId}/plans/{id}/submit": () => reply(422, { error: "incomplete", missing: [{ path: "endsOn", message: "plan_dates_out_of_range" }] }) });
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { revision: 6, missing: [] })) as never);
  show();
  const goal = await screen.findByLabelText("Goal");
  await userEvent.clear(goal);
  await userEvent.type(goal, "5 meetings");
  await userEvent.click(screen.getByRole("button", { name: "Add a step" }));
  await userEvent.type(screen.getAllByLabelText("Step")[1]!, "Follow-up");
  await userEvent.click(screen.getByRole("button", { name: "Add a measure" }));
  await userEvent.type(screen.getAllByLabelText("Measure")[1]!, "Replies");
  await userEvent.type(screen.getAllByLabelText("Target")[1]!, "10");
  // A hand-written Measure starts as entered by a person, and can be counted by Direx instead.
  const source = screen.getByRole("combobox", { name: "Where measure 2's number comes from" });
  expect(source.textContent).toContain("Entered by a person");
  await pick(source, "Counted by Direx from email replies");
  await userEvent.click(screen.getByRole("button", { name: "Add a budget line" }));
  await userEvent.type(screen.getAllByLabelText("Budget line")[1]!, "Ads");
  await userEvent.type(screen.getAllByLabelText("Amount")[1]!, "12.5");
  await pick(screen.getAllByRole("combobox", { name: "Billed by" })[1]!, "Direx");
  const steps = within(screen.getByRole("group", { name: "Steps" }));
  await userEvent.click(steps.getByRole("button", { name: "Remove step 1" }));
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const saved = put.mock.calls[0]!;
  expect(saved[0]).toBe("/api/w/{workspaceId}/plans/{id}/draft");
  const sent = (saved[1] as { body: { revision: number; body: Record<string, unknown> } }).body;
  expect(sent.revision).toBe(5);
  expect(sent.body).toMatchObject({ goal: "5 meetings", steps: [{ title: "Follow-up" }], measures: [{ label: "Meetings" }, { label: "Replies", target: "10", source: "replies" }], budget: [{ label: "Mailbox" }, { label: "Ads", amountCents: 1250, billedBy: "direx" }] });
  await userEvent.click(screen.getByRole("button", { name: "Send for sign-off" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/plans/{id}/submit", { ...one, body: { revision: 6 } });
  expect(await screen.findByText(/Still needed: dates up to 45 days apart/)).toBeTruthy();
});

test("the basis field keeps a reading basis and names it, until the person picks another kind", async () => {
  const READING = "00000000-0000-4000-8000-0000000000dd";
  const draft = { ...body, measures: [{ ...body.measures[0], basis: { kind: "reading", readingId: READING } }] };
  const citedReadings = [{ id: READING, found: true, measureLabel: "Interested replies", value: "3", source: "person", observedOn: "2026-11-12", newer: false }];
  serve(() => reply(200, plan({ current: null, currentVersion: null, draft, citedReadings })));
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { revision: 6, missing: [] })) as never);
  show();
  const words = "From an earlier Campaign: Interested replies 3, entered by a person, Thu 12 Nov";
  const field = await screen.findByRole("combobox", { name: "Comes from" });
  expect(field.textContent).toContain(words);
  expect(screen.getByText(`Where does this number come from? (${words})`)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const sent = () => (put.mock.lastCall![1] as { body: { body: { measures: { basis: unknown }[] } } }).body.body.measures[0]!.basis;
  expect(sent()).toEqual({ kind: "reading", readingId: READING });
  await pick(field, "An assumption");
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(sent()).toEqual({ kind: "assumption" });
});

test.each([
  ["replies", "Counted by Direx from meetings marked on People", "meetings"],
  ["meetings", "Entered by a person", "external"],
  [undefined, "Counted by Direx from email replies", "replies"],
])("changing a Measure source from %s starts a separate reading history", async (source, choice, expected) => {
  const measure = { ...body.measures[0]!, source };
  let draft = { ...body, measures: [measure] };
  serve(() => reply(200, plan({ draft })));
  const put = vi.spyOn(api, "PUT").mockImplementation(((_: string, o: { body: { body: typeof draft } }) => {
    draft = o.body.body;
    return reply(200, { revision: 6, missing: [] });
  }) as never);
  show();
  const label = await screen.findByLabelText("Measure");
  await userEvent.type(label, " updated");
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const savedMeasure = () => (put.mock.calls.at(-1)![1] as { body: { body: { measures: typeof measure[] } } }).body.body.measures[0]!;
  expect(savedMeasure()).toEqual({ ...measure, label: "Meetings updated" });
  await pick(screen.getByRole("combobox", { name: "Where measure 1's number comes from" }), choice!);
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  const changed = savedMeasure();
  expect(changed).toEqual({ ...measure, label: "Meetings updated", source: expected, key: expect.any(String) });
  expect(changed.key).not.toBe(measure.key);
  expect(changed.key).not.toBe("");
  // Further edits to this source keep its new history, just as edits to the old source did.
  await userEvent.type(screen.getByLabelText("Target"), "0");
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(savedMeasure()).toEqual({ ...changed, target: "40" });
});

test("a refused save is shown and nothing is submitted", async () => {
  serve();
  const post = answer({});
  vi.spyOn(api, "PUT").mockImplementation((() => reply(409, { error: "stale_revision" })) as never);
  show();
  await userEvent.click(await screen.findByRole("button", { name: "Send for sign-off" }));
  expect(await screen.findByText("Someone else saved this draft while you were editing. Your edits are still here, on top of theirs. Save again to keep them.")).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
});

test("when someone else saved first, the typed edit stays over their draft, and saving again keeps both", async () => {
  // The Owner changed Goal and saved as revision 6 while the Marketer was changing Who on revision 5.
  let latest = plan();
  serve(() => reply(200, latest));
  const put = vi.spyOn(api, "PUT").mockImplementation(((_: string, o: { body: { revision: number } }) => {
    if (o.body.revision === 6) return reply(200, { revision: 7, missing: [] });
    latest = plan({ draft: { ...body, goal: "6 meetings" }, draftRevision: 6 });
    return reply(409, { error: "stale_revision" });
  }) as never);
  answer({});
  show();
  const who = await screen.findByLabelText("Who");
  await userEvent.clear(who);
  await userEvent.type(who, "Founders");
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText("Someone else saved this draft while you were editing and changed Goal. Your edits are still here, on top of theirs. Save again to keep them.")).toBeTruthy();
  expect((screen.getByLabelText("Who") as HTMLTextAreaElement).value).toBe("Founders");
  expect((screen.getByLabelText("Goal") as HTMLInputElement).value).toBe("6 meetings");
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/plans/{id}/draft", { ...one, body: { revision: 6, body: { ...body, goal: "6 meetings", audience: "Founders" } } });
  expect(put).toHaveBeenCalledTimes(2);
});

test("Redraft starts a drafting run and shows what became of it; a refusal says why", async () => {
  serve();
  let refuse = false;
  const post = answer({ "/api/w/{workspaceId}/plans/{id}/draft-run": () => (refuse ? reply(409, { error: "disabled" }) : reply(200, { runId: RUN })) });
  show();
  await userEvent.click(await screen.findByRole("button", { name: "Redraft" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/plans/{id}/draft-run", one);
  expect(await screen.findByText(/Direx drafted this\./)).toBeTruthy();
  refuse = true;
  await userEvent.click(screen.getByRole("button", { name: "Redraft" }));
  expect(await screen.findByText("Drafting is turned off for this Workspace, so write this one yourself.")).toBeTruthy();
});

test("a plan opened on a run or a refusal shows it", async () => {
  serve();
  show({ notice: "no_route" });
  expect(await screen.findByText("Direx can't draft this here yet, so write this one yourself.")).toBeTruthy();
  cleanup();
  show({ runId: RUN });
  expect(await screen.findByText(/Direx drafted this\./)).toBeTruthy();
});

test("a marketer marks a step and adds a reading; a Viewer can do neither", async () => {
  serve();
  const post = answer({});
  show();
  await choose("Status of First email", "Done");
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/plans/{id}/steps/{key}/progress", { params: { path: { workspaceId: W, id: ID, key: "first" } }, body: { status: "done" } });
  await userEvent.type(screen.getByLabelText("Reading"), "2");
  await userEvent.type(screen.getByLabelText("On"), "2026-11-10");
  await userEvent.click(screen.getByRole("button", { name: "Add reading" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/plans/{id}/measures/{key}/readings", { params: { path: { workspaceId: W, id: ID, key: "meetings" } }, body: { value: "2", observedOn: "2026-11-10" } });
  cleanup();
  show({ role: "viewer" });
  await screen.findByRole("heading", { level: 1, name: "Q4" });
  expect(screen.queryByLabelText("Status of First email")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
});

test("a waiting version is approved or dismissed by someone who may approve", async () => {
  serve(() => reply(200, plan({ waiting: { id: RUN, revision: 2, version: 2, warnings: ["Read this"] } })));
  const post = answer({});
  show({ role: "owner" });
  const waiting = within(await screen.findByRole("region", { name: "Needs approval" }));
  await userEvent.click(waiting.getByRole("button", { name: "Approve version 2" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: RUN } }, body: { revision: 2 } });
  await userEvent.click(waiting.getByRole("button", { name: "Dismiss" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/cancel", { params: { path: { workspaceId: W, id: RUN } } });
});

test("each line's Remove button names its line, so two rows can be told apart", async () => {
  serve();
  show();
  await userEvent.click(await screen.findByRole("button", { name: "Add a step" }));
  const steps = within(screen.getByRole("group", { name: "Steps" }));
  expect(steps.getByRole("button", { name: "Remove step 1" })).toBeTruthy();
  expect(steps.getByRole("button", { name: "Remove step 2" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Add an assumption" }));
  expect(screen.getByRole("button", { name: "Remove assumption 1" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove assumption 2" })).toBeTruthy();
});

test("a measure reads as reading over target with a bar, and the drafting cost sits behind a Cost disclosure", async () => {
  const measures = [{ ...body.measures[0], label: "Signups", target: "200 signups", latest: { value: "142", observedOn: "2026-11-10", source: "person" } }];
  serve(() => reply(200, plan({ tracking: { ...tracking, measures } })));
  show({ runId: RUN });
  const m = within(await screen.findByRole("region", { name: "Measures" }));
  // Drawn by Overview's Measures, the one way measures look (D1).
  expect(m.getByText("Signups (71%)")).toBeTruthy();
  expect(m.getByRole("progressbar", { name: "Signups against its target" }).getAttribute("aria-valuenow")).toBe("142");
  const cost = (await screen.findByText("Cost")).closest("details")!;
  expect(cost.open).toBe(false);
  expect(cost.textContent).toContain("$0.00");
});

test("a target that isn't a number shows no bar, and over target the bar stops at full", async () => {
  const measures = [
    { ...body.measures[0], key: "a", label: "Press", target: "a few", latest: null },
    { ...body.measures[0], key: "b", label: "Meetings", target: "4", latest: { value: "6", observedOn: "2026-11-10", source: "system" } },
  ];
  serve(() => reply(200, plan({ tracking: { ...tracking, measures } })));
  show({ role: "viewer" });
  const m = within(await screen.findByRole("region", { name: "Measures" }));
  expect(m.getByText("Press: target a few")).toBeTruthy();
  expect(m.queryByRole("progressbar", { name: "Press against its target" })).toBeNull();
  expect(m.getByRole("progressbar", { name: "Meetings against its target" }).getAttribute("aria-valuenow")).toBe("4");
  expect(m.getByText("Meetings (150%)")).toBeTruthy();
});

test("a drafting run can be cancelled, and the plan then says it didn't finish", async () => {
  let status = "running";
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/plans/{id}") return reply(200, plan());
    if (path === "/api/w/{workspaceId}/facts") return reply(200, { facts: [] });
    if (path === "/api/w/{workspaceId}/agents/runs/{id}") return reply(200, { status, statusReason: null, proposals: [], costMicros: "0", unevaluated: false });
    return reply(404, { error: "not_found" });
  }) as never);
  const post = answer({ "/api/w/{workspaceId}/agents/runs/{id}/cancel": () => ((status = "cancelled"), reply(200, { ok: true })) });
  show({ runId: RUN });
  await userEvent.click(await screen.findByRole("button", { name: "Cancel this draft" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/agents/runs/{id}/cancel", { params: { path: { workspaceId: W, id: RUN } } });
  expect(await screen.findByText(/The draft didn't finish \(Cancelled\)/, undefined, { timeout: 3000 })).toBeTruthy();
  // The outcome is not a paragraph, so its Cost disclosure is valid HTML.
  expect(screen.getByText("Cost").closest("p")).toBeNull();
});

test("a run that can't be read says so and stops following it", async () => {
  const get = vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/plans/{id}") return reply(200, plan());
    if (path === "/api/w/{workspaceId}/facts") return reply(200, { facts: [] });
    if (path === "/api/w/{workspaceId}/agents/runs/{id}") return reply(404, { error: "not_found" });
    return reply(404, { error: "not_found" });
  }) as never);
  show({ runId: RUN });
  expect(await screen.findByText(/Direx can't find this draft run/)).toBeTruthy();
  expect(screen.queryByText(/Direx is drafting this/)).toBeNull();
  const polls = () => get.mock.calls.filter((c) => (c as unknown[])[0] === "/api/w/{workspaceId}/agents/runs/{id}").length;
  const seen = polls();
  await new Promise((r) => setTimeout(r, 2500));
  expect(polls()).toBe(seen);
});

test("a draft that lost to the person's save shows as kept when its run ends, with no reload", async () => {
  let polls = 0;
  let ended = false;
  const offer = { runId: RUN, outputKey: "plan", kind: "plan_proposal", body: { ...body, goal: "Direx's goal" }, at: "2026-11-08T10:00:00.000Z", costMicros: "0" };
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/plans/{id}") return reply(200, plan());
    if (path === "/api/w/{workspaceId}/facts") return reply(200, { facts: [] });
    if (path === "/api/w/{workspaceId}/agents/runs/{id}") {
      ended = ++polls > 1;
      return reply(200, { status: ended ? "succeeded" : "running", statusReason: null, proposals: [{ kind: "plan_proposal", itemId: null, rejectionCode: "target_changed", incomplete: false }], costMicros: "0", unevaluated: false });
    }
    // The draft is kept only once its run has ended; until then there is none.
    if (path === "/api/w/{workspaceId}/drafts/offer") return ended ? reply(200, offer) : reply(404, { error: "not_found" });
    return reply(404, { error: "not_found" });
  }) as never);
  show({ runId: RUN });
  const kept = await screen.findByRole("region", { name: "Direx's kept draft" }, { timeout: 3000 });
  expect(within(kept).getByText("Goal: Direx's goal")).toBeTruthy();
});

test("Save draft says the draft was saved, until the next edit", async () => {
  serve();
  answer({});
  vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { revision: 6, missing: [] })) as never);
  show();
  await userEvent.type(await screen.findByLabelText("Goal"), "!");
  await userEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText("Draft saved.")).toBeTruthy();
  await userEvent.type(screen.getByLabelText("Goal"), "!");
  expect(screen.queryByText("Draft saved.")).toBeNull();
});

test("a refused submit names what's missing as the editor labels it", async () => {
  serve();
  answer({ "/api/w/{workspaceId}/plans/{id}/submit": () => reply(422, { error: "incomplete", missing: [{ path: "startsOn", message: "Invalid" }, { path: "endsOn", message: "Invalid" }, { path: "steps.0.title", message: "Too small" }, { path: "steps.1.on", message: "Invalid" }] }) });
  vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { revision: 6, missing: [] })) as never);
  show();
  await userEvent.click(await screen.findByRole("button", { name: "Send for sign-off" }));
  expect(await screen.findByText("This isn't finished yet. Still needed: Starts, Ends, Steps.")).toBeTruthy();
});

test("approving the waiting version reads what the change does to the Campaign again", async () => {
  let approved = false;
  const impact = (steps: unknown[]) => ({ diff: { steps, plan: [] }, affected: [], titles: { follow: "Email 20 founders" } });
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/plans/{id}") return reply(200, approved ? plan({ currentVersion: 2 }) : plan({ waiting: { id: RUN, revision: 2, version: 2, warnings: [] } }));
    if (path === "/api/w/{workspaceId}/facts") return reply(200, { facts: [] });
    if (path === "/api/w/{workspaceId}/campaigns") return reply(200, { campaigns: [{ id: RUN, planId: ID }] });
    // Once approved, the saved draft is the current version, so approving it again would change nothing.
    if (path === "/api/w/{workspaceId}/campaigns/{id}/plan-impact") return reply(200, impact(approved ? [] : [{ key: "follow", kind: "added" }]));
    return reply(404, { error: "not_found" });
  }) as never);
  answer({ "/api/w/{workspaceId}/items/{id}/approve": () => ((approved = true), reply(200, {})) });
  show({ role: "owner" });
  expect(await screen.findByText("Email 20 founders: added")).toBeTruthy();
  await userEvent.click(within(screen.getByRole("region", { name: "Needs approval" })).getByRole("button", { name: "Approve version 2" }));
  await vi.waitFor(() => expect(screen.queryByText("Email 20 founders: added")).toBeNull());
});

test("a Viewer reads a plan that isn't approved yet, with nothing to change", async () => {
  serve(() => reply(200, plan({ current: null, currentVersion: null, tracking: null })));
  show({ role: "viewer" });
  const draft = within(await screen.findByRole("region", { name: "Draft plan" }));
  expect(draft.getByText("Goal: 4 meetings")).toBeTruthy();
  expect(draft.getByText("Who: Ops leads")).toBeTruthy();
  expect(draft.getByText(/First email/)).toBeTruthy();
  expect(draft.getByText("Meetings: 4")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
});

test("a Viewer can read an unfinished draft measure without a basis", async () => {
  const draft = { ...body, measures: [{ key: "meetings", label: "Meetings", target: "4" }] };
  serve(() => reply(200, plan({ current: null, currentVersion: null, tracking: null, draft })));
  show({ role: "viewer" });
  const view = within(await screen.findByRole("region", { name: "Draft plan" }));
  expect(view.getByRole("list", { name: "Measures" }).textContent).toBe("Meetings: 4");
});

test("a Measure Direx counts says so beside it, in the draft and in the editor", async () => {
  const counted = { ...body, measures: [{ ...body.measures[0], source: "meetings" }] };
  serve(() => reply(200, plan({ current: null, currentVersion: null, tracking: null, draft: counted })));
  show({ role: "viewer" });
  const draft = within(await screen.findByRole("region", { name: "Draft plan" }));
  expect(draft.getByText("Meetings: 4, counted by Direx from meetings marked on People")).toBeTruthy();
  cleanup();
  show();
  expect((await screen.findByRole("combobox", { name: "Where measure 1's number comes from" })).textContent).toContain("Counted by Direx from meetings marked on People");
});

test("a draft that ran on the subscription says so under Cost, not $0.00, and a run that never reached a model gives no untested warning", async () => {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/plans/{id}") return reply(200, plan());
    if (path === "/api/w/{workspaceId}/facts") return reply(200, { facts: [] });
    if (path === "/api/w/{workspaceId}/agents/runs/{id}") return reply(200, { status: "succeeded", statusReason: null, proposals: [], costMicros: "0", subscription: true, unevaluated: true });
    return reply(404, { error: "not_found" });
  }) as never);
  show({ runId: RUN });
  const cost = (await screen.findByText("Cost")).closest("details")!;
  expect(cost.textContent).toContain("It ran on your subscription.");
  expect(cost.textContent).not.toContain("$0.00");
  cleanup();
  vi.mocked(api.GET).mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/plans/{id}") return reply(200, plan());
    if (path === "/api/w/{workspaceId}/agents/runs/{id}") return reply(200, { status: "failed", statusReason: "no_connection", proposals: [], costMicros: "0", subscription: false, unevaluated: true });
    return reply(404, { error: "not_found" });
  }) as never);
  show({ runId: RUN });
  const stopped = (await screen.findByText("Cost")).closest("details")!;
  expect(stopped.textContent).not.toContain("Untested model");
});

test("counted plan measures use neutral wording when the campaign send state is unknown", async () => {
  const measures = ["replies", "interested_replies"].map((source) => ({ ...body.measures[0], key: source, label: source, source, latest: null }));
  serve(() => reply(200, plan({ tracking: { ...tracking, measures } })));
  show({ role: "viewer" });
  const m = within(await screen.findByRole("region", { name: "Measures" }));
  expect(m.getByText("Counted by Direx from email replies. Direx counts each morning.")).toBeTruthy();
  expect(m.getByText("Counted by Direx from replies labelled interested. Direx counts each morning.")).toBeTruthy();
  expect(m.queryByText(/Waiting for the first email/)).toBeNull();
});
