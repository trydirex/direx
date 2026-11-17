// SPDX-License-Identifier: AGPL-3.0-only
// Review time in Settings: an approver makes the calendar link and sees it once; saving, getting a
// new link and stopping call the right routes; someone who can't approve gets no form.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { ReviewTime } from "./ReviewTime";

const W = "00000000-0000-4000-8000-0000000000aa";
const URL = `https://app.example/api/feeds/review/${W}/${"a".repeat(64)}.ics`;
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const FEED = { weekdays: [1, 3], startMinute: 9 * 60, lengthMinutes: 60, timeZone: "Europe/London", createdAt: "2026-11-13T09:00:00.000Z", lastFetchedAt: null, fetchCount: 0 };
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(state: { feed: unknown; reachable: boolean }) {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, state)) as never);
  return {
    post: vi.spyOn(api, "POST").mockImplementation((() => reply(200, { url: URL })) as never),
    put: vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { ok: true })) as never),
    del: vi.spyOn(api, "DELETE").mockImplementation((() => reply(200, { ok: true })) as never),
  };
}

test("an approver makes the link, sees it once with how to subscribe, and copies it", async () => {
  const { post } = serve({ feed: null, reachable: false });
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  render(withQueries(<ReviewTime workspaceId={W} role="marketer" />));
  expect(await screen.findByText(/no public HTTPS address/)).toBeTruthy();

  await userEvent.click(await screen.findByRole("button", { name: "Make my calendar link" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/review-feed/link", { params: { path: { workspaceId: W } }, body: { weekdays: [2, 4], startMinute: 600, lengthMinutes: 30, timeZone: zone } });
  const link = within(await screen.findByRole("region", { name: "Your calendar link" }));
  expect(link.getByText(URL)).toBeTruthy();
  expect(link.getByText(/New Calendar Subscription/)).toBeTruthy();
  await userEvent.click(link.getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith(URL);
  expect(await link.findByRole("button", { name: "Copied" })).toBeTruthy();
});

test("with no day picked nothing is sent", async () => {
  const { post } = serve({ feed: null, reachable: true });
  render(withQueries(<ReviewTime workspaceId={W} role="owner" />));
  for (const day of ["Tue", "Thu"]) await userEvent.click(await screen.findByRole("checkbox", { name: day }));
  await userEvent.click(screen.getByRole("button", { name: "Make my calendar link" }));
  expect(await screen.findByText("Pick at least one day.")).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
  expect(screen.queryByText(/no public HTTPS address/)).toBeNull();
});

test("with a link on, Save changes the settings, Get a new link asks first, and Stop ends it", async () => {
  const { post, put, del } = serve({ feed: FEED, reachable: true });
  render(withQueries(<ReviewTime workspaceId={W} role="admin" />));
  expect(await screen.findByText(/hasn't checked it yet/)).toBeTruthy();
  expect(screen.queryByText(URL)).toBeNull();

  await userEvent.click(screen.getByRole("checkbox", { name: "Fri" }));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/review-feed", { params: { path: { workspaceId: W } }, body: { weekdays: [1, 3, 5], startMinute: 540, lengthMinutes: 60, timeZone: "Europe/London" } });

  await userEvent.click(screen.getByRole("button", { name: "Get a new link" }));
  const ask = within(await screen.findByRole("dialog"));
  expect(ask.getByText(/stops working/)).toBeTruthy();
  await userEvent.click(ask.getByRole("button", { name: "Get a new link" }));
  expect(post).toHaveBeenCalledTimes(1);
  expect(await screen.findByText(URL)).toBeTruthy();

  cleanup();
  render(withQueries(<ReviewTime workspaceId={W} role="admin" />));
  await userEvent.click(await screen.findByRole("button", { name: "Stop my calendar link" }));
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop" }));
  expect(del).toHaveBeenCalledWith("/api/w/{workspaceId}/review-feed", { params: { path: { workspaceId: W } } });
});

test("someone who can't approve gets an explanation, not a form", () => {
  serve({ feed: null, reachable: true });
  render(withQueries(<ReviewTime workspaceId={W} role="contributor" />));
  expect(screen.getByText(/for people who approve/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Make my calendar link" })).toBeNull();
});
