// SPDX-License-Identifier: AGPL-3.0-only
// The frame on a phone: a top bar with the menu, the Workspace, what needs you and the pause.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries, openDialog } from "../testing";
import { Page } from "../components/layout";
import { SetupFrame, Shell } from "./Shell";
import type { MyWorkspace } from "./session";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (body: unknown) => Promise.resolve({ data: body, response: new Response(null, { status: 200 }) });
const workspace = (role: MyWorkspace["role"]): MyWorkspace => ({ id: W, name: "Acme", role, organization: { id: "00000000-0000-4000-8000-0000000000bb", name: "Acme Inc" } });
const Search = () => null;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show(role: MyWorkspace["role"], needYou: number, paused = false) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) =>
    path === "/api/w/{workspaceId}/items" ? reply({ items: [], needsYouCount: needYou }) : reply({ paused })) as never);
  const current = workspace(role);
  render(withQueries(<Shell workspaces={[current]} current={current} Search={Search}><p>Page</p></Shell>));
}

test("the top bar names the Workspace, counts what needs you, and opens the menu, which a pick closes", async () => {
  show("owner", 3);
  expect(await screen.findByRole("link", { name: "3 need you" })).toBeTruthy();
  // The top bar names the Workspace (the switchers show it too, as their choice).
  expect(within(document.querySelector("header")!).getByText("Acme", { selector: "span:not([aria-hidden])" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Pause all sending" })).toBeTruthy();
  // The count also rides on Home in the sidebar, said in words to a screen reader.
  expect(screen.getAllByRole("link", { name: "Home (3 need you)" }).length).toBeGreaterThan(0);

  const menu = screen.getByRole("button", { name: "Menu" });
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  await userEvent.click(menu);
  const sheet = within(await screen.findByRole("dialog", { name: "Menu" }));
  expect(sheet.getByRole("link", { name: "Calendar" })).toBeTruthy();
  await userEvent.click(sheet.getByRole("link", { name: "Calendar" }));
  await waitFor(() => expect(openDialog("Menu")).toBeNull());
});

test("a viewer gets the menu but no pause, and nothing needing them shows no count", async () => {
  show("viewer", 0);
  expect(await screen.findByRole("button", { name: "Menu" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Pause all sending" })).toBeNull();
  expect(screen.queryByRole("link", { name: /need you/ })).toBeNull();
  expect(screen.queryByText(/Sending is paused/)).toBeNull();
});

test("while sending is paused, a viewer is told so and who can turn it back on, with no button to do it", async () => {
  show("viewer", 0, true);
  expect(await screen.findByText("Sending is paused. Nothing goes out until an Owner, Admin or Marketer turns sending back on.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Turn sending back on/ })).toBeNull();
});

test("the rail names every icon, marks the current section, and opens the Workspace menu with Sign out by keyboard", async () => {
  show("owner", 2);
  const main = within(screen.getByRole("navigation", { name: "Main" }));
  expect(await main.findByRole("link", { name: "Home (2 need you)" })).toBeTruthy();
  // Each name is visible text under its icon, not only a tooltip.
  for (const name of ["Calendar", "Campaigns", "Audience"]) expect(main.getByRole("link", { name }).textContent).toBe(name);
  // ADR 0023: a plan opens only inside its Campaign, so Plan has no nav item.
  expect(main.queryByRole("link", { name: "Plan" })).toBeNull();
  expect(main.getByRole("link", { name: "Home (2 need you)" }).textContent).toMatch(/^Home/);
  const pinned = within(screen.getByRole("navigation", { name: "Workspace" }));
  for (const name of ["Brand", "Settings"]) expect(pinned.getByRole("link", { name }).textContent).toBe(name);
  expect(pinned.getByRole("button", { name: "Search and actions" })).toBeTruthy();
  expect(main.getByRole("link", { name: "Home (2 need you)" }).getAttribute("aria-current")).toBe("page");
  expect(main.getByRole("link", { name: "Calendar" }).getAttribute("aria-current")).toBeNull();

  const workspace = screen.getByRole("button", { name: "Workspace: Acme" });
  workspace.focus();
  await userEvent.keyboard("{Enter}");
  const popup = within(await screen.findByRole("dialog"));
  expect(popup.getByRole("combobox", { name: "Workspace" })).toBeTruthy();
  expect(popup.getByRole("button", { name: "Sign out" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(openDialog()).toBeNull());
  expect(document.activeElement).toBe(workspace);
});

test("the menu offers Add a password only to an account without one", async () => {
  for (const hasPassword of [false, true]) {
    vi.spyOn(api, "GET").mockImplementation(((path: string) =>
      path === "/api/me" ? reply({ user: { id: "u1", email: "sam@example.com", name: "", hasPassword } }) : path === "/api/w/{workspaceId}/items" ? reply({ items: [], needsYouCount: 0 }) : reply({ paused: false })) as never);
    const current = workspace("owner");
    render(withQueries(<Shell workspaces={[current]} current={current} Search={Search}><p>Page</p></Shell>));
    await userEvent.click(await screen.findByRole("button", { name: "Menu" }));
    const sheet = within(await screen.findByRole("dialog", { name: "Menu" }));
    await waitFor(() => expect(sheet.queryAllByRole("link", { name: "Add a password" }).length).toBe(hasPassword ? 0 : 1));
    cleanup();
    vi.restoreAllMocks();
  }
});

test("a Contributor, who can't approve, is told how many wait for approval, not that they need them", async () => {
  show("contributor", 2);
  expect(await screen.findByRole("link", { name: "2 waiting for approval" })).toBeTruthy();
  expect(screen.getAllByRole("link", { name: "Home (2 waiting for approval)" }).length).toBeGreaterThan(0);
  expect(screen.queryByRole("link", { name: /need you/ })).toBeNull();
});

test("on a phone the Workspace name keeps a readable width, so the pause wraps instead of cutting it to a letter", () => {
  show("owner", 3);
  const name = within(document.querySelector("header")!).getByText("Acme", { selector: "span:not([aria-hidden])" });
  expect(name.className).toContain("max-md:basis-40");
});

test("the menu links the deleted Workspaces only while one this person deleted as an Owner can still be exported", async () => {
  const gone = { id: "00000000-0000-4000-8000-0000000000cc", name: "Old", organization: { id: "o", name: "Acme" }, deletedAt: "2026-11-16T10:00:00.000Z", purgeFrom: "2026-12-16T10:00:00.000Z" };
  for (const deleted of [[gone], []]) {
    const asked: string[] = [];
    vi.spyOn(api, "GET").mockImplementation(((path: string) =>
      (asked.push(path), path) === "/api/me/deleted-workspaces" ? reply({ workspaces: deleted }) : path === "/api/w/{workspaceId}/items" ? reply({ items: [], needsYouCount: 0 }) : reply({ paused: false })) as never);
    const current = workspace("owner");
    render(withQueries(<Shell workspaces={[current]} current={current} Search={Search}><p>Page</p></Shell>));
    await userEvent.click(await screen.findByRole("button", { name: "Menu" }));
    const sheet = within(await screen.findByRole("dialog", { name: "Menu" }));
    if (deleted.length) expect((await sheet.findByRole("link", { name: "Deleted Workspaces" })).getAttribute("href")).toBe("/deleted-workspaces");
    else {
      // Once the list has come back empty, there is no link to wait for.
      await waitFor(() => expect(asked).toContain("/api/me/deleted-workspaces"));
      await new Promise((r) => setTimeout(r, 0));
      expect(sheet.queryByRole("link", { name: "Deleted Workspaces" })).toBeNull();
    }
    cleanup();
    vi.restoreAllMocks();
  }
});

test("setup's frame leaves the one main landmark to the page inside it", () => {
  render(
    <SetupFrame>
      <Page title="Set up Acme">Steps</Page>
    </SetupFrame>,
  );
  expect(screen.getAllByRole("main")).toHaveLength(1);
});
