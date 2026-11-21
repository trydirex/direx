// SPDX-License-Identifier: AGPL-3.0-only
// Home, the Calendar, Review and the Item panel in a DOM: loading and error states, the panel as a
// dialog that takes and gives back focus, the count before Approve all clean, and Review's keys.
import { afterEach, expect, test, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { listFor, openDialog, pick, setDateTime, withQueries } from "../testing";
import { listTime, shortTime, type Item } from "./actions";
import { Calendar } from "./Calendar";
import { Review } from "./Review";
import { byDeadline, firstRows, Home, HOME_ROWS } from "./Home";
import { WorkspaceSwitcher } from "../identity/WorkspaceSwitcher";
import { FeedText, ItemPanel, ItemDialog } from "./ItemPanel";

const W = "00000000-0000-4000-8000-0000000000aa";
const MONDAY = new Date(2026, 10, 2);
const at = new Date(2026, 10, 3, 9, 0).toISOString();
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const show = (el: ReactElement) => render(withQueries(createElement(RouterContextProvider, { router, children: el })));

const item = (o: Partial<Item> = {}): Item => ({
  id: "i1",
  kind: "action",
  state: "needs_approval",
  reason: null,
  reasonCode: null,
  revision: 2,
  title: "First post",
  workArea: null,
  channel: "post",
  groupKey: null,
  groupLabel: null,
  at,
  warnings: [],
  clean: true,
  movable: true,
  decideBy: null,
  snoozedUntil: null,
  createdAt: at,
  ...o,
});

/** An email the recipient writer wrote for one person, which it can rewrite. */
const WRITER = { run: { id: "r0", agent: "recipient_writer", at }, planId: null, step: { campaignId: "c1", stepKey: "first" }, facts: [], lessons: [], voice: false };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The Item list answers `list()` (or fails while `fail`); each Item answers from the list, as `state()` says. */
function serve(o: { list: () => Item[]; fail?: () => boolean; state?: (i: Item) => Item["state"]; days?: () => unknown[]; content?: (i: Item) => unknown; warning?: boolean; recipient?: unknown; writtenFrom?: unknown; strategy?: unknown }) {
  vi.spyOn(api, "GET").mockImplementation(((path: string, init: { params: { path: { id?: string } } }) => {
    if (o.fail?.()) return reply(403, { error: "forbidden" });
    const list = o.list();
    if (path === "/api/w/{workspaceId}/items") return reply(200, { items: list, needsYouCount: list.length });
    if (path === "/api/w/{workspaceId}/review-rates") return reply(200, { decisions: 100, medianSeconds: 4, changedShare: 0, warning: o.warning ?? false });
    if (path === "/api/w/{workspaceId}/campaign-launches") return reply(200, { launches: [] });
    if (path === "/api/w/{workspaceId}/mailbox-days") return reply(200, { days: o.days?.() ?? [] });
    if (path === "/api/w/{workspaceId}/items/{id}") {
      const i = list.find((x) => x.id === init.params.path.id) ?? item({ id: init.params.path.id });
      return reply(200, { item: { ...i, state: o.state?.(i) ?? i.state }, content: o.content?.(i) ?? { body: "Hello" }, timeline: [], ruleGrantedBy: null, ...(o.recipient !== undefined && { recipient: o.recipient }), ...(o.writtenFrom !== undefined && { writtenFrom: o.writtenFrom }) });
    }
    if (path === "/api/w/{workspaceId}/strategy" && o.strategy) return reply(200, { current: o.strategy });
    return reply(404, { error: "not_found" });
  }) as never);
  return vi.spyOn(api, "POST").mockImplementation(((path: string) => reply(200, path.endsWith("approve-clean") || path.endsWith("/move") ? { results: [{ id: "i1", ok: true }] } : {})) as never);
}

const loading = () => expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);

