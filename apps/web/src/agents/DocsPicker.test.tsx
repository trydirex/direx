// SPDX-License-Identifier: AGPL-3.0-only
// Reading a Notion page for brand facts: the reads form offers it only once Notion is connected, the
// picker lists the shared pages and starts a read, and each refusal says what to do.
import { afterEach, expect, test, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { pick, withQueries } from "../testing";
import { DocsPicker } from "./DocsPicker";
import { Runs } from "./Runs";

const W = "00000000-0000-4000-8000-0000000000aa";
const PAGE = "11111111-1111-4111-8111-111111111111";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const show = (el: ReactElement) => render(withQueries(createElement(RouterContextProvider, { router, children: el })));
const pages = { pages: [{ id: PAGE, title: "Brand guide", url: null, editedAt: null }, { id: "22222222-2222-4222-8222-222222222222", title: "Tone notes", url: null, editedAt: null }], more: false };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(o: { connected: boolean; pages?: unknown; pagesStatus?: number }) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/docs") return reply(200, { provider: "Notion", connected: o.connected });
    if (path === "/api/w/{workspaceId}/docs/pages") return reply(o.pagesStatus ?? 200, o.pages ?? pages);
    if (path === "/api/w/{workspaceId}/agents/runs") return reply(200, { runs: [] });
    return reply(404, { error: "not_found" });
  }) as never);
}

test("the reads form offers a Notion page only when Notion is connected, and reading one starts a read", async () => {
  serve({ connected: false });
  show(<Runs workspaceId={W} role="owner" />);
  await screen.findByRole("button", { name: "Paste text instead" });
  expect(screen.queryByRole("button", { name: "Read a Notion page" })).toBeNull();
  cleanup();

  serve({ connected: true });
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, { runId: "00000000-0000-4000-8000-0000000000dd", title: "Tone notes", cut: true })) as never);
  show(<Runs workspaceId={W} role="owner" />);
  await userEvent.click(await screen.findByRole("button", { name: "Read a Notion page" }));
  await userEvent.click(await screen.findByRole("button", { name: "Use an address instead" }));
  expect(screen.getByRole("textbox", { name: "Address" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Read a Notion page" }));
  await pick(await screen.findByRole("combobox", { name: "Notion page" }), "Tone notes");
  await userEvent.click(screen.getByRole("button", { name: "Read" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/docs/pages/{pageId}/read", { params: { path: { workspaceId: W, pageId: "22222222-2222-4222-8222-222222222222" } } });
  expect(await screen.findByText("That page is longer than one read, so Direx read its start.")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "Notion page" })).toBeNull());
});

test("a refused read says why; no shared pages explains how to share one; not connected links Settings", async () => {
  serve({ connected: true });
  vi.spyOn(api, "POST").mockImplementation((() => reply(409, { error: "no_access" })) as never);
  const cancel = vi.fn();
  show(<DocsPicker workspaceId={W} provider="Notion" onStarted={() => {}} onCancel={cancel} />);
  await screen.findByRole("combobox", { name: "Notion page" });
  await userEvent.click(screen.getByRole("button", { name: "Read" }));
  expect(await screen.findByText(/Direx can't see that page/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Use an address instead" }));
  expect(cancel).toHaveBeenCalled();
  cleanup();

  serve({ connected: true, pages: { pages: [], more: false } });
  show(<DocsPicker workspaceId={W} provider="Notion" onStarted={() => {}} onCancel={() => {}} />);
  expect(await screen.findByText(/No pages are shared with Direx yet/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Read" }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();

  serve({ connected: true, pages: { error: "needs_reconnecting" }, pagesStatus: 409 });
  show(<DocsPicker workspaceId={W} provider="Notion" onStarted={() => {}} onCancel={() => {}} />);
  expect(await screen.findByText(/Its key no longer works/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open Settings" })).toBeTruthy();
});
