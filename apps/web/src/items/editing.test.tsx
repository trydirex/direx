// SPDX-License-Identifier: AGPL-3.0-only
// The Item panel's own fixes: a Campaign email's words edited in place (E opens the editor), a post's
// length against its network's limit and its words edited in place too, Raw only for owners and admins, and a Held Item's next step.
import { afterEach, expect, test, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { addDays, type Item, type Role } from "./actions";
import { Review } from "./Review";
import { ItemPanel, withoutFooter } from "./ItemPanel";

const W = "00000000-0000-4000-8000-0000000000aa";
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
  title: "To Kim",
  workArea: "outreach",
  channel: "email",
  groupKey: "campaign:c1:step:first",
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
const EMAIL = { to: ["kim@acme.test"], subject: "Your books", text: "Hi Kim,\nWe do bookkeeping.\n\n--\nUnsubscribe: https://x.test/u", touch: { personId: "p1", touchClass: "cold" } };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** One Item; after a save it reads back as `after` says. */
function serve(o: { item: () => Item; content?: unknown; appearance?: unknown; trackedLinks?: { url: string; destination: string }[] }) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    const i = o.item();
    if (path === "/api/w/{workspaceId}/items") return reply(200, { items: [i], needsYouCount: 1 });
    if (path === "/api/w/{workspaceId}/review-rates") return reply(200, { decisions: 0, medianSeconds: null, changedShare: null, warning: false });
    if (path === "/api/w/{workspaceId}/items/{id}") return reply(200, { item: i, content: o.content ?? EMAIL, timeline: [], ruleGrantedBy: null, appearance: o.appearance ?? null, trackedLinks: o.trackedLinks ?? [] });
    return reply(404, { error: "not_found" });
  }) as never);
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { ok: true })) as never);
  const post = vi.spyOn(api, "POST").mockImplementation(((path: string) => reply(200, path.endsWith("/move") ? { results: [{ id: "i1", ok: true }] } : {})) as never);
  return { put, post };
}
const panel = (role: Role = "marketer") => show(<ItemPanel workspaceId={W} id="i1" role={role} />);

test("an email's tracked links show where each one goes, and an email without any shows no block", async () => {
  const links = [
    { url: "https://links.acme.test/t/AAAAAAAAAAAAAAAAAAAAAA", destination: "https://acme.example/pricing" },
    { url: "https://links.acme.test/t/BBBBBBBBBBBBBBBBBBBBBB", destination: "https://xn--bcher-kva.example/a" },
  ];
  serve({ item: () => item(), trackedLinks: links });
  panel();
  const block = await screen.findByRole("region", { name: "Tracked links" });
  expect(within(block).getAllByRole("listitem").map((li) => li.textContent)).toEqual(links.map((l) => `${l.url}Goes to ${l.destination}`));
  cleanup();
  vi.restoreAllMocks();
  serve({ item: () => item() });
  panel();
  await screen.findByRole("region", { name: "Email" });
  expect(screen.queryByRole("region", { name: "Tracked links" })).toBeNull();
});

test("the footer is left out of what a person edits", () => {
  expect(withoutFooter(EMAIL.text)).toBe("Hi Kim,\nWe do bookkeeping.");
  expect(withoutFooter("No footer")).toBe("No footer");
});