async function failsThenRetries(el: ReactElement, loaded: string) {
  let fail = true;
  serve({ list: () => [item()], fail: () => fail });
  show(el);
  expect((await screen.findByRole("alert")).textContent).toContain("Your role doesn't allow that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect((await screen.findAllByText(loaded)).length).toBeGreaterThan(0);
}

test("Review shows a loading state, then what needs you with the first Item open beside the queue", async () => {
  serve({ list: () => [item()] });
  show(<Review workspaceId={W} role="marketer" />);
  loading();
  expect(await screen.findByRole("heading", { name: "First post" })).toBeTruthy();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Review");
  expect(screen.getByRole("heading", { level: 2, name: "Waiting for you (1)" })).toBeTruthy();
  expect(within(screen.getByRole("navigation", { name: "Queue" })).getByRole("button", { name: "Open First post" }).getAttribute("aria-current")).toBe("true");
});

test("when Home's list can't be read, it says so and Retry reads it again", () => failsThenRetries(<Review workspaceId={W} role="marketer" />, "First post"));

test("to a Contributor or Viewer the queue waits for approval, since they can't clear it", async () => {
  serve({ list: () => [item()] });
  show(<Review workspaceId={W} role="contributor" />);
  expect(await screen.findByRole("heading", { level: 2, name: "Waiting for approval (1)" })).toBeTruthy();
});

test("Approve all clean states its count before anything is approved, and Cancel approves nothing", async () => {
  const post = serve({ list: () => [item(), item({ id: "i2", title: "Second", clean: false, warnings: [{ code: "unspecified", text: "x" }] })] });
  show(<Review workspaceId={W} role="owner" />);
  await userEvent.click(await screen.findByRole("button", { name: "Approve 1 with no warnings" }));
  const dialog = await screen.findByRole("dialog", { name: "Approve 1 with no warnings?" });
  expect(within(dialog).getByText("Approve 1 with no warnings?")).toBeTruthy();
  expect(within(within(dialog).getByRole("list", { name: "To approve" })).getAllByRole("listitem").map((li) => li.textContent?.startsWith("First post"))).toEqual([true]);
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(post).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Approve 1 with no warnings" }));
  await userEvent.click(within(await screen.findByRole("dialog", { name: "Approve 1 with no warnings?" })).getByRole("button", { name: "Approve 1" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/approve-clean", { params: { path: { workspaceId: W } }, body: { items: [{ id: "i1", revision: 2 }] } });
  expect((await screen.findByText(/^Approved 1\./)).textContent).toBe("Approved 1.");
  // They left the queue, so the toast keeps Don't send for each one approved.
  const inToast = (await screen.findAllByRole("button", { name: "Don't send" })).filter((b) => !b.closest("article"));
  await userEvent.click(inToast[0]!);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/cancel", { params: { path: { workspaceId: W, id: "i1" } } });
  expect(await screen.findByText("Not sent. It won't go out.")).toBeTruthy();
});

test("with one kind shown, Approve with no warnings lists and approves only that kind", async () => {
  const post = serve({ list: () => [item({ id: "i1", title: "Launch post", workArea: "social" }), item({ id: "i2", title: "Launch email", workArea: "outreach", channel: "email" })] });
  show(<Review workspaceId={W} role="owner" />);
  await userEvent.click(await screen.findByRole("button", { name: "Approve 2 with no warnings" }));
  const both = await screen.findByRole("dialog", { name: "Approve 2 with no warnings?" });
  expect(within(both).getAllByRole("listitem")).toHaveLength(2);
  await userEvent.click(within(both).getByRole("button", { name: "Cancel" }));

  await userEvent.click(within(screen.getByRole("group", { name: "Show" })).getByRole("button", { name: "Post 1" }));
  await userEvent.click(screen.getByRole("button", { name: "Approve 1 with no warnings" }));
  const dialog = await screen.findByRole("dialog", { name: "Approve 1 with no warnings?" });
  expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent?.startsWith("Launch post"))).toEqual([true]);
  await userEvent.click(within(dialog).getByRole("button", { name: "Approve 1" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/approve-clean", { params: { path: { workspaceId: W } }, body: { items: [{ id: "i1", revision: 2 }] } });
});

test("Home pins what is stuck, lists the waiting drafts, and approves only the ticked ones after naming them", async () => {
  const post = serve({
    list: () => [
      item(),
      item({ id: "i2", title: "Second", clean: false, warnings: [{ code: "unspecified", text: "check the claim" }] }),
      item({ id: "i3", title: "Third" }),
      item({ id: "h1", title: "Stuck email", state: "held", reason: "the account is disconnected", reasonCode: "credential_unavailable" }),
      item({ id: "h2", title: "Odd email", state: "held", reason: "something new" }),
    ],
  });
  show(<Home workspaceId={W} role="owner" />);
  expect(await screen.findByRole("heading", { level: 2, name: "Needs you (5)" })).toBeTruthy();
  const fix = within(screen.getByRole("list", { name: "Needs a fix" }));
  expect(fix.getByText("Held: the account is disconnected")).toBeTruthy();
  // The button names the fix; a reason Direx has no fix for still says "Fix it".
  expect(fix.getByRole("link", { name: "Reconnect the account" }).getAttribute("href")).toBe(`/w/${W}/review/h1`);
  expect(fix.getByRole("link", { name: "Fix it" }).getAttribute("href")).toBe(`/w/${W}/review/h2`);
  expect(screen.getByRole("link", { name: "Open Second" }).getAttribute("href")).toBe(`/w/${W}/review/i2`);
  expect(screen.getByRole("link", { name: "Review all 5" }).getAttribute("href")).toBe(`/w/${W}/review`);
  // A draft with a warning has no tick: it needs its own read.
  expect(screen.queryByRole("checkbox", { name: "Approve Second with the others" })).toBeNull();
  await userEvent.click(screen.getByRole("checkbox", { name: "Approve Third with the others" }));
  await userEvent.click(screen.getByRole("button", { name: "Approve 1 ticked" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Approve 1?" }));
  expect(dialog.getByText("First post")).toBeTruthy();
  expect(dialog.queryByText("Third")).toBeNull();
  await userEvent.click(dialog.getByRole("button", { name: "Approve 1" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/approve-clean", { params: { path: { workspaceId: W } }, body: { items: [{ id: "i1", revision: 2 }] } });
});

test("Home lists at most five waiting drafts, soonest first by when they go out, and points to Review for the rest", async () => {
  const now = new Date(2026, 10, 9, 8, 0);
  const on = (day: number) => new Date(2026, 10, day, 10).toISOString();
  const rows = [item({ id: "a", at: on(20) }), item({ id: "b", at: on(9) }), item({ id: "c", kind: "fact_proposal" }), item({ id: "d", at: on(11) }), item({ id: "e", at: null }), item({ id: "f", at: on(12) }), item({ id: "g", at: on(13) })];
  const groups = byDeadline(rows, now);
  expect(groups.map((g) => [g.title, g.rows.map((i) => i.id)])).toEqual([
    ["Goes out today", ["b"]],
    ["Later this week", ["d", "f", "g"]],
    ["Later", ["a", "e"]],
    ["To decide", ["c"]],
  ]);
  expect(firstRows(groups, HOME_ROWS).map((g) => [g.title, g.rows.length])).toEqual([["Goes out today", 1], ["Later this week", 3], ["Later", 1]]);
  serve({ list: () => rows.map((r, n) => ({ ...r, title: `Draft ${n}` })) });
  show(<Home workspaceId={W} role="contributor" />);
  expect(await screen.findByRole("link", { name: "2 more in Review" })).toBeTruthy();
  // Only an approver ticks and approves.
  expect(screen.queryByRole("checkbox")).toBeNull();
});

test("Home and the Workspace switcher name the other clients with something waiting", async () => {
  const W2 = "00000000-0000-4000-8000-0000000000bb";
  const W3 = "00000000-0000-4000-8000-0000000000cc";
  const org = { id: "00000000-0000-4000-8000-0000000000dd", name: "Agency" };
  const ws = [{ id: W, name: "Acme", role: "owner", organization: org }, { id: W2, name: "Fernhill", role: "owner", organization: org }, { id: W3, name: "Tidewater", role: "owner", organization: org }];
  const waiting: Record<string, number> = { [W]: 1, [W2]: 2, [W3]: 0 };
  vi.spyOn(api, "GET").mockImplementation(((path: string, init?: { params: { path: { workspaceId: string } } }) => {
    if (path === "/api/me/workspaces") return reply(200, { workspaces: ws });
    if (path === "/api/w/{workspaceId}/items") return reply(200, { items: init!.params.path.workspaceId === W ? [item()] : [], needsYouCount: waiting[init!.params.path.workspaceId] });
    return reply(404, { error: "not_found" });
  }) as never);
  show(<Home workspaceId={W} role="owner" />);
  expect((await screen.findByRole("link", { name: "Fernhill (2)" })).getAttribute("href")).toBe(`/w/${W2}`);
  expect(screen.queryByText(/Tidewater/)).toBeNull();
  expect(screen.queryByRole("link", { name: /^Acme/ })).toBeNull();
  cleanup();
  render(withQueries(<WorkspaceSwitcher workspaces={ws as never} current={W} onSwitch={() => {}} waiting={waiting} />));
  expect(screen.getByRole("option", { name: "Fernhill · 2 need you" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "Tidewater" })).toBeTruthy();
});

test("an empty Home says nothing is waiting and points to the Calendar", async () => {
  serve({ list: () => [] });
  show(<Home workspaceId={W} role="owner" />);
  expect(await screen.findByText("Nothing is waiting for you")).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "Open the Calendar" })[0]!.getAttribute("href")).toBe(`/w/${W}/calendar`);
});

test("the Calendar's Item panel opens as a dialog: focus moves in, Escape closes it, focus goes back", async () => {
  onMonday();
  serve({ list: () => [item()] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="marketer" start={MONDAY} />);
  const open = await screen.findByRole("button", { name: "First post" });
  await userEvent.click(open);
  const dialog = await screen.findByRole("dialog", { name: "First post" });
  await within(dialog).findByRole("heading", { name: "First post" });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(openDialog()).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(open));
  // Close inside the panel closes it too.
  await userEvent.click(open);
  await userEvent.click(within(await screen.findByRole("dialog", { name: "First post" })).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(openDialog()).toBeNull());
});

test("the Calendar shows a loading state, then the week's chips, and its chip opens the Item", async () => {
  serve({ list: () => [item()] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="marketer" start={MONDAY} />);
  loading();
  await userEvent.click(await screen.findByRole("button", { name: "First post" }));
  expect(await screen.findByRole("dialog", { name: "First post" })).toBeTruthy();
});

test("when the Calendar's week can't be read, it says so and Retry reads it again", () => failsThenRetries(<Calendar ItemView={ItemDialog} workspaceId={W} role="marketer" start={MONDAY} />, "First post"));

test("Review shows a loading state, then one Item with the queue beside it", async () => {
  serve({ list: () => [item(), item({ id: "i2", title: "Held one", state: "held", reason: "not sure it sent", reasonCode: "outcome_unknown" })] });
  show(<Review workspaceId={W} role="marketer" />);
  loading();
  const queue = await screen.findByRole("navigation", { name: "Queue" });
  expect(within(queue).getAllByRole("button").map((b) => b.getAttribute("aria-current"))).toEqual(["true", null]);
  // Held says why.
  expect(within(queue).getByText("Held: not sure it sent")).toBeTruthy();
  expect(await screen.findByRole("article", { name: "First post" })).toBeTruthy();
});

test("when Review's queue can't be read, it says so and Retry reads it again", () => failsThenRetries(<Review workspaceId={W} role="marketer" />, "First post"));

test("Home with nothing waiting says so", async () => {
  serve({ list: () => [] });
  show(<Review workspaceId={W} role="marketer" />);
  expect(await screen.findByText("Nothing is waiting for you")).toBeTruthy();
});

test("Review is worked by keyboard: J and S move on, S sends the Item to the back, K goes back, each also a button", async () => {
  serve({ list: () => [item(), item({ id: "i2", title: "Second" }), item({ id: "i3", title: "Third" })] });
  show(<Review workspaceId={W} role="marketer" />);
  await screen.findByRole("article", { name: "First post" });
  await userEvent.keyboard("j");
  expect(await screen.findByRole("article", { name: "Second" })).toBeTruthy();
  await userEvent.keyboard("s");
  expect(await screen.findByRole("article", { name: "Third" })).toBeTruthy();
  const queue = () => within(screen.getByRole("navigation", { name: "Queue" })).getAllByRole("button").map((b) => b.textContent);
  // Rows name their title last; Needs approval is the default here, so no chip says it.
  expect(queue().map((t) => ["First post", "Third", "Second"].find((title) => t?.endsWith(title)))).toEqual(["First post", "Third", "Second"]);
  expect(queue().some((t) => t?.includes("Needs approval"))).toBe(false);
  // Skipped, Second is now last, so K from Third goes to the top.
  await userEvent.keyboard("k");
  expect(await screen.findByRole("article", { name: "First post" })).toBeTruthy();
  // Past either end nothing moves.
  await userEvent.click(screen.getByRole("button", { name: "Previous" }));
  await userEvent.click(screen.getByRole("button", { name: "Previous" }));
  expect(await screen.findByRole("article", { name: "First post" })).toBeTruthy();
  for (const name of ["Next", "Skip"]) await userEvent.click(screen.getByRole("button", { name }));
  expect(await screen.findByRole("article", { name: "Second" })).toBeTruthy();
  // A shortcut with Ctrl is someone else's.
  await userEvent.keyboard("{Control>}k{/Control}");
  expect(screen.getByRole("article", { name: "Second" })).toBeTruthy();
});

test("the next Item loads while one is read, so J opens it with no new request", async () => {
  serve({ list: () => [item(), item({ id: "i2", title: "Second" })] });
  show(<Review workspaceId={W} role="marketer" />);
  await screen.findByRole("article", { name: "First post" });
  const reads = () => vi.mocked(api.GET).mock.calls.filter((c) => (c[1] as { params: { path: { id?: string } } } | undefined)?.params.path.id === "i2").length;
  await waitFor(() => expect(reads()).toBe(1));
  await userEvent.keyboard("j");
  expect(await screen.findByRole("article", { name: "Second" })).toBeTruthy();
  expect(reads()).toBe(1);
});

test("a reviewer moving faster and changing less is asked if they're still reading, and nothing is blocked", async () => {
  serve({ list: () => [item()], warning: true });
  show(<Review workspaceId={W} role="marketer" />);
  expect(await screen.findByText("You're moving quickly today. The warnings are worth a glance before the rest.")).toBeTruthy();
  expect(within(await screen.findByRole("article", { name: "First post" })).getByRole("button", { name: /^Approve/ })).toBeTruthy();
});

test("A approves, naming when it sends and in which zone, says the approved send is Scheduled, not Sent, and moves on", async () => {
  let approved = false;
  const post = serve({ list: () => (approved ? [item({ id: "i2", title: "Second" })] : [item(), item({ id: "i2", title: "Second" })]), state: (i) => (approved && i.id === "i1" ? "scheduled" : i.state) });
  post.mockImplementation((() => {
    approved = true;
    return reply(200, {});
  }) as never);
  show(<Review workspaceId={W} role="marketer" />);
  const panel = await screen.findByRole("article", { name: "First post" });
  const button = await within(panel).findByRole("button", { name: /^Approve · sends Tue/ });
  expect(button.getAttribute("aria-keyshortcuts")).toBe("A");
  const zone = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date(at)).find((x) => x.type === "timeZoneName")!.value;
  // A time outside the coming six days carries its date, so "Tue" can't be read as this week's.
  expect(button.textContent).toBe(`Approve · sends ${new Date(at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} ${zone}A`);
  expect([listTime(new Date(2026, 10, 14, 9), new Date(2026, 10, 12, 15)), listTime(new Date(2026, 10, 19, 9), new Date(2026, 10, 12, 15))]).toEqual([shortTime(new Date(2026, 10, 14, 9)), new Date(2026, 10, 19, 9).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })]);
  await userEvent.keyboard("a");
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: "i1" } }, body: { revision: 2, openedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) } });
  // The approved one leaves the queue; a toast stamps it Scheduled with its send time, and the next one takes its place.
  expect(await screen.findByRole("img", { name: `Scheduled, ${listTime(new Date(at))}` })).toBeTruthy();
  expect(screen.queryByText(/Sent/)).toBeNull();
  await waitFor(() => expect(within(screen.getByRole("navigation", { name: "Queue" })).queryByText("First post")).toBeNull());
  expect(screen.getByText("1 of 1")).toBeTruthy();
  expect(await screen.findByRole("article", { name: "Second" })).toBeTruthy();
});

test("the Scheduled toast keeps Don't send, which cancels the send that left the queue", async () => {
  let approved = false;
  const post = serve({ list: () => (approved ? [item({ id: "i2", title: "Second" })] : [item(), item({ id: "i2", title: "Second" })]), state: (i) => (approved && i.id === "i1" ? "scheduled" : i.state) });
  post.mockImplementation((() => {
    approved = true;
    return reply(200, {});
  }) as never);
  show(<Review workspaceId={W} role="marketer" />);
  await within(await screen.findByRole("article", { name: "First post" })).findByRole("button", { name: /^Approve · sends/ });
  await userEvent.keyboard("a");
  // The next Item's panel has its own Don't send; the toast's is the one outside every panel.
  await screen.findByRole("img", { name: /^Scheduled, / });
  const inToast = (await screen.findAllByRole("button", { name: "Don't send" })).filter((b) => !b.closest("article"));
  expect(inToast).toHaveLength(1);
  await userEvent.click(inToast[0]!);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/cancel", { params: { path: { workspaceId: W, id: "i1" } } });
  expect(await screen.findByText("Not sent. It won't go out.")).toBeTruthy();
});

test("E goes to the edit, and keys typed in a field are words, not shortcuts", async () => {
  const post = serve({ list: () => [item(), item({ id: "i2", title: "Second" })] });
  show(<Review workspaceId={W} role="marketer" />);
  await screen.findByRole("article", { name: "First post" });
  const field = await screen.findByLabelText("Send at");
  await userEvent.keyboard("e");
  expect(document.activeElement).toBe(field);
  await userEvent.keyboard("jaks");
  expect(screen.getByRole("article", { name: "First post" })).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
  // A contenteditable counts as a field too.
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  document.body.append(editor);
  editor.focus();
  await userEvent.keyboard("j");
  expect(screen.getByRole("article", { name: "First post" })).toBeTruthy();
  editor.remove();
});

test("on the suggestions for the Strategy, A adds the ticked ones and E goes to the first one's words, not its box", async () => {
  const suggestions = [
    { assumption: "Ops leads answer a second email.", because: "12 replies came after it.", readingIds: ["r1"] },
    { assumption: "LinkedIn DMs help with ops leads.", because: "11 interested were reached both ways.", readingIds: ["r1"] },
  ];
  const assumptions = item({ kind: "strategy_assumptions", title: "Add 2 assumptions to your Strategy?", at: null });
  const post = serve({ list: () => [assumptions], content: () => ({ campaignId: "c9", suggestions }) });
  show(<Review workspaceId={W} role="marketer" />);
  const panel = await screen.findByRole("article", { name: "Add 2 assumptions to your Strategy?" });
  const add = await within(panel).findByRole("button", { name: /^Add 2 to the Strategy/ });
  expect(add.getAttribute("aria-keyshortcuts")).toBe("A");
  await userEvent.keyboard("e");
  expect(document.activeElement).toBe(within(panel).getByRole("textbox", { name: "Suggestion 1" }));
  (document.activeElement as HTMLElement).blur();
  await userEvent.keyboard("a");
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", expect.objectContaining({ body: expect.objectContaining({ choice: JSON.stringify({ add: [{ index: 0 }, { index: 1 }] }) }) }));
});

test("Edit (E) shows only where the open Item can still change and this person may change it", async () => {
  serve({ list: () => [item()] });
  show(<Review workspaceId={W} role="viewer" />);
  await screen.findByRole("article", { name: "First post" });
  expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
  cleanup();
  // A cancelled Item opened from a link: nothing to edit, and E does nothing.
  serve({ list: () => [], state: () => "cancelled" });
  show(<Review workspaceId={W} role="marketer" open="i9" />);
  await within(await screen.findByRole("article", { name: "First post" })).findByText("Cancelled");
  expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
  cleanup();
  serve({ list: () => [item()] });
  show(<Review workspaceId={W} role="marketer" />);
  expect(await screen.findByRole("button", { name: /^Edit/ })).toBeTruthy();
});

test("a dismissed notice toasts Dismissed, as its button said, not Cancelled", async () => {
  let gone = false;
  const notice = item({ kind: "next_step", title: "Draft the templates" });
  const post = serve({ list: () => (gone ? [] : [notice]) });
  const get = vi.mocked(api.GET).getMockImplementation() as unknown as (path: string, init: never) => unknown;
  vi.mocked(api.GET).mockImplementation(((path: string, init: never) => (path === "/api/w/{workspaceId}/items/{id}" ? reply(200, { item: { ...notice, state: gone ? "cancelled" : notice.state }, content: {}, timeline: [], ruleGrantedBy: null }) : get(path, init))) as never);
  post.mockImplementation((() => {
    gone = true;
    return reply(200, {});
  }) as never);
  show(<Review workspaceId={W} role="marketer" />);
  await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
  expect(await screen.findByText("Draft the templates: Dismissed")).toBeTruthy();
  expect(screen.queryByText("Draft the templates: Cancelled")).toBeNull();
});

test("the address follows the Item on screen, so a reload opens it again", async () => {
  serve({ list: () => [item(), item({ id: "i2", title: "Second" })] });
  const onOpen = vi.fn();
  show(<Review workspaceId={W} role="marketer" onOpen={onOpen} />);
  await screen.findByRole("article", { name: "First post" });
  expect(onOpen).toHaveBeenLastCalledWith("i1");
  await userEvent.keyboard("j");
  await screen.findByRole("article", { name: "Second" });
  expect(onOpen).toHaveBeenLastCalledWith("i2");
});

// The Calendar's tests live in the week of MONDAY; past days take no moves, so it is Monday there.
const onMonday = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MONDAY);
};
const dayLabel = (d: number) => new Date(2026, 10, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

test("the day and view come from the URL and paging asks for others; Today returns; today is marked and past days take no moves", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 4, 12));
  serve({ list: () => [item()] });
  const onNavigate = vi.fn();
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" date="2026-11-04" view="week" onNavigate={onNavigate} />);
  await screen.findByRole("button", { name: "First post" });
  const regions = screen.getAllByRole("region");
  expect(regions.find((r) => r.getAttribute("aria-current") === "date")?.getAttribute("aria-label")).toBe(dayLabel(4));
  // A week column sorts its cards under the part of the day, and its header opens the day, saying how many need you.
  expect(screen.getByText("Morning")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: `Open ${dayLabel(3)}, 1 needs you` }));
  expect(onNavigate).toHaveBeenLastCalledWith({ date: "2026-11-03", view: "day" });
  await userEvent.click(screen.getByRole("button", { name: "Next week" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ date: "2026-11-09", view: "week" });
  await userEvent.click(screen.getByRole("button", { name: "Today" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ date: "2026-11-04", view: "week" });
  await userEvent.click(screen.getByRole("button", { name: "Month" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ date: "2026-11-04", view: "month" });
  cleanup();
  // The day's Move to menu offers the days from today, not the chip's Monday, since Monday has passed.
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={new Date(2026, 10, 3)} view="day" />);
  const move = await screen.findByRole("button", { name: "Move First post to another day" });
  await userEvent.click(move);
  expect((await listFor(move).findAllByRole("menuitem")).map((m) => m.textContent)).toEqual([4, 5, 6, 7, 8, 9, 10].map(dayLabel));
});

