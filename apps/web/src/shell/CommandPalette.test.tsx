// SPDX-License-Identifier: AGPL-3.0-only
// The command palette inside the real shell and routes: Ctrl K and its button open it, typing
// filters, Enter runs, Escape closes, and Review's keys show only on Review.
import { afterEach, expect, test, vi } from "vitest";
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { makeQueryClient } from "@/api/query";
import { api } from "@/client";
import { routeTree } from "@/router";
import { openDialog } from "../testing";

const W = "11111111-1111-1111-1111-111111111111";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Serious and critical WCAG A and AA violations, 2.0 to 2.2. */
async function violations(node: Element = document.body) {
  // Base UI's focus guards are hidden tabindex=0 sentinels that send focus straight back into the
  // popup, so axe's aria-hidden-focus misreads them.
  const r = await axe.run({ include: [node], exclude: ["[data-base-ui-focus-guard]"] }, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

async function open(path: string, items: object[] = []) {
  vi.spyOn(api, "GET").mockImplementation(((p: string) => {
    const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
    if (p === "/api/me") return reply(200, { user: { id: "u1", email: "sam@example.com" } });
    if (items.length && p === "/api/w/{workspaceId}/items") return reply(200, { items, needsYouCount: items.length });
    if (items.length && p === "/api/w/{workspaceId}/items/{id}") return reply(200, { item: items[0], timeline: [] });
    if (p === "/api/me/workspaces") return reply(200, { workspaces: [{ id: W, name: "Contoso", role: "owner", organization: { id: "o1", name: "Contoso" } }] });
    return reply(404, { error: "not_found" });
  }) as never);
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [`/w/${W}${path}`] }), context: { queryClient: client } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByRole("navigation", { name: "Main" });
  // A person opens the palette once the screen has drawn; wait for it as they would.
  await screen.findByRole("heading", { level: 1 });
  return router;
}

const input = () => screen.findByRole("combobox", { name: "Search and actions" });
// Inside the open palette: the rail's Workspace popover keeps its own options in the page.
const options = () => {
  const palette = openDialog("Search and actions");
  return palette ? within(palette).queryAllByRole("option").map((o) => o.textContent) : [];
};

test("Ctrl K opens it, typing filters, Enter on Calendar goes there and closes it", async () => {
  const user = userEvent.setup();
  const router = await open("");
  await user.keyboard("{Control>}k{/Control}");
  await user.type(await input(), "cal");
  await waitFor(() => expect(options()).toEqual(["Calendar"]));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${W}/calendar`));
  await waitFor(() => expect(openDialog("Search and actions")).toBeNull());
});

test("every page in the section tabs can be reached by name, Newsletter and SEO included", async () => {
  const user = userEvent.setup();
  const router = await open("");
  await user.keyboard("{Control>}k{/Control}");
  for (const [typed, found] of [["newsl", ["Newsletter"]], ["seo", ["SEO"]], ["who is", ["Who is sending"]], ["review", ["Review", "Review time"]]] as const) {
    await user.clear(await input());
    await user.type(await input(), typed);
    await waitFor(() => expect(options()).toEqual(found));
  }
  await user.clear(await input());
  await user.type(await input(), "newsl");
  await waitFor(() => expect(options()).toEqual(["Newsletter"]));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${W}/newsletter`));
});

test("Cmd K opens it from inside a field too", async () => {
  const user = userEvent.setup();
  await open("");
  const field = document.createElement("input");
  document.body.append(field);
  field.focus();
  await user.keyboard("{Meta>}k{/Meta}");
  expect(await screen.findByRole("dialog", { name: "Search and actions" })).toBeTruthy();
  field.remove();
});

test("the button opens it with every screen listed; Escape closes it and gives focus back", async () => {
  const user = userEvent.setup();
  await open("");
  const button = screen.getByRole("button", { name: /Search and actions/ });
  // The rail's icon names its shortcut in the tooltip beside it.
  await user.hover(button);
  expect(await screen.findByText("Search and actions · Ctrl K")).toBeTruthy();
  await user.click(button);
  const dialog = await screen.findByRole("dialog", { name: "Search and actions" });
  await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
  expect(options()).toEqual([
    "Home",
    "Review",
    "Calendar",
    "Campaigns",
    "Newsletter",
    "SEO",
    "Audience",
    "Find companies",
    "Segments",
    "Brand",
    "Lessons",
    "Settings",
    "Members",
    "Email and keys",
    "Who is sending",
    "Social accounts",
    "AI models",
    "Auto-approve",
    "Review time",
    "External tokens",
  ]);
  expect(await violations()).toEqual([]);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(openDialog("Search and actions")).toBeNull());
  expect(document.activeElement).toBe(button);
});

test("an open Item's commands show, with their keys, and leave with it", async () => {
  const user = userEvent.setup();
  // A post waiting for approval, so it can still be edited and Edit is offered.
  const waiting = { id: "i1", kind: "manual_post", state: "needs_approval", reason: null, reasonCode: null, revision: 1, title: "Post: launch", workArea: "social", channel: null, groupKey: null, groupLabel: null, at: null, warnings: [], clean: true, movable: false, decideBy: null, snoozedUntil: null, createdAt: new Date(2026, 10, 3).toISOString() };
  const router = await open("/review/i1", [waiting]);
  await user.keyboard("{Control>}k{/Control}");
  const dialog = await screen.findByRole("dialog", { name: "Search and actions" });
  await waitFor(() => expect(within(dialog).getByRole("option", { name: /Approve/ }).textContent).toBe("ApproveA"));
  expect(options().slice(0, 5)).toEqual(["NextJ", "PreviousK", "ApproveA", "EditE", "SkipS"]);
  expect(await violations()).toEqual([]);

  await user.type(await input(), "Home");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(router.state.location.pathname).toBe(`/w/${W}`));
  await user.keyboard("{Control>}k{/Control}");
  await screen.findByRole("dialog", { name: "Search and actions" });
  expect(options()).not.toContain("NextJ");
});

test("running a screen command calls its handler", async () => {
  const user = userEvent.setup();
  await open("/review/i1");
  await user.keyboard("{Control>}k{/Control}");
  await user.type(await input(), "Skip");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(openDialog("Search and actions")).toBeNull());
});
