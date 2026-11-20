// SPDX-License-Identifier: AGPL-3.0-only
// Everything: every state listed, "Show more" by cursor, a row opening the Item beside the list,
// the filters read from and written to the route, and both empty states.
import { afterEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { openDialog, pick, withQueries } from "../testing";
import type { Item, ListFilters, Role } from "./actions";
import { Everything } from "./Everything";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const item = (o: Partial<Item> = {}): Item => ({
  id: "i1",
  kind: "action",
  state: "sent",
  reason: null,
  reasonCode: null,
  revision: 1,
  title: "Email to Dana",
  workArea: "outreach",
  channel: "email",
  groupKey: null,
  groupLabel: null,
  at: null,
  warnings: [],
  clean: true,
  movable: false,
  decideBy: null,
  snoozedUntil: null,
  createdAt: new Date(2026, 10, 3, 9).toISOString(),
  ...o,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Query = Record<string, string | number | undefined>;
/** The list answers each read with the next page; returns the queries it was asked. */
function serve(pages: { items: Item[]; nextCursor: string | null }[]) {
  const asked: Query[] = [];
  vi.spyOn(api, "GET").mockImplementation(((path: string, init: { params: { query?: Query } }) => {
    if (path === "/api/w/{workspaceId}/items") {
      asked.push(init.params.query ?? {});
      return reply(200, { needsYouCount: 0, ...(pages.shift() ?? { items: [], nextCursor: null }) });
    }
    if (path === "/api/w/{workspaceId}/campaigns") return reply(200, { campaigns: [{ id: "c1", title: "Spring launch" }] });
    if (path === "/api/w/{workspaceId}/social/networks") return reply(200, { networks: [{ connection: "linkedin_page", label: "LinkedIn Page", publishes: true }] });
    return reply(404, { error: "not_found" });
  }) as never);
  return asked;
}

/** Stands in for the Item drawer: says which Item is open and closes on a click. */
const ItemView = (p: { id?: string; onClose: () => void }) => (p.id ? <button onClick={p.onClose}>{`Close ${p.id}`}</button> : null);

function show(o: { filters?: ListFilters; item?: string; role?: Role } = {}) {
  const onFilters = vi.fn();
  const onItem = vi.fn();
  render(withQueries(<Everything workspaceId={W} role={o.role ?? "owner"} ItemView={ItemView as never} filters={o.filters ?? {}} onFilters={onFilters} item={o.item} onItem={onItem} />));
  return { onFilters, onItem };
}

/** Answers approve-clean with `refuse` refused and the rest approved, and each cancel but `stuck`; returns the calls. */
function act(o: { refuse?: string[]; stuck?: string[] } = {}) {
  return vi.spyOn(api, "POST").mockImplementation(((path: string, init: { params: { path: { id?: string } }; body?: { items: { id: string }[] } }) => {
    if (path === "/api/w/{workspaceId}/items/approve-clean")
      return reply(200, { results: init.body!.items.map(({ id }) => (o.refuse?.includes(id) ? { id, ok: false, reason: "stale" } : { id, ok: true })) });
    if (path === "/api/w/{workspaceId}/items/{id}/cancel") return o.stuck?.includes(init.params.path.id!) ? reply(409, { error: "wrong_state" }) : reply(200, { item: item({ id: init.params.path.id }) });
    return reply(404, { error: "not_found" });
  }) as never);
}
const warned = { clean: false, warnings: [{ code: "unspecified" as const, text: "Check the link" }] };

test("every state shows with its name, a Held one with its reason, and Show more reads the next page by its cursor", async () => {
  const asked = serve([
    { items: [item({ id: "a", state: "needs_approval", title: "Post for Monday", kind: "manual_post", workArea: null }), item({ id: "b", state: "held", reason: "campaign paused" })], nextCursor: "next-1" },
    { items: [item({ id: "c", state: "cancelled", title: "Old post", at: new Date(2026, 10, 4, 10).toISOString() })], nextCursor: null },
  ]);
  show();
  const list = await screen.findByRole("list", { name: "Everything" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getByText("Needs approval")).toBeTruthy();
  expect(within(list).getByText("Held: campaign paused")).toBeTruthy();
  // With no time to go out, a row says when it was made.
  expect(within(list).getAllByText(/^Made /)).toHaveLength(2);
  expect(asked[0]).toEqual({ limit: 100 });

  await userEvent.click(screen.getByRole("button", { name: "Show more" }));
  expect(await within(list).findByText("Old post")).toBeTruthy();
  expect(within(list).getAllByRole("listitem")).toHaveLength(3);
  expect(asked[1]).toEqual({ limit: 100, cursor: "next-1" });
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});

test("a row opens its Item beside the list, and closing it clears the open Item", async () => {
  serve([{ items: [item({ id: "a" })], nextCursor: null }]);
  const first = show();
  await userEvent.click(await screen.findByRole("button", { name: /Email to Dana/ }));
  expect(first.onItem).toHaveBeenCalledWith("a");
  cleanup();

  serve([{ items: [item({ id: "a" })], nextCursor: null }]);
  const open = show({ item: "a" });
  expect((await screen.findByRole("button", { name: /Email to Dana/ })).getAttribute("aria-current")).toBe("true");
  await userEvent.click(screen.getByRole("button", { name: "Close a" }));
  expect(open.onItem).toHaveBeenCalledWith(undefined);
  expect(screen.getByRole("list", { name: "Everything" })).toBeTruthy();
});

test("the filters from the route reach the list, and each picker hands its change back", async () => {
  const asked = serve([{ items: [item()], nextCursor: null }]);
  const { onFilters } = show({ filters: { state: "sent,held", channel: "email", type: "outreach", campaign: "c1", q: "dana" } });
  await screen.findByRole("list", { name: "Everything" });
  expect(asked[0]).toEqual({ limit: 100, state: "sent,held", channel: "email", type: "outreach", campaign: "c1", q: "dana" });
  expect((screen.getByLabelText("Search titles and campaigns") as HTMLInputElement).value).toBe("dana");

  await pick(screen.getByRole("combobox", { name: "State" }), "Draft");
  expect(onFilters).toHaveBeenLastCalledWith({ state: "sent,held,draft" });
  await pick(screen.getByRole("combobox", { name: "Channel" }), "LinkedIn Page");
  expect(onFilters).toHaveBeenLastCalledWith({ channel: "email,linkedin_page" });
  // A type that names several kinds sends all of them.
  await pick(screen.getByRole("combobox", { name: "Type" }), "Post");
  expect(onFilters).toHaveBeenLastCalledWith({ type: "outreach,manual_post,social" });
  await pick(await screen.findByRole("combobox", { name: "Campaign" }), "All campaigns");
  expect(onFilters).toHaveBeenLastCalledWith({ campaign: undefined });

  await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(onFilters).toHaveBeenLastCalledWith({ state: undefined, channel: undefined, type: undefined, campaign: undefined, q: undefined });
});

test("search waits for typing to stop, then sends the words once", async () => {
  serve([{ items: [item()], nextCursor: null }]);
  const { onFilters } = show();
  await screen.findByRole("list", { name: "Everything" });
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  await userEvent.type(screen.getByLabelText("Search titles and campaigns"), " spring ");
  expect(onFilters).not.toHaveBeenCalled();
  await waitFor(() => expect(onFilters).toHaveBeenCalledWith({ q: "spring" }));
  expect(onFilters).toHaveBeenCalledTimes(1);
});

test("an empty Workspace says nothing is here yet; filters with no match offer to clear them", async () => {
  serve([{ items: [], nextCursor: null }]);
  show();
  expect(await screen.findByText("Nothing here yet")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  cleanup();

  serve([{ items: [], nextCursor: null }]);
  const { onFilters } = show({ filters: { state: "blocked" } });
  expect(await screen.findByText("Nothing matches these filters")).toBeTruthy();
  const clears = screen.getAllByRole("button", { name: "Clear filters" });
  expect(clears).toHaveLength(2);
  await userEvent.click(clears[1]!);
  expect(onFilters).toHaveBeenCalledWith({ state: undefined, channel: undefined, type: undefined, campaign: undefined, q: undefined });
});

test("a viewer gets no tick boxes; a contributor may withdraw but not approve", async () => {
  serve([{ items: [item({ id: "a", state: "needs_approval" })], nextCursor: null }]);
  show({ role: "viewer" });
  await screen.findByRole("list", { name: "Everything" });
  expect(screen.queryByRole("checkbox", { name: "Select all shown" })).toBeNull();
  expect(screen.queryByRole("checkbox", { name: "Select Email to Dana" })).toBeNull();
  cleanup();

  serve([{ items: [item({ id: "a", state: "needs_approval" })], nextCursor: null }]);
  show({ role: "contributor" });
  await userEvent.click(await screen.findByRole("checkbox", { name: "Select Email to Dana" }));
  expect(screen.getByText("1 selected")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Withdraw 1" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
});

test("Approve sends only the clean rows that need approval, then says what went through and clears the ticks", async () => {
  const rows = [
    item({ id: "a", state: "needs_approval", title: "First" }),
    item({ id: "b", state: "needs_approval", title: "Warned", ...warned }),
    item({ id: "c", state: "sent", title: "Gone" }),
    item({ id: "d", state: "needs_approval", title: "Second" }),
  ];
  // The list reads again after approving; the second read answers the same rows.
  serve([{ items: rows, nextCursor: null }, { items: rows, nextCursor: null }]);
  const posts = act({ refuse: ["d"] });
  show();
  await userEvent.click(await screen.findByRole("checkbox", { name: "Select all shown" }));
  expect(screen.getByText("4 selected")).toBeTruthy();
  // The warned row and the sent one can be ticked but not approved; the warned one can be withdrawn.
  expect(screen.getByRole("button", { name: "Withdraw 3" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Approve 2" }));
  const dialog = within(openDialog("Approve 2?")!);
  expect(dialog.getByRole("list", { name: "To approve" }).textContent).toContain("First");
  expect(dialog.getByRole("list", { name: "To approve" }).textContent).not.toContain("Warned");
  await userEvent.click(dialog.getByRole("button", { name: "Approve 2" }));
  expect(posts).toHaveBeenCalledWith("/api/w/{workspaceId}/items/approve-clean", expect.objectContaining({ body: { items: [{ id: "a", revision: 1 }, { id: "d", revision: 1 }] } }));
  expect(await screen.findByText("Approved 1.")).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toBe("1 didn't go through: Someone else changed this just now. Try again.");
  await waitFor(() => expect(screen.queryByText(/selected$/)).toBeNull());
  expect((screen.getByRole("checkbox", { name: "Select all shown" }) as HTMLInputElement).checked).toBe(false);
});

test("Withdraw cancels each ticked row that can still be withdrawn, and counts the ones it couldn't", async () => {
  serve([
    {
      items: [
        item({ id: "a", state: "draft", title: "Draft one" }),
        item({ id: "b", state: "scheduled", title: "Scheduled one" }),
        item({ id: "c", state: "held", title: "Held one", reason: "campaign paused" }),
        item({ id: "d", state: "sent", title: "Sent one" }),
        item({ id: "e", state: "cancelled", title: "Cancelled one" }),
      ],
      nextCursor: null,
    },
  ]);
  const posts = act({ stuck: ["b"] });
  show();
  await userEvent.click(await screen.findByRole("checkbox", { name: "Select all shown" }));
  expect(screen.queryByRole("button", { name: /^Approve/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Withdraw 3" }));
  const dialog = within(openDialog("Withdraw 3?")!);
  expect(dialog.getByRole("list", { name: "To withdraw" }).textContent).toBe("Draft oneScheduled oneHeld one");
  await userEvent.click(dialog.getByRole("button", { name: "Withdraw 3" }));
  await waitFor(() => expect(posts).toHaveBeenCalledTimes(3));
  expect((posts.mock.calls as unknown as [string, { params: { path: { id: string } } }][]).map(([, init]) => init.params.path.id).sort()).toEqual(["a", "b", "c"]);
  expect(await screen.findByText("Withdrew 2.")).toBeTruthy();
  expect((await screen.findByRole("alert")).textContent).toBe("1 couldn't be withdrawn. They may have gone out already.");
});

test("Keep them closes the confirm with nothing withdrawn, and Clear selection unticks everything", async () => {
  serve([{ items: [item({ id: "a", state: "draft" })], nextCursor: null }]);
  const posts = act();
  show();
  await userEvent.click(await screen.findByRole("checkbox", { name: "Select Email to Dana" }));
  await userEvent.click(screen.getByRole("button", { name: "Withdraw 1" }));
  await userEvent.click(within(openDialog("Withdraw 1?")!).getByRole("button", { name: "Keep them" }));
  await waitFor(() => expect(openDialog("Withdraw 1?")).toBeNull());
  expect(posts).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
  expect(screen.queryByText(/selected$/)).toBeNull();
  expect((screen.getByRole("checkbox", { name: "Select Email to Dana" }) as HTMLInputElement).checked).toBe(false);
});

test("Select all shown stops at 200, and a filter drops the ticks on rows it hides", async () => {
  serve([{ items: Array.from({ length: 201 }, (_, n) => item({ id: `r${n}`, title: `Row ${n}`, state: "draft" })), nextCursor: null }]);
  show();
  await userEvent.click(await screen.findByRole("checkbox", { name: "Select all shown" }));
  expect(screen.getByText("200 selected")).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "Select Row 200" }) as HTMLInputElement).disabled).toBe(true);
  await userEvent.click(screen.getByRole("checkbox", { name: "Select all shown" }));
  expect(screen.queryByText(/selected$/)).toBeNull();
  cleanup();

  const both = [item({ id: "a", title: "Kept", state: "draft" }), item({ id: "b", title: "Hidden", state: "draft" })];
  serve([{ items: both, nextCursor: null }, { items: [both[0]!], nextCursor: null }, { items: both, nextCursor: null }]);
  // The route's part: filters kept outside the screen, changed in place.
  function Route() {
    const [filters, setFilters] = useState<ListFilters>({});
    return (
      <>
        <button onClick={() => setFilters({ q: "kept" })}>Only kept</button>
        <button onClick={() => setFilters({})}>No filter</button>
        <Everything workspaceId={W} role="owner" ItemView={ItemView as never} filters={filters} onFilters={setFilters} onItem={() => {}} />
      </>
    );
  }
  render(withQueries(<Route />));
  await userEvent.click(await screen.findByRole("checkbox", { name: "Select all shown" }));
  expect(screen.getByText("2 selected")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Only kept" }));
  await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Select Hidden" })).toBeNull());
  expect(await screen.findByText("1 selected")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "No filter" }));
  expect(await screen.findByRole("checkbox", { name: "Select Hidden" })).toBeTruthy();
  expect((screen.getByRole("checkbox", { name: "Select Hidden" }) as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText("1 selected")).toBeTruthy();
});