test("the day shows its cards in time order, split at a line for now, and pages by day", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 3, 12));
  serve({ list: () => [item(), item({ id: "i2", title: "Afternoon post", at: new Date(2026, 10, 3, 15).toISOString() })] });
  const onNavigate = vi.fn();
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" date="2026-11-03" view="day" onNavigate={onNavigate} />);
  await screen.findByRole("button", { name: "First post" });
  expect(screen.getAllByRole("region").filter((r) => r.getAttribute("aria-label") !== "Notifications").map((r) => r.getAttribute("aria-label"))).toEqual([dayLabel(3)]);
  const order = () => Array.from(document.querySelectorAll("button, hr")).map((e) => (e.tagName === "HR" ? "now" : e.textContent)).filter((t) => t === "now" || t === "First post" || t === "Afternoon post");
  expect(order()).toEqual(["First post", "now", "Afternoon post"]);
  await userEvent.click(screen.getByRole("button", { name: "Next day" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ date: "2026-11-04", view: "day" });
  cleanup();
  // Today's column in the week splits at the same line.
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" date="2026-11-03" view="week" onNavigate={onNavigate} />);
  await screen.findByRole("button", { name: "First post" });
  expect(order()).toEqual(["First post", "now", "Afternoon post"]);
});

test("the month shows three chips a day with what needs you first, '+N more' opens the rest in place, the day's number opens that day, and paging moves a month", async () => {
  onMonday();
  serve({ list: () => ["a", "b", "c", "d"].map((id) => item({ id, title: `Post ${id}`, state: id === "d" ? "needs_approval" : "scheduled" })) });
  const onNavigate = vi.fn();
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" date="2026-11-04" view="month" onNavigate={onNavigate} />);
  await screen.findByRole("button", { name: "Post a" });
  expect(screen.getByRole("button", { name: "Post d" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Post c" })).toBeNull();
  // Monday 26 Oct to Sunday 6 Dec: the whole weeks that hold November.
  expect(screen.getAllByRole("region").filter((r) => r.getAttribute("aria-label") !== "Notifications")).toHaveLength(42);
  await userEvent.click(screen.getByRole("button", { name: "+1 more" }));
  expect(screen.getByRole("button", { name: "Post c" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Show less" }));
  expect(screen.queryByRole("button", { name: "Post c" })).toBeNull();
  expect(onNavigate).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: `Open ${dayLabel(20)}` }));
  expect(onNavigate).toHaveBeenLastCalledWith({ date: "2026-11-20", view: "day" });
  await userEvent.click(screen.getByRole("button", { name: "Next month" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ date: "2026-12-01", view: "month" });
});

test("the Calendar names the range it shows, marks each card's channel, filters to what needs you, and Review them opens it in place", async () => {
  onMonday();
  serve({ list: () => [item({ title: "Waiting post", workArea: "social", channel: "linkedin" }), item({ id: "i2", title: "Booked email", state: "scheduled", workArea: "outreach", channel: "email" })] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={new Date(2026, 10, 3)} view="day" />);
  await screen.findByRole("button", { name: "Waiting post" });
  expect(screen.getByRole("heading", { level: 2 }).textContent).toBeTruthy();
  // The channel is a named glyph, not a colour alone.
  expect(screen.getAllByRole("img", { name: "LinkedIn" }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("img", { name: "Email" }).length).toBeGreaterThan(0);

  const only = screen.getByRole("button", { name: "Only what needs you" });
  await userEvent.click(only);
  expect(only.getAttribute("aria-pressed")).toBe("true");
  expect(screen.queryByRole("button", { name: "Booked email" })).toBeNull();
  expect(screen.getByRole("button", { name: "Waiting post" })).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "Review them" }));
  expect(await screen.findByRole("dialog", { name: "Waiting post" })).toBeTruthy();
});

test("a day card shows its time, channel, reason and a Review for warnings; the day says how many need you", async () => {
  onMonday();
  serve({
    list: () => [
      item(),
      item({ id: "i2", title: "Risky post", clean: false, warnings: [{ code: "unspecified", text: "Campaign launches that day." }] as never }),
      item({ id: "i3", title: "Held post", state: "held", reasonCode: "cap", reason: "over the cap" }),
    ],
  });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={new Date(2026, 10, 3)} view="day" />);
  await screen.findByRole("button", { name: "First post" });
  expect(screen.getByText(/^3 need you on this day\./)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Review them" })).toBeTruthy();
  expect(screen.getAllByText(`${new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · post`)).toHaveLength(3);
  expect(screen.getByText("over the cap")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Review Risky post: 1 with warnings" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Approve · sends.*Risky post$/ })).toBeNull();
  cleanup();
  // A Campaign step's draft says when its yes is due; one past that says it was due.
  serve({ list: () => [item({ decideBy: new Date(2026, 10, 2, 15).toISOString() }), item({ id: "i2", title: "Late one", decideBy: new Date(2026, 10, 1, 9).toISOString() })] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={new Date(2026, 10, 3)} view="day" />);
  expect(await screen.findByText(`Decide by ${dayLabel(2)}, ${new Date(2026, 10, 2, 15).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`)).toBeTruthy();
  expect(screen.getByText(/^Was due /)).toBeTruthy();
});

test("a group's card counts its Items by state and lists each; the open Item is in the URL", async () => {
  onMonday();
  const group = { groupKey: "q4", groupLabel: "Q4 ops" };
  serve({ list: () => [item({ id: "g1", title: "To Ann", state: "scheduled", ...group }), item({ id: "g2", title: "To Bo", ...group })] });
  const onItem = vi.fn();
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={MONDAY} onItem={onItem} />);
  expect(await screen.findByText("1 Scheduled, 1 Needs approval")).toBeTruthy();
  await userEvent.click(screen.getByText("1 Scheduled, 1 Needs approval"));
  await userEvent.click(screen.getByRole("button", { name: /To Bo · Needs approval$/ }));
  expect(onItem).toHaveBeenLastCalledWith("g2");
  cleanup();
  serve({ list: () => [item()] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={MONDAY} item="i1" onItem={onItem} />);
  expect(await screen.findByRole("dialog")).toBeTruthy();
});

test("a launch moves from the Calendar: a preview says what follows it, then the move; a viewer gets only the link", async () => {
  onMonday();
  vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    reply(200, path.endsWith("/campaign-launches") ? { launches: [{ campaignId: "c1", title: "Q4 push", on: "2026-11-04" }] } : { items: [], needsYouCount: 0 })) as never);
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { from: "2026-11-04", to: "2026-11-06", moved: 3, kept: 0, backToApproval: 1, overCap: 0, failed: 0 })) as never);
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={MONDAY} />);
  await userEvent.click(await screen.findByText("Move the launch"));
  const day = screen.getByLabelText("New launch day for Q4 push");
  fireEvent.change(day, { target: { value: "2026-11-06" } });
  await userEvent.click(screen.getByRole("button", { name: "Preview" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/campaigns/{id}/anchor", expect.objectContaining({ body: { on: "2026-11-06", preview: true } }));
  expect(await screen.findByText(/^3 not yet sent move with it\. 1 approved needs approving again/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Move the launch" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/campaigns/{id}/anchor", expect.objectContaining({ body: { on: "2026-11-06", preview: false } }));
  cleanup();
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="viewer" start={MONDAY} />);
  await screen.findByRole("link", { name: "Launch: Q4 push" });
  expect(screen.queryByText("Move the launch")).toBeNull();
});

test("a day with several chips approves its clean Items after a confirm; warned ones stay; one chip has no day button", async () => {
  onMonday();
  const post = serve({ list: () => [item(), item({ id: "i2", title: "Second post" }), item({ id: "i3", title: "Risky post", clean: false })] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={new Date(2026, 10, 3)} view="day" />);
  await userEvent.click(await screen.findByRole("button", { name: `Approve the day: ${dayLabel(3)}, 2 with no warnings` }));
  expect(post).not.toHaveBeenCalled();
  expect(screen.getByText("2 go out as scheduled. Items with warnings stay for review.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Approve 2" }));
  await waitFor(() => expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/approve-clean", { params: { path: { workspaceId: W } }, body: { items: [{ id: "i1", revision: 2 }, { id: "i2", revision: 2 }] } }));
  cleanup();
  // The week offers no day approval even with several chips: its cards open the Item panel; approving and moving happen there or in the day.
  serve({ list: () => [item(), item({ id: "i2", title: "Second post" })] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={MONDAY} />);
  await screen.findByRole("button", { name: "First post" });
  expect(screen.queryByRole("button", { name: /^Approve the day/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Approve · sends/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Move First post to another day" })).toBeNull();
});

test("a week day shows each email account's count against its limit; the month badges only one at or near it", async () => {
  onMonday();
  const box = (n: string, day: string, counted: number, limit: number) => ({ credentialId: `00000000-0000-4000-8000-0000000000c${n}`, name: `${n}@acme.test`, day, counted, limit });
  serve({ list: () => [item()], days: () => [box("1", "2026-11-03", 50, 50), box("2", "2026-11-04", 12, 80), box("3", "2026-11-05", 33, 40)] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={MONDAY} />);
  await screen.findByRole("button", { name: "First post" });
  const region = (d: number) => screen.getAllByRole("region").find((r) => r.getAttribute("aria-label") === dayLabel(d))!;
  expect((await within(region(3)).findByTitle("1@acme.test: 50 of 50 emails a day")).textContent).toBe("1@acme.test50/50 full");
  expect(within(region(5)).getByText("33/40")).toBeTruthy();
  // 12 of 80 is far from full: the count shows, with no warning.
  expect(within(region(4)).getByText("12/80")).toBeTruthy();
  expect(within(region(5)).queryByText(/full/)).toBeNull();
  cleanup();
  // The month has no room for bars, so it badges only a day at or near the limit.
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={MONDAY} view="month" />);
  expect(await screen.findByText("Email account full")).toBeTruthy();
  expect(screen.getByText("Email account nearly full")).toBeTruthy();
});

test("undated Items that need you sit in a tray above the week, a step with nothing drafted shows on its day, and Day opens on today", async () => {
  onMonday();
  const post = serve({ list: () => [item(), item({ id: "u1", title: "Undated note", at: null })] });
  const get = vi.mocked(api.GET);
  const base = get.getMockImplementation() as unknown as (path: string, init: unknown) => unknown;
  get.mockImplementation(((path: string, init: unknown) =>
    path === "/api/w/{workspaceId}/campaign-steps"
      ? reply(200, { steps: [{ campaignId: "c1", campaign: "Q4 push", stepKey: "s3", title: "Follow-up", on: "2026-11-04" }] })
      : path === "/api/w/{workspaceId}/campaigns"
        ? reply(200, { campaigns: [{ id: "c1", title: "Q4 push", status: "running", startsOn: "2026-10-30", endsOn: "2026-11-05", needApproval: 1 }, { id: "c2", title: "Old push", status: "ended", startsOn: "2026-10-01", endsOn: "2026-11-03", needApproval: 0 }, { id: "c3", title: "Moved push", status: "scheduled", startsOn: "2026-10-26", launchOn: "2026-11-04", endsOn: "2026-10-28", needApproval: 0 }] })
        : base(path, init)) as never);
  const onNavigate = vi.fn();
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" date="2026-11-04" view="week" onNavigate={onNavigate} />);
  // A running Campaign is a band over the days it runs, cut at the week's start; an ended one has none.
  const bands = await screen.findByRole("list", { name: "Campaigns this week" });
  const [running, moved] = within(bands).getAllByRole("listitem");
  expect(running!.textContent).toBe("‹Q4 pushRunning1 needs you");
  expect(running!.getAttribute("style")).toContain("grid-column: 2 / 6");
  // A launch moved from October runs from its new date for as many days as the plan gave it.
  expect(moved!.textContent).toBe("Moved pushStarts Wed 4 Nov");
  expect(moved!.getAttribute("style")).toContain("grid-column: 4 / 7");
  expect(within(bands).queryByText("Old push")).toBeNull();
  const tray = await screen.findByRole("group", { name: "Not dated yet" });
  expect(within(tray).getByText("Not dated yet · 1 needs you")).toBeTruthy();
  // The dated one is on its day, not in the tray.
  expect(within(tray).queryByRole("button", { name: "First post" })).toBeNull();
  await userEvent.click(within(tray).getByRole("button", { name: "Undated note" }));
  expect(await screen.findByRole("dialog", { name: "Undated note" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  const wednesday = screen.getAllByRole("region").find((r) => r.getAttribute("aria-label") === dayLabel(4))!;
  expect(await within(wednesday).findByText("Q4 push: Follow-up")).toBeTruthy();
  expect(within(wednesday).getByRole("link", { name: "Open its drafts" }).getAttribute("href")).toContain("/campaigns/c1");
  // Dragged from the tray onto Wednesday, it gets that day at 9:00 and still waits for approval.
  fireEvent.drop(wednesday, { dataTransfer: { getData: () => "undated:u1" } });
  await waitFor(() => expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/move", expect.objectContaining({ body: { items: [{ id: "u1", plannedAt: new Date(2026, 10, 4, 9).toISOString() }] } })));
  expect(await screen.findByText(/It waits for approval on/)).toBeTruthy();
  // The week holds today (Monday), so Day opens there rather than on the Wednesday in the URL.
  await userEvent.click(screen.getByRole("button", { name: "Day" }));
  expect(onNavigate).toHaveBeenLastCalledWith({ date: "2026-11-02", view: "day" });
});

test("an empty week says nothing is planned, and a busy one reads every page", async () => {
  onMonday();
  serve({ list: () => [] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={new Date(2026, 10, 9)} />);
  const link = await screen.findByRole("link", { name: "Plan a campaign" });
  expect(link.closest("p")?.textContent).toBe("Nothing planned this week. Plan a campaign to fill it.");
  expect(link.getAttribute("href")).toBe(`/w/${W}/campaigns`);
  cleanup();
  const pages = [
    { items: [item()], needsYouCount: 2, nextCursor: "500" },
    { items: [item({ id: "i2", title: "Second post" })], needsYouCount: 2, nextCursor: null },
  ];
  // The undated tray's read (needsYou), the empty steps', the Campaign bands', the docs import's and the write-back sources' reads take no page of the range.
  const get = vi.spyOn(api, "GET").mockImplementation(((path: string, init: { params: { query?: { needsYou?: string } } }) =>
    reply(200, path.endsWith("/docs") ? { provider: null, connected: false, imports: false } : path.endsWith("/docs/sources") ? { sources: [] } : path.endsWith("/campaign-launches") ? { launches: [] } : path.endsWith("/mailbox-days") ? { days: [] } : path.endsWith("/campaign-steps") ? { steps: [] } : path.endsWith("/campaigns") ? { campaigns: [] } : init.params.query?.needsYou ? { items: [], needsYouCount: 0 } : pages.shift())) as never);
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={MONDAY} />);
  await screen.findByRole("button", { name: "Second post" });
  expect(screen.getByRole("button", { name: "First post" })).toBeTruthy();
  expect(get).toHaveBeenCalledWith("/api/w/{workspaceId}/items", expect.objectContaining({ params: expect.objectContaining({ query: expect.objectContaining({ cursor: "500" }) }) }));
});

test("a chip moves to another day from its Move to menu in the day, without dragging; a viewer has no menu", async () => {
  onMonday();
  const post = serve({ list: () => [item()] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={new Date(2026, 10, 3)} view="day" />);
  const thursday = new Date(2026, 10, 5).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  await pick(await screen.findByRole("button", { name: "Move First post to another day" }), thursday, "menuitem");
  await waitFor(() => expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/move", expect.objectContaining({ body: { items: [{ id: "i1", plannedAt: new Date(2026, 10, 5, 9).toISOString() }] } })));
  cleanup();
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="viewer" start={new Date(2026, 10, 3)} view="day" />);
  await screen.findByRole("button", { name: "First post" });
  expect(screen.queryByRole("button", { name: "Move First post to another day" })).toBeNull();
});

test("dropping a Scheduled chip on its own day moves nothing; moving it asks first, and says it goes back for approval", async () => {
  onMonday();
  const post = serve({ list: () => [item({ state: "scheduled" })] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={MONDAY} />);
  await screen.findByRole("button", { name: "First post" });
  const region = (d: number) => screen.getAllByRole("region").find((r) => r.getAttribute("aria-label") === new Date(2026, 10, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }))!;
  fireEvent.drop(region(3), { dataTransfer: { getData: () => "i1" } });
  expect(post).not.toHaveBeenCalledWith("/api/w/{workspaceId}/items/move", expect.anything());
  fireEvent.drop(region(4), { dataTransfer: { getData: () => "i1" } });
  const ask = within(region(4)).getByRole("group", { name: `Move to ${dayLabel(4)}` });
  expect(within(ask).getByText("Moving this sends it back for approval. Move anyway?")).toBeTruthy();
  await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
  expect(post).not.toHaveBeenCalledWith("/api/w/{workspaceId}/items/move", expect.anything());
  expect(screen.queryByRole("group", { name: `Move to ${dayLabel(4)}` })).toBeNull();
  fireEvent.drop(region(4), { dataTransfer: { getData: () => "i1" } });
  await userEvent.click(within(region(4)).getByRole("button", { name: "Move" }));
  await waitFor(() => expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/move", expect.objectContaining({ body: { items: [{ id: "i1", plannedAt: new Date(2026, 10, 4, 9).toISOString() }] } })));
  expect(await screen.findByText(/Moved emails and posts go back for approval/)).toBeTruthy();
});

test("the Calendar's day approves a chip; the week moves a dropped one, pages by week and hides a layer", async () => {
  onMonday();
  // A real post's channel is its connection's name, so the layer has to go by work area.
  const group = { groupKey: "q4", groupLabel: "Q4 ops", channel: "email", workArea: "outreach" };
  const post = serve({ list: () => [item({ workArea: "social", channel: "LinkedIn page" }), item({ id: "g1", ...group }), item({ id: "g2", ...group })] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={new Date(2026, 10, 3)} view="day" />);
  await screen.findByRole("button", { name: "First post" });
  await userEvent.click(screen.getAllByRole("button", { name: /^Approve · sends/ })[0]!);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: "i1" } }, body: { revision: 2 } });
  await userEvent.click(screen.getByRole("button", { name: /^Approve 2 · sends/ }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/approve-clean", { params: { path: { workspaceId: W } }, body: { items: [{ id: "g1", revision: 2 }, { id: "g2", revision: 2 }] } });
  expect(await screen.findByText(/^Approved 1\./)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Week" }));
  const friday = screen.getAllByRole("region").find((r) => r.getAttribute("aria-label") === new Date(2026, 10, 6).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }))!;
  fireEvent.dragOver(friday);
  fireEvent.drop(friday, { dataTransfer: { getData: () => "q4" } });
  await waitFor(() => expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/move", expect.objectContaining({ body: { items: [{ id: "g1", plannedAt: new Date(2026, 10, 6, 9).toISOString() }, { id: "g2", plannedAt: new Date(2026, 10, 6, 9).toISOString() }] } })));
  await userEvent.click(screen.getByRole("checkbox", { name: "Posts" }));
  expect(screen.queryByRole("button", { name: "First post" })).toBeNull();
  expect(screen.getByRole("button", { name: "Q4 ops · 2" })).toBeTruthy();
  expect(screen.getByText(/1 hidden by the filters above\./)).toBeTruthy();
  await userEvent.click(screen.getByRole("checkbox", { name: "Posts" }));
  expect(screen.getByRole("button", { name: "First post" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Next week" }));
  await userEvent.click(screen.getByRole("button", { name: "Previous week" }));
  expect(await screen.findByRole("button", { name: "First post" })).toBeTruthy();
});

test("the Calendar filters by Campaign and by network, and SEO has its own layer", async () => {
  onMonday();
  serve({
    list: () => [
      item({ id: "p1", title: "LinkedIn launch", workArea: "social", channel: "linkedin", groupKey: "campaign:c1:step:s1" }),
      item({ id: "p2", title: "X teaser", workArea: "social", channel: "x", groupKey: "campaign:c2:step:s1" }),
      item({ id: "e1", title: "Hello email", workArea: "outreach", channel: "email", groupKey: "campaign:c1:step:s2" }),
      item({ id: "s1", title: "Pricing page brief", workArea: "seo", channel: null }),
    ],
  });
  const get = vi.mocked(api.GET);
  const base = get.getMockImplementation() as unknown as (path: string, init: unknown) => unknown;
  get.mockImplementation(((path: string, init: unknown) =>
    path === "/api/w/{workspaceId}/campaigns" ? reply(200, { campaigns: [{ id: "c1", title: "Q4 push" }, { id: "c2", title: "Spring sale" }] }) : base(path, init)) as never);
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={MONDAY} />);
  await screen.findByRole("button", { name: "LinkedIn launch" });
  const names = ["LinkedIn launch", "X teaser", "Hello email", "Pricing page brief"];
  const shown = () => names.filter((n) => screen.queryByRole("button", { name: n }));
  await pick(screen.getAllByRole("combobox", { name: "Network" }).at(-1)!, "linkedin");
  expect(shown()).toEqual(["LinkedIn launch"]);
  await pick(screen.getAllByRole("combobox", { name: "Network" }).at(-1)!, "All networks");
  await pick(screen.getAllByRole("combobox", { name: "Campaign" }).at(-1)!, "Q4 push");
  expect(shown()).toEqual(["LinkedIn launch", "Hello email"]);
  expect(screen.getByText(/2 hidden by the filters above\./)).toBeTruthy();
  await pick(screen.getAllByRole("combobox", { name: "Campaign" }).at(-1)!, "All campaigns");
  expect(shown()).toEqual(names);
  await userEvent.click(screen.getByRole("checkbox", { name: "SEO" }));
  expect(shown()).toEqual(names.slice(0, 3));
});

test("with filters from the URL, the Calendar shows them, drops an unknown channel, and asks for each change", async () => {
  onMonday();
  serve({ list: () => [item({ title: "Waiting post", workArea: "social", channel: "linkedin" }), item({ id: "i2", title: "Booked email", state: "scheduled", workArea: "outreach", channel: "email" }), item({ id: "i3", title: "Pricing page brief", workArea: "seo", channel: null })] });
  const onFilters = vi.fn();
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={MONDAY} filters={{ hide: "seo,bogus", needs: true }} onFilters={onFilters} />);
  await screen.findByRole("button", { name: "Waiting post" });
  expect(screen.queryByRole("button", { name: "Booked email" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Pricing page brief" })).toBeNull();
  expect((screen.getByRole("checkbox", { name: "SEO" }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByRole("button", { name: "Only what needs you" }).getAttribute("aria-pressed")).toBe("true");

  // A channel change writes only the channels the Calendar has, so "bogus" goes.
  await userEvent.click(screen.getByRole("checkbox", { name: "Emails" }));
  expect(onFilters).toHaveBeenLastCalledWith({ hide: "seo,outreach", needs: true });
  await userEvent.click(screen.getByRole("checkbox", { name: "SEO" }));
  expect(onFilters).toHaveBeenLastCalledWith({ hide: undefined, needs: true });
  await userEvent.click(screen.getByRole("button", { name: "Only what needs you" }));
  expect(onFilters).toHaveBeenLastCalledWith({ hide: "seo,bogus", needs: undefined });
  await pick(screen.getAllByRole("combobox", { name: "Network" }).at(-1)!, "linkedin");
  expect(onFilters).toHaveBeenLastCalledWith({ hide: "seo,bogus", needs: true, network: "linkedin" });
});

const panelCases: [string, Partial<Item>, unknown, string, string, unknown?][] = [
  ["Don't send", {}, {}, "Don't send", "/api/w/{workspaceId}/items/{id}/cancel"],
  ["Mark sent", { state: "held", reasonCode: "outcome_unknown", reason: "not sure it sent" }, {}, "Mark sent", "/api/w/{workspaceId}/items/{id}/resolve-unknown", { choice: "mark_sent" }],
  ["Resend", { state: "held", reasonCode: "outcome_unknown", reason: "not sure it sent" }, {}, "Resend, accepting it may go out twice", "/api/w/{workspaceId}/items/{id}/resolve-unknown", { choice: "resend" }],
  ["Resume", { state: "held", reasonCode: "cap", reason: "over the cap" }, {}, "Check again and resume", "/api/w/{workspaceId}/items/{id}/resume"],
  ["Opted out", { kind: "opt_out_review" }, { signalId: "s1" }, "They asked to stop", "/api/w/{workspaceId}/items/{id}/approve", { revision: 2, choice: "opted_out" }],
  ["Not opted out", { kind: "opt_out_review" }, { signalId: "s1" }, "They didn't", "/api/w/{workspaceId}/items/{id}/approve", { revision: 2, choice: "not_opt_out" }],
  ["No answer needed", { kind: "reply" }, { signalId: "s1", thread: ["s1"], actionId: null, label: "no", quote: null, owner: { userIds: [], rule: "workspace_owners" } }, "No answer needed", "/api/w/{workspaceId}/items/{id}/approve", { revision: 2, choice: "no_answer" }],
  ["Answered elsewhere", { kind: "reply" }, { signalId: "s1", thread: ["s1"], actionId: null, label: "no", quote: null, owner: { userIds: [], rule: "workspace_owners" } }, "Answered elsewhere", "/api/w/{workspaceId}/items/{id}/approve", { revision: 2, choice: "answered_elsewhere" }],
  ["Start", { kind: "next_step" }, { link: "plan_to_templates", campaignId: "c9" }, "Start", "/api/w/{workspaceId}/items/{id}/approve", { revision: 2 }],
  ["Go ahead", { kind: "campaign_stall" }, { campaignId: "c9", stepKey: "second", choices: ["go_ahead"] }, "Go ahead without it", "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/stall", { choice: "go_ahead" }],
  ["Cancel the step", { kind: "campaign_stall" }, { campaignId: "c9", stepKey: "second", choices: [] }, "Cancel the step", "/api/w/{workspaceId}/campaigns/{id}/steps/{key}/stall", { choice: "cancel" }],
  ["Skip", {}, { touch: { personId: "p1", touchClass: "cold" } }, "We're talking to them", "/api/w/{workspaceId}/items/{id}/cancel"],
];

test.each(panelCases)("the Item panel's %s calls its endpoint and refreshes", async (_, o, content, name, path, body) => {
  // The test client refetches on mount; a read that never answers keeps the Item as given.
  const post = serve({ list: () => [] });
  vi.mocked(api.GET).mockImplementation((() => new Promise(() => {})) as never);
  const reply = { senderEmail: "kim@example.com", text: "Stop", status: "needs_person" };
  show(<ItemPanel workspaceId={W} id="i1" role="owner" initial={{ item: item(o), content, timeline: [], ruleGrantedBy: null, reply, basis: null }} />);
  await userEvent.click(screen.getByRole("button", { name }));
  await waitFor(() => expect(post).toHaveBeenLastCalledWith(path, expect.objectContaining(body ? { body } : {})));
});

test("the Item panel moves a send time and shows a refusal", async () => {
  const post = serve({ list: () => [] });
  vi.mocked(api.GET).mockImplementation((() => new Promise(() => {})) as never);
  post.mockImplementation((() => reply(200, { results: [{ id: "i1", ok: false, reason: "slot_full" }] })) as never);
  show(<ItemPanel workspaceId={W} id="i1" role="owner" initial={{ item: item({ state: "scheduled" }), content: {}, timeline: [], ruleGrantedBy: null }} />);
  expect(screen.getByText("Moving it brings it back for approval.")).toBeTruthy();
  await setDateTime("Send at", "2026-11-04T10:30");
  await userEvent.click(screen.getByRole("button", { name: "Move" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/move", { params: { path: { workspaceId: W } }, body: { items: [{ id: "i1", plannedAt: new Date(2026, 10, 4, 10, 30).toISOString() }] } });
  expect((await screen.findByRole("alert")).textContent).toBe("That time would mean too many messages to this Person close together. Pick another.");
});

test("Home's Open buttons name their Item, so two rows can be told apart", async () => {
  serve({ list: () => [item(), item({ id: "i2", title: "Second" })] });
  show(<Review workspaceId={W} role="marketer" />);
  expect(await screen.findByRole("button", { name: "Open First post" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open Second" })).toBeTruthy();
});

test("Home names what each row is, and shows a state chip only when it isn't Needs approval", async () => {
  serve({
    list: () => [
      item({ workArea: "outreach" }),
      item({ id: "i2", title: "Acme", kind: "company_review", workArea: "prospecting" }),
      item({ id: "i3", title: "Held one", workArea: "outreach", state: "held", reason: "the daily cap is reached" }),
    ],
  });
  show(<Review workspaceId={W} role="marketer" />);
  const list = within(await screen.findByRole("navigation", { name: "Queue" }));
  expect(list.getAllByText("Email")).toHaveLength(2);
  expect(list.getByText("Company review")).toBeTruthy();
  expect(list.getByText("Held: the daily cap is reached")).toBeTruthy();
  expect(list.queryByText("Needs approval")).toBeNull();
});

test("the Calendar day's approve buttons name their chip, so two chips can be told apart", async () => {
  serve({ list: () => [item(), item({ id: "i2", title: "Second" })] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="owner" start={new Date(2026, 10, 3)} view="day" />);
  expect(await screen.findByRole("button", { name: /^Approve · sends .*: First post$/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Approve · sends .*: Second$/ })).toBeTruthy();
});

test("Home links a conflict to its Campaign's People tab, a plan version to its plan's link (which leads to its Campaign) and the Strategy to Brand; older Items without a group fall back to the list", async () => {
  const C = "00000000-0000-4000-8000-0000000000c1";
  const P = "00000000-0000-4000-8000-0000000000p1";
  serve({
    list: () => [
      item({ id: "c1", kind: "campaign_conflict", title: "kim@x.test is already in another campaign", groupKey: `campaign:${C}` }),
      item({ id: "p1", kind: "plan_version", title: "Q4 plan", groupKey: `plan:${P}` }),
      item({ id: "p2", kind: "plan_version", title: "Old plan" }),
      item({ id: "s1", kind: "strategy_version", title: "Strategy" }),
    ],
  });
  show(<Review workspaceId={W} role="owner" />);
  expect((await screen.findByRole("link", { name: "Choose on the campaign's People tab" })).getAttribute("href")).toBe(`/w/${W}/campaigns/${C}?tab=people`);
  expect(screen.getByRole("link", { name: "Read the plan" }).getAttribute("href")).toBe(`/w/${W}/plans/${P}`);
  expect(screen.getByRole("link", { name: "Read it in Campaigns" }).getAttribute("href")).toBe(`/w/${W}/campaigns`);
  expect(screen.getByRole("link", { name: "Read it on Brand" }).getAttribute("href")).toBe(`/w/${W}/brand`);
});

test("Approve leads the Review bar, and approving the last Item clears the queue", async () => {
  let approved = false;
  const post = serve({ list: () => (approved ? [] : [item()]), state: (i) => (approved ? "scheduled" : i.state) });
  post.mockImplementation((() => {
    approved = true;
    return reply(200, {});
  }) as never);
  show(<Review workspaceId={W} role="marketer" />);
  const bar = within(await screen.findByRole("toolbar", { name: "Review" }));
  expect(bar.getAllByRole("button")[0]!.textContent).toMatch(/^Approve · sends /);
  // Yes, no and another time sit together in the bar, not under the email.
  expect(bar.getAllByRole("button").slice(1, 3).map((b) => b.textContent)).toEqual(["Don't send", "Move"]);
  expect(screen.getAllByRole("button", { name: "Don't send" })).toHaveLength(1);
  await userEvent.click(bar.getByRole("button", { name: "Move" }));
  expect(document.activeElement?.closest("[class*='items-end']")?.textContent).toContain("Send at");
  expect(bar.getByText("1 of 1")).toBeTruthy();
  await userEvent.click(bar.getAllByRole("button")[0]!);
  expect(await screen.findByRole("img", { name: /^Scheduled, / })).toBeTruthy();
  // Emptying the queue says the person cleared it, not that nothing was ever there.
  expect(await screen.findByText("All caught up")).toBeTruthy();
});

test("Review opens on the Item a link names, even one no longer in the queue", async () => {
  serve({ list: () => [item(), item({ id: "i2", title: "Second" })] });
  show(<Review workspaceId={W} role="marketer" open="i2" />);
  expect(await screen.findByRole("article", { name: "Second" })).toBeTruthy();
  expect(screen.getByText("2 of 2")).toBeTruthy();
  cleanup();
  serve({ list: () => [item()], state: (i) => (i.id === "gone" ? "scheduled" : i.state) });
  show(<Review workspaceId={W} role="marketer" open="gone" />);
  const panel = await screen.findByRole("article");
  expect(await within(panel).findByText("Scheduled")).toBeTruthy();
  expect(screen.getByText("1 left")).toBeTruthy();
});

test("Review's queue shows one kind at a time, and the keys move within it", async () => {
  serve({ list: () => [item(), item({ id: "i2", title: "Acme", kind: "company_review", workArea: null }), item({ id: "i3", title: "Third" })] });
  show(<Review workspaceId={W} role="marketer" />);
  await screen.findByRole("article", { name: "First post" });
  const pills = within(screen.getByRole("group", { name: "Show" }));
  expect(pills.getByRole("button", { name: "All 3" }).getAttribute("aria-pressed")).toBe("true");
  await userEvent.click(pills.getByRole("button", { name: "Company review 1" }));
  const queue = within(screen.getByRole("navigation", { name: "Queue" }));
  expect(queue.getAllByRole("button")).toHaveLength(1);
  expect(queue.getByText("Acme")).toBeTruthy();
  await userEvent.click(pills.getByRole("button", { name: "All 3" }));
  expect(queue.getAllByRole("button")).toHaveLength(3);
});

const COMPANY = {
  companyId: "c-1",
  domain: "acme.test",
  website: "https://acme.test",
  name: "Acme",
  country: null,
  names: { status: "done", reason: null },
  signals: [],
  addresses: [{ id: "a1", email: "kim@acme.test", kind: "named", source: "published", name: "Kim Lee", role: "CEO", pageUrl: "https://acme.test/team", readAt: "2026-11-02T10:00:00.000Z", personId: null, leftOut: null }],
};

test("R rejects the open company review, named on its button, with no list of keys above the queue", async () => {
  const post = serve({ list: () => [item({ id: "c1", kind: "company_review", title: "Acme", workArea: "outreach", channel: null })], content: () => COMPANY });
  show(<Review workspaceId={W} role="marketer" />);
  const reject = await screen.findByRole("button", { name: "Reject this company" });
  expect(reject.getAttribute("aria-keyshortcuts")).toBe("R");
  expect(screen.queryByText(/Keys: J next/)).toBeNull();
  await userEvent.keyboard("r");
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: "c1" } }, body: { revision: 2, choice: "reject" } }));
});

test("a company review shows the Strategy's audience above its signals, so fit is judged against it", async () => {
  serve({ list: () => [item({ id: "c1", kind: "company_review", title: "Acme", workArea: "outreach", channel: null })], content: () => COMPANY, strategy: { whoFor: "Bakeries with two or more shops", personas: [{ name: "Owner" }, { name: "Head baker" }] } });
  show(<Review workspaceId={W} role="marketer" />);
  const audience = await screen.findByRole("region", { name: "Who we're for" });
  expect(audience.textContent).toBe("Who we're for: Bakeries with two or more shopsPersonas: Owner, Head baker");
});

const EMAIL = { to: ["kim@acme.test"], subject: "Your books", text: "Hi Kim,\nWe saw your new shop on Main St.\nWe do bookkeeping.\n\n--\nUnsubscribe: https://x.test/u" };

test("a per-address email marks what was written for the person, dims the step's words, and links each quote to its page", async () => {
  const spans = [
    { text: "Hi Kim,\n", kind: "same" },
    { text: "We saw your new shop on Main St.\n", kind: "added" },
    { text: "We do bookkeeping.", kind: "same" },
  ];
  const warnings = [{ code: "recipient_detail", text: 'Says about them: "a new shop on Main St" (from https://acme.test/news)' }] as unknown as Item["warnings"];
  serve({ list: () => [item({ title: "To Kim", channel: "email", warnings, clean: false })], content: () => EMAIL, recipient: { signals: [], roleAddress: false, guessedAddress: false, spans } });
  show(<Review workspaceId={W} role="marketer" />);
  const panel = await screen.findByRole("article", { name: "To Kim" });
  const marks = await within(panel).findAllByText((_, el) => el?.tagName === "MARK");
  expect(marks.map((m) => m.textContent)).toEqual(["We saw your new shop on Main St.\n"]);
  // The footer after the compared text still shows, dimmed with the step's words.
  expect(within(panel).getByText((_, el) => el?.tagName === "SPAN" && !el.closest('[aria-label="In the inbox"]') && /Unsubscribe/.test(el.textContent ?? "")).className).toContain("text-muted-foreground");
  expect(within(panel).getByRole("link", { name: "on this page" }).getAttribute("href")).toBe("https://acme.test/news");
});

test("an email whose spans don't match its text shows unmarked rather than misplaced", async () => {
  serve({ list: () => [item({ title: "To Kim", channel: "email" })], content: () => EMAIL, recipient: { signals: [], roleAddress: false, guessedAddress: false, spans: [{ text: "Something else", kind: "added" }] } });
  show(<Review workspaceId={W} role="marketer" />);
  const panel = await screen.findByRole("article", { name: "To Kim" });
  const body = await within(panel).findByText((_, el) => el?.tagName === "DIV" && (el.textContent ?? "").startsWith("Hi Kim"));
  expect(body.textContent).toBe(EMAIL.text);
  expect(panel.querySelector("mark")).toBeNull();
});

test("R does nothing on an Item that isn't a company review", async () => {
  const post = serve({ list: () => [item()] });
  show(<Review workspaceId={W} role="marketer" />);
  await screen.findByRole("heading", { name: "First post" });
  expect(screen.queryByText(/R reject the company/)).toBeNull();
  await userEvent.keyboard("r");
  expect(post).not.toHaveBeenCalled();
});

test("one post on two networks is approved together; two emails of one step never are", async () => {
  const post = (id: string, channel: string) => item({ id, title: `Q4 post on ${channel}`, workArea: "social", channel, groupKey: "campaign:c1:step:launch", groupLabel: "Launch" });
  const approve = serve({ list: () => [post("p1", "LinkedIn page"), post("p2", "X")] });
  show(<Review workspaceId={W} role="marketer" />);
  await userEvent.click(await screen.findByRole("button", { name: "Approve both" }));
  await waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
  for (const id of ["p1", "p2"]) expect(approve).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id } }, body: { revision: 2 } });
  cleanup();

  const email = (id: string) => item({ id, title: `Email ${id}`, workArea: "outreach", channel: "email", groupKey: "campaign:c1:step:first", groupLabel: "First email" });
  serve({ list: () => [email("e1"), email("e2")] });
  show(<Review workspaceId={W} role="marketer" />);
  await screen.findByRole("heading", { name: "Email e1" });
  expect(screen.queryByRole("button", { name: "Approve both" })).toBeNull();
});

test("see more opens a folded LinkedIn post to its full text", async () => {
  const text = `${"word ".repeat(60)}the end`;
  render(<FeedText network="LinkedIn" text={text} />);
  expect(screen.queryByText(/the end/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "see more" }));
  expect(screen.getByText(/the end/)).toBeTruthy();
});

test("an email written for one person rewrites on one click, says it's working, and says when the new version is in", async () => {
  let revision = 2;
  const recipient = { signals: [], roleAddress: false, guessedAddress: false, spans: null };
  const post = serve({ list: () => [item({ title: "To Kim", channel: "email", revision })], content: () => EMAIL, recipient, writtenFrom: WRITER });
  show(<Review workspaceId={W} role="marketer" />);
  const tools = within(await screen.findByRole("region", { name: "Rewrite" }));
  await userEvent.click(tools.getByRole("button", { name: "Shorter" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/rewrite", { params: { path: { workspaceId: W, id: "i1" } }, body: { preset: "shorter", openedAt: expect.any(String), timeZone: expect.any(String) } });
  expect(await screen.findByText("Rewriting. This usually takes about 15 seconds.")).toBeTruthy();
  expect(tools.getByRole("button", { name: "Longer" }).hasAttribute("disabled")).toBe(true);
  revision = 3;
  expect(await screen.findByText("Rewritten. Read it before you approve.", undefined, { timeout: 5_000 })).toBeTruthy();
  expect(tools.getByRole("button", { name: "Longer" }).hasAttribute("disabled")).toBe(false);
  // The person's own words go as they typed them; a refusal says what to do instead.
  post.mockImplementation((() => reply(409, { error: "from_template" })) as never);
  await userEvent.type(tools.getByRole("textbox", { name: "Or say what to change" }), "Mention the audit");
  await userEvent.click(tools.getByRole("button", { name: "Rewrite" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/rewrite", { params: { path: { workspaceId: W, id: "i1" } }, body: { instruction: "Mention the audit", openedAt: expect.any(String), timeZone: expect.any(String) } });
  expect(await screen.findByText("This email comes from its step's text, so change that text on the Campaign instead.")).toBeTruthy();
});

test("a rewrite whose run stops without a new version says why and stops waiting", async () => {
  const recipient = { signals: [], roleAddress: false, guessedAddress: false, spans: null };
  const post = serve({ list: () => [item({ title: "To Kim", channel: "email" })], content: () => EMAIL, recipient, writtenFrom: WRITER });
  post.mockImplementation(((path: string) => reply(200, path.endsWith("/rewrite") ? { runId: "r1" } : {})) as never);
  const get = vi.mocked(api.GET).getMockImplementation() as unknown as (path: string, init: never) => unknown;
  let status = "waiting";
  vi.mocked(api.GET).mockImplementation(((path: string, init: never) => (path === "/api/w/{workspaceId}/agents/runs/{id}" ? reply(200, { status, statusReason: "provider_quota" }) : get(path, init))) as never);
  show(<Review workspaceId={W} role="marketer" />);
  const tools = within(await screen.findByRole("region", { name: "Rewrite" }));
  await userEvent.click(tools.getByRole("button", { name: "Shorter" }));
  expect(await screen.findByText("Rewriting. This usually takes about 15 seconds.")).toBeTruthy();
  status = "timed_out";
  expect(await screen.findByText("The rewrite stopped: the model provider's usage limit is used up, so try again once it resets.", undefined, { timeout: 5_000 })).toBeTruthy();
  expect(tools.getByRole("button", { name: "Longer" }).hasAttribute("disabled")).toBe(false);
  // A finished run whose version was turned down because the email changed meanwhile says so too.
  vi.mocked(api.GET).mockImplementation(((path: string, init: never) => (path === "/api/w/{workspaceId}/agents/runs/{id}" ? reply(200, { status: "succeeded", statusReason: null, proposals: [{ kind: "person_email", itemId: null, rejectionCode: "changed_since", incomplete: false }] }) : get(path, init))) as never);
  post.mockImplementation(((path: string) => reply(200, path.endsWith("/rewrite") ? { runId: "r2" } : {})) as never);
  await userEvent.click(tools.getByRole("button", { name: "Longer" }));
  expect(await screen.findByText("The email changed while it was being rewritten, so the rewrite wasn't used and the email stays as it is.", undefined, { timeout: 5_000 })).toBeTruthy();
  expect(screen.queryByText(/The rewrite stopped/)).toBeNull();
});

test("a rewrite can be cancelled while it runs, and then says the email stays as it was", async () => {
  const recipient = { signals: [], roleAddress: false, guessedAddress: false, spans: null };
  const post = serve({ list: () => [item({ title: "To Kim", channel: "email" })], content: () => EMAIL, recipient, writtenFrom: WRITER });
  post.mockImplementation(((path: string) => reply(200, path.endsWith("/rewrite") ? { runId: "r1" } : {})) as never);
  const get = vi.mocked(api.GET).getMockImplementation() as unknown as (path: string, init: never) => unknown;
  let status = "running";
  vi.mocked(api.GET).mockImplementation(((path: string, init: never) => (path === "/api/w/{workspaceId}/agents/runs/{id}" ? reply(200, { status, statusReason: null, proposals: [] }) : get(path, init))) as never);
  show(<Review workspaceId={W} role="marketer" />);
  const tools = within(await screen.findByRole("region", { name: "Rewrite" }));
  await userEvent.click(tools.getByRole("button", { name: "Shorter" }));
  await userEvent.click(await tools.findByRole("button", { name: "Cancel this rewrite" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/agents/runs/{id}/cancel", { params: { path: { workspaceId: W, id: "r1" } } });
  status = "cancelled";
  expect(await screen.findByText("The rewrite was cancelled, so the email stays as it was.", undefined, { timeout: 5_000 })).toBeTruthy();
  expect(tools.queryByRole("button", { name: "Cancel this rewrite" })).toBeNull();
  expect(tools.getByRole("button", { name: "Longer" }).hasAttribute("disabled")).toBe(false);
  // A run that already ended can't be cancelled, and says so.
  post.mockImplementation(((path: string) => reply(path.endsWith("/cancel") ? 409 : 200, path.endsWith("/cancel") ? { error: "already_ended" } : { runId: "r2" })) as never);
  status = "running";
  await userEvent.click(tools.getByRole("button", { name: "Longer" }));
  await userEvent.click(await tools.findByRole("button", { name: "Cancel this rewrite" }));
  expect(await screen.findByText("This rewrite has already ended.")).toBeTruthy();
});

test("a step's template email offers no rewrite and says where its words change", async () => {
  const recipient = { signals: [], roleAddress: false, guessedAddress: false, spans: null };
  serve({ list: () => [item({ title: "To Kim", channel: "email", workArea: "outreach", groupKey: "campaign:c1:step:first" })], content: () => EMAIL, recipient, writtenFrom: { ...WRITER, run: null } });
  show(<Review workspaceId={W} role="marketer" />);
  const panel = await screen.findByRole("article", { name: "To Kim" });
  expect(await within(panel).findByText("This email comes from its step's text, so change that text on the Campaign to rewrite it.")).toBeTruthy();
  expect(within(panel).queryByRole("region", { name: "Rewrite" })).toBeNull();
  expect(within(panel).queryByRole("button", { name: "Shorter" })).toBeNull();
});

test("rewrite isn't offered to a viewer, or on something no writer wrote for one person", async () => {
  const recipient = { signals: [], roleAddress: false, guessedAddress: false, spans: null };
  serve({ list: () => [item({ title: "To Kim", channel: "email" })], content: () => EMAIL, recipient, writtenFrom: WRITER });
  show(<Review workspaceId={W} role="viewer" />);
  await screen.findByRole("article", { name: "To Kim" });
  expect(screen.queryByRole("region", { name: "Rewrite" })).toBeNull();
  cleanup();
  serve({ list: () => [item()] });
  show(<Review workspaceId={W} role="marketer" />);
  await screen.findByRole("article", { name: "First post" });
  expect(screen.queryByRole("region", { name: "Rewrite" })).toBeNull();
});

test("Not like this: a reason rewrites with that reason and the person's words, Wrong facts points to Brand, and stopping the send is left to the panel's Don't send", async () => {
  const recipient = { signals: [], roleAddress: false, guessedAddress: false, spans: null };
  const post = serve({ list: () => [item({ title: "To Kim", channel: "email" })], content: () => EMAIL, recipient, writtenFrom: WRITER });
  show(<Review workspaceId={W} role="marketer" />);
  const tools = within(await screen.findByRole("region", { name: "Rewrite" }));
  expect(tools.queryByRole("button", { name: "Drop it" })).toBeNull();
  await userEvent.click(tools.getByRole("button", { name: "Too salesy" }));
  expect(tools.getByRole("button", { name: "Too salesy" }).getAttribute("aria-pressed")).toBe("true");
  await userEvent.type(tools.getByRole("textbox", { name: "Or say what to change" }), "Drop the discount line");
  await userEvent.click(tools.getByRole("button", { name: "Rewrite" }));
  // The reason goes as its key, so the server can count it; the server holds its words.
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/rewrite", { params: { path: { workspaceId: W, id: "i1" } }, body: { reason: "salesy", instruction: "Drop the discount line", openedAt: expect.any(String), timeZone: expect.any(String) } });
  cleanup();
  const again = serve({ list: () => [item({ title: "To Kim", channel: "email" })], content: () => EMAIL, recipient, writtenFrom: WRITER });
  show(<Review workspaceId={W} role="marketer" />);
  const more = within(await screen.findByRole("region", { name: "Rewrite" }));
  await userEvent.click(more.getByRole("button", { name: "Wrong facts" }));
  expect(more.getByRole("link", { name: "fix it on Brand" }).getAttribute("href")).toBe(`/w/${W}/brand`);
  expect(more.queryByRole("button", { name: "Don't send" })).toBeNull();
  // A reason only rewrites; the one way to stop the email is the panel's Don't send.
  await userEvent.click(more.getByRole("button", { name: "Too long" }));
  expect(more.queryByRole("button", { name: "Drop it" })).toBeNull();
  expect(screen.getByRole("button", { name: "Don't send" })).toBeTruthy();
  expect(again).not.toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/cancel", expect.anything());
});

test("This one's great goes with the approval of an email written for one person", async () => {
  const recipient = { signals: [], roleAddress: false, guessedAddress: false, spans: null };
  const post = serve({ list: () => [item({ title: "To Kim", channel: "email" })], content: () => EMAIL, recipient });
  show(<Review workspaceId={W} role="marketer" />);
  const panel = await screen.findByRole("article", { name: "To Kim" });
  const great = within(panel).getByRole("button", { name: "This one's great" });
  await userEvent.click(great);
  expect(great.getAttribute("aria-pressed")).toBe("true");
  await userEvent.click(await within(panel).findByRole("button", { name: /^Approve/ }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId: W, id: "i1" } }, body: { revision: 2, openedAt: expect.any(String), praise: true } });
});

test("Home splits the queue: what goes out under To approve first, decisions under To decide, and J walks both in that order", async () => {
  serve({ list: () => [item({ id: "c1", kind: "next_step", title: "Acme" }), item(), item({ id: "f1", kind: "fact_conflict", title: "Price differs" }), item({ id: "e1", title: "Hi Kim", channel: "email", workArea: "outreach" })] });
  show(<Review workspaceId={W} role="marketer" />);
  // The first Item open is the first thing to approve, not the first one the API sent.
  await screen.findByRole("article", { name: "First post" });
  expect(screen.getByRole("heading", { level: 2, name: "Waiting for you (4)" })).toBeTruthy();
  const queue = within(screen.getByRole("navigation", { name: "Queue" }));
  expect(queue.getAllByRole("heading").map((h) => h.textContent)).toEqual(["To approve (2)", "To decide (2)"]);
  expect(within(queue.getByRole("region", { name: "To approve" })).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Open First post", "Open Hi Kim"]);
  expect(within(queue.getByRole("region", { name: "To decide" })).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Open Acme", "Open Price differs"]);
  await userEvent.keyboard("j");
  expect(await screen.findByRole("article", { name: "Hi Kim" })).toBeTruthy();
  await userEvent.keyboard("j");
  expect(await screen.findByRole("article", { name: "Acme" })).toBeTruthy();
  await userEvent.keyboard("k");
  expect(await screen.findByRole("article", { name: "Hi Kim" })).toBeTruthy();
});

test("Home hides an empty group's heading", async () => {
  serve({ list: () => [item({ id: "n1", kind: "next_step", title: "Draft the templates" })] });
  show(<Review workspaceId={W} role="marketer" />);
  await screen.findByRole("article", { name: "Draft the templates" });
  expect(screen.getByRole("heading", { level: 2, name: "Waiting for you (1)" })).toBeTruthy();
  expect(within(screen.getByRole("navigation", { name: "Queue" })).getAllByRole("heading").map((h) => h.textContent)).toEqual(["To decide (1)"]);
});

test("All caught up offers to plan next week's posts beside the Calendar", async () => {
  let approved = false;
  const post = serve({ list: () => (approved ? [] : [item()]), state: (i) => (approved ? "scheduled" : i.state) });
  post.mockImplementation((() => {
    approved = true;
    return reply(200, {});
  }) as never);
  show(<Review workspaceId={W} role="marketer" />);
  await userEvent.click(within(await screen.findByRole("toolbar", { name: "Review" })).getAllByRole("button")[0]!);
  const empty = within((await screen.findByText("All caught up")).closest("[role=status]") as HTMLElement);
  expect(empty.getByRole("link", { name: "Plan next week's posts" }).getAttribute("href")).toBe(`/w/${W}/campaigns`);
  expect(empty.getByRole("link", { name: "Open the Calendar" }).getAttribute("href")).toBe(`/w/${W}/calendar`);
});

test("Nothing is waiting for you keeps the one Calendar link", async () => {
  serve({ list: () => [] });
  show(<Review workspaceId={W} role="marketer" />);
  await screen.findByText("Nothing is waiting for you");
  expect(screen.queryByRole("link", { name: "Plan next week's posts" })).toBeNull();
});

test("the Calendar's one Add post opens on the first day shown still to come and sends the post to wait for approval; a viewer has none", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 3, 12));
  const post = serve({ list: () => [] });
  const items = vi.mocked(api.GET).getMockImplementation()!;
  const account = { id: "a1", credentialId: "00000000-0000-4000-8000-0000000000c1", networkId: "n1", connection: "x", network: "X", name: "Acme", canDo: [] };
  vi.mocked(api.GET).mockImplementation(((path: string, init: never) =>
    path === "/api/w/{workspaceId}/social/accounts" ? reply(200, { accounts: [account] }) : path === "/api/w/{workspaceId}/social/networks" ? reply(200, { networks: [{ connection: "x", label: "X", publishes: true }] }) : (items as (p: string, i: never) => unknown)(path, init)) as never);
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="marketer" start={MONDAY} view="week" />);
  await screen.findByRole("button", { name: "Add a post" });
  // One for the screen, not one a day; Monday has passed, so it opens on today.
  expect(screen.getAllByRole("button", { name: /Add a post/ })).toHaveLength(1);
  await userEvent.click(screen.getByRole("button", { name: "Add a post" }));
  const form = await screen.findByRole("form", { name: `New post on ${dayLabel(3)}` });
  // A screen reader hears what the dialog is for as it opens.
  expect(screen.getByRole("dialog", { name: /^New post for / })).toBeTruthy();
  expect(await within(form).findByRole("option", { name: "X: Acme" })).toBeTruthy();
  await userEvent.type(within(form).getByRole("textbox", { name: "Post" }), "Hello from the calendar");
  await setDateTime("When", "2026-11-04T14:30");
  await userEvent.click(within(form).getByRole("button", { name: "Add for approval" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/social/posts", { params: { path: { workspaceId: W } }, body: { connection: "x", credentialId: account.credentialId, networkId: "n1", text: "Hello from the calendar", at: new Date(2026, 10, 4, 14, 30).toISOString() } }),
  );
  await waitFor(() => expect(screen.queryByRole("form", { name: `New post on ${dayLabel(3)}` })).toBeNull());
  cleanup();
  serve({ list: () => [] });
  show(<Calendar ItemView={ItemDialog} workspaceId={W} role="viewer" start={MONDAY} view="week" />);
  await screen.findByRole("button", { name: `Open ${dayLabel(4)}` });
  expect(screen.queryByRole("button", { name: /Add a post/ })).toBeNull();
});
