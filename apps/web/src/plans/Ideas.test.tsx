// SPDX-License-Identifier: AGPL-3.0-only
// Ideas on Home: one line saves one, Start a campaign fills the dialog with its words and links the plan
// made from it, Dismiss hides it, and a viewer reads them without the buttons.
import { afterEach, expect, test, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { Ideas, titleOf } from "./Ideas";

const W = "00000000-0000-4000-8000-0000000000aa";
const PLAN = "00000000-0000-4000-8000-0000000000bb";
const U = "00000000-0000-4000-8000-0000000000cc";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const show = (el: ReactElement) => render(withQueries(createElement(RouterContextProvider, { router, children: el })));
const idea = (id: string, text: string) => ({ id, text, createdBy: U, createdAt: "2026-11-14T10:00:00.000Z" });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The Ideas list answers from `open` and `started`; a new plan is PLAN, with no Campaign to open. */
function serve(state: { open: ReturnType<typeof idea>[]; started?: unknown[] }) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/ideas") return reply(200, { open: state.open, started: state.started ?? [] });
    if (path === "/api/w/{workspaceId}/strategy") return reply(200, { currentVersion: null });
    return reply(404, { error: "not_found" });
  }) as never);
  return vi.spyOn(api, "POST").mockImplementation(((path: string, init: { body?: { text?: string } }) => {
    if (path === "/api/w/{workspaceId}/ideas") {
      state.open = [idea("new", init.body!.text!), ...state.open];
      return reply(200, state.open[0]);
    }
    if (path === "/api/w/{workspaceId}/plans") return reply(200, { id: PLAN });
    return reply(200, { ok: true });
  }) as never);
}

test("titleOf keeps a short idea and cuts a long one at a word", () => {
  expect(titleOf("Webinar")).toBe("Webinar");
  const long = "Run a webinar with two customers about how they cut their month-end close from ten days to four";
  expect(titleOf(long)).toBe("Run a webinar with two customers about how they cut their month-end close from");
  expect(titleOf(long).length).toBeLessThanOrEqual(80);
});

test("an idea is added in one line, and Start a campaign fills the dialog and links the plan made from it", async () => {
  const post = serve({ open: [] });
  show(<Ideas workspaceId={W} edit />);
  const box = await screen.findByRole("textbox", { name: "New idea" });
  await userEvent.type(box, "  Partner webinar  {Enter}");
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/ideas", { params: { path: { workspaceId: W } }, body: { text: "Partner webinar" } });
  const list = within(await screen.findByRole("list", { name: "Open ideas" }));
  expect(list.getByText("Partner webinar")).toBeTruthy();
  expect((box as HTMLInputElement).value).toBe("");

  await userEvent.click(list.getByRole("button", { name: "Start a campaign" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Start a campaign" }));
  expect((dialog.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Partner webinar");
  expect((dialog.getByRole("textbox", { name: /What do you want/ }) as HTMLTextAreaElement).value).toBe("Partner webinar");
  await userEvent.click(dialog.getByRole("button", { name: "Write it myself" }));
  await waitFor(() => expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/ideas/{id}/started", { params: { path: { workspaceId: W, id: "new" } }, body: { planId: PLAN } }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/plans", { params: { path: { workspaceId: W } }, body: { title: "Partner webinar", request: "Partner webinar" } });
});

test("Dismiss hides an idea; a started one says what it became; a viewer gets no buttons", async () => {
  const post = serve({ open: [idea("i1", "Podcast tour")], started: [{ ...idea("i2", "Q1 launch"), planId: PLAN, planTitle: "Q1 launch push", startedAt: "2026-11-13T10:00:00.000Z" }] });
  show(<Ideas workspaceId={W} edit />);
  expect(await screen.findByRole("link", { name: "Q1 launch push" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss Podcast tour" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/ideas/{id}/dismiss", { params: { path: { workspaceId: W, id: "i1" } } });
  cleanup();
  serve({ open: [idea("i1", "Podcast tour")] });
  show(<Ideas workspaceId={W} edit={false} />);
  expect(await screen.findByText("Podcast tour")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Start a campaign" })).toBeNull();
});

test("a save or a dismiss that fails says so, and Cancel or Escape closes Start a campaign", async () => {
  serve({ open: [idea("i1", "Podcast tour")] });
  vi.mocked(api.POST).mockImplementation((() => reply(500, { error: "failed" })) as never);
  show(<Ideas workspaceId={W} edit />);
  await userEvent.type(await screen.findByRole("textbox", { name: "New idea" }), "Webinar{Enter}");
  expect(await screen.findByText("That idea wasn't saved. Try again.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Dismiss Podcast tour" }));
  expect(await screen.findByText("That idea wasn't dismissed. Try again.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Start a campaign" }));
  await userEvent.click(within(await screen.findByRole("dialog", { name: "Start a campaign" })).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await userEvent.click(screen.getByRole("button", { name: "Start a campaign" }));
  await screen.findByRole("dialog", { name: "Start a campaign" });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