test("E opens a Campaign email's words for editing, and Save and approve approves the saved version", async () => {
  let current = item();
  const { put, post } = serve({ item: () => current });
  show(<Review workspaceId={W} role="marketer" />);
  await screen.findByRole("button", { name: "Edit text" });
  await userEvent.keyboard("e");
  const form = await screen.findByRole("form", { name: "Edit text" });
  const text = within(form).getByRole("textbox", { name: "Email" }) as HTMLTextAreaElement;
  expect(text.value).toBe("Hi Kim,\nWe do bookkeeping.");
  await userEvent.clear(text);
  await userEvent.type(text, "Hi Kim, fixed.");
  // The save bumps the revision; the approve carries the new one.
  put.mockImplementation((() => {
    current = item({ revision: 3 });
    return reply(200, { ok: true });
  }) as never);
  await userEvent.click(within(form).getByRole("button", { name: "Save and approve" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", expect.objectContaining({ body: expect.objectContaining({ revision: 3 }) })));
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/people/{personId}/draft", { params: { path: { workspaceId: W, id: "c1", key: "first", personId: "p1" } }, body: { subject: "Your books", text: "Hi Kim, fixed." } });
});

test("Save and approve leaves a saved email with warnings for the person to read, and a refused save says why", async () => {
  let current = item();
  const { put, post } = serve({ item: () => current });
  panel();
  await userEvent.click(await screen.findByRole("button", { name: "Edit text" }));
  put.mockImplementationOnce((() => reply(409, { error: "link_not_vouched" })) as never);
  await userEvent.click(screen.getByRole("button", { name: "Save and approve" }));
  expect((await screen.findByRole("alert")).textContent).toContain("That link isn't in your brand facts");
  put.mockImplementation((() => {
    current = item({ revision: 3, clean: false });
    return reply(200, { ok: true });
  }) as never);
  await userEvent.click(screen.getByRole("button", { name: "Save and approve" }));
  await waitFor(() => expect(screen.queryByRole("form", { name: "Edit text" })).toBeNull());
  expect(post).not.toHaveBeenCalledWith("/api/w/{workspaceId}/items/{id}/approve", expect.anything());
});

test("no text editor for a viewer, an email outside a Campaign, or one already sent; a viewer can't approve from it either", async () => {
  serve({ item: () => item() });
  panel("viewer");
  await screen.findByRole("article", { name: "To Kim" });
  expect(screen.queryByRole("button", { name: "Edit text" })).toBeNull();
  cleanup();
  serve({ item: () => item({ groupKey: null }) });
  panel();
  await screen.findByRole("article", { name: "To Kim" });
  expect(screen.queryByRole("button", { name: "Edit text" })).toBeNull();
  cleanup();
  serve({ item: () => item({ state: "sent" }) });
  panel();
  await screen.findByRole("article", { name: "To Kim" });
  expect(screen.queryByRole("button", { name: "Edit text" })).toBeNull();
  cleanup();
  serve({ item: () => item() });
  panel("contributor");
  await userEvent.click(await screen.findByRole("button", { name: "Edit text" }));
  expect(screen.queryByRole("button", { name: "Save and approve" })).toBeNull();
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("form", { name: "Edit text" })).toBeNull();
});

test("a post shows its length against its network's limit, in red when over", async () => {
  serve({ item: () => item({ workArea: "social", groupKey: null }), content: { text: "a".repeat(300) }, appearance: { kind: "post", account: "Acme", network: "X", link: null } });
  panel();
  const count = await screen.findByText("300 of 280 characters: 20 over the X limit");
  expect(count.className).toContain("text-destructive");
  cleanup();
  serve({ item: () => item({ workArea: "social", groupKey: null }), content: { text: "Short" }, appearance: { kind: "post", account: "Acme", network: "LinkedIn", link: null } });
  panel();
  expect((await screen.findByText("5 of 3000 characters")).className).toContain("text-muted-foreground");
});

test("E opens a post's words with its network's count, and Save sends it back for approval", async () => {
  const post = { workArea: "social", channel: "x", groupKey: null, state: "scheduled" as const };
  const { put } = serve({ item: () => item(post), content: { text: "Old words", followUps: [] }, appearance: { kind: "post", account: "Acme", network: "X", link: null } });
  show(<Review workspaceId={W} role="marketer" />);
  await screen.findByRole("button", { name: "Edit text" });
  await userEvent.keyboard("e");
  const form = await screen.findByRole("form", { name: "Edit text" });
  const text = within(form).getByRole("textbox", { name: "X post" }) as HTMLTextAreaElement;
  expect(text.value).toBe("Old words");
  await userEvent.clear(text);
  await userEvent.type(text, "New words");
  expect(within(form).getByText("9 of 280 characters")).toBeTruthy();
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/social/posts/{itemId}", { params: { path: { workspaceId: W, itemId: "i1" } }, body: { text: "New words" } }));
  await waitFor(() => expect(screen.queryByRole("form", { name: "Edit text" })).toBeNull());
  cleanup();
  serve({ item: () => item({ ...post, state: "sent" }), content: { text: "Gone" }, appearance: { kind: "post", account: "Acme", network: "X", link: null } });
  panel();
  await screen.findByText("Gone");
  expect(screen.queryByRole("button", { name: "Edit text" })).toBeNull();
});

test("a refused post edit says the network's reason", async () => {
  const { put } = serve({ item: () => item({ workArea: "social", groupKey: null }), content: { text: "Hi" }, appearance: { kind: "post", account: "Acme", network: "X", link: null } });
  put.mockImplementation((() => reply(409, { error: "refused_by_network", detail: "300 of 280 characters" })) as never);
  panel();
  await userEvent.click(await screen.findByRole("button", { name: "Edit text" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toContain("300 of 280 characters");
});

test("Raw shows only for owners and admins", async () => {
  serve({ item: () => item() });
  panel("marketer");
  await screen.findByRole("article", { name: "To Kim" });
  expect(screen.queryByText("Raw")).toBeNull();
  cleanup();
  serve({ item: () => item() });
  panel("admin");
  expect(await screen.findByText("Raw")).toBeTruthy();
});

test("a Held Item says its next step where the reason is known: an account at today's limit moves to tomorrow", async () => {
  const { post } = serve({ item: () => item({ state: "held", reasonCode: "account_budget_reached", reason: "10 of 10 posts today on this account", workArea: "social" }), content: { text: "Hi" } });
  panel();
  await userEvent.click(await screen.findByRole("button", { name: "Move it to tomorrow" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/items/move", { params: { path: { workspaceId: W } }, body: { items: [{ id: "i1", plannedAt: addDays(new Date(at), 1).toISOString() }] } }));
  cleanup();
  serve({ item: () => item({ state: "held", reasonCode: "campaign_paused" }) });
  panel();
  expect((await screen.findByRole("link", { name: "Resume the Campaign" })).getAttribute("href")).toBe(`/w/${W}/campaigns/c1`);
  cleanup();
  serve({ item: () => item({ state: "held", reasonCode: "mailbox_unchecked" }) });
  panel();
  expect(await screen.findByRole("link", { name: "Run the check" })).toBeTruthy();
  cleanup();
  serve({ item: () => item({ state: "held", reasonCode: "mailbox_paused" }) });
  panel();
  expect((await screen.findByRole("link", { name: "See why" })).getAttribute("href")).toBe(`/w/${W}/settings/credentials`);
  cleanup();
  serve({ item: () => item({ state: "held", reasonCode: "something_else" }) });
  panel();
  await screen.findByRole("article", { name: "To Kim" });
  expect(screen.queryByText(/Sending is paused|Move it to tomorrow|Run the check/)).toBeNull();
});
