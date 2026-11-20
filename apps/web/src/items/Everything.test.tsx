// SPDX-License-Identifier: AGPL-3.0-only
// Everything: every state listed, "Show more" by cursor, a row opening the Item beside the list,
// the filters read from and written to the route, and both empty states.
import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { pick, withQueries } from "../testing";
import type { Item, ListFilters } from "./actions";
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

function show(o: { filters?: ListFilters; item?: string } = {}) {
  const onFilters = vi.fn();
  const onItem = vi.fn();
  render(withQueries(<Everything workspaceId={W} role="owner" ItemView={ItemView as never} filters={o.filters ?? {}} onFilters={onFilters} item={o.item} onItem={onItem} />));
  return { onFilters, onItem };
}

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


test("Clear discards pending search text even when the route has no search", async () => {
  serve([{ items: [item()], nextCursor: null }]);
  const { onFilters } = show({ filters: { state: "sent" } });
  await screen.findByRole("list", { name: "Everything" });
  vi.useFakeTimers();
  try {
    const input = screen.getByLabelText("Search titles and campaigns") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "pending" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(input.value).toBe("");
    act(() => vi.advanceTimersByTime(300));
    expect(onFilters).toHaveBeenCalledTimes(1);
    expect(onFilters).toHaveBeenCalledWith({ state: undefined, channel: undefined, type: undefined, campaign: undefined, q: undefined });
  } finally {
    vi.useRealTimers();
  }
});

test("search limits pasted text to 100 characters and explains the limit", async () => {
  serve([{ items: [item()], nextCursor: null }]);
  const { onFilters } = show();
  await screen.findByRole("list", { name: "Everything" });
  const input = screen.getByLabelText("Search titles and campaigns") as HTMLInputElement;
  expect(input.maxLength).toBe(100);
  expect(screen.getByText("Up to 100 characters")).toBeTruthy();
  await userEvent.click(input);
  await userEvent.paste("x".repeat(101));
  expect(input.value).toBe("x".repeat(100));
  await waitFor(() => expect(onFilters).toHaveBeenCalledWith({ q: "x".repeat(100) }));
});
