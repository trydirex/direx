// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { PauseAll } from "./PauseAll";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("Pause all sending works from the keyboard and flips its label", async () => {
  const put = vi.spyOn(api, "PUT").mockResolvedValueOnce({ data: {} } as never);
  render(<PauseAll workspaceId="w1" paused={false} />);

  await userEvent.tab();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Pause all sending" }));
  await userEvent.keyboard("{Enter}");

  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/pause", { params: { path: { workspaceId: "w1" } }, body: { paused: true } });
  expect(await screen.findByRole("button", { name: "Sending is paused. Turn sending back on" })).toBeTruthy();
});

test("after a pause, Undo in the toast turns sending back on without asking again", async () => {
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: {} } as never);
  const changed: boolean[] = [];
  render(withQueries(<PauseAll workspaceId="w1" paused={false} onChange={(x) => changed.push(x)} />));

  await userEvent.click(screen.getByRole("button", { name: "Pause all sending" }));
  expect(await screen.findByText("Nothing goes out until it's turned back on.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));

  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/outreach/pause", { params: { path: { workspaceId: "w1" } }, body: { paused: false } });
  expect(await screen.findByText("Sending is back on.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Pause all sending" })).toBeTruthy();
  expect(changed).toEqual([true, false]);
});

test("a refused pause leaves the label as it was", async () => {
  vi.spyOn(api, "PUT").mockResolvedValueOnce({ error: { error: "forbidden" } } as never);
  render(<PauseAll workspaceId="w1" paused={false} />);

  await userEvent.click(screen.getByRole("button", { name: "Pause all sending" }));

  expect(screen.getByRole("button", { name: "Pause all sending" })).toBeTruthy();
  expect(screen.queryByText(/Sending is paused/)).toBeNull();
  expect((await screen.findByRole("alert")).textContent).toBe("Sending was not paused. Try again.");
});

test("when the pause state can't be read, it says so and still offers the pause", async () => {
  vi.spyOn(api, "GET").mockResolvedValueOnce({ error: { error: "failed" } } as never);
  render(<PauseAll workspaceId="w1" />);

  expect(await screen.findByRole("button", { name: "Pause all sending" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("Couldn't read whether sending is paused.");
});

test("with no state given, it loads the pause state before showing anything", async () => {
  const get = vi.spyOn(api, "GET").mockResolvedValueOnce({ data: { paused: true } } as never);
  render(<PauseAll workspaceId="w1" />);

  expect(screen.queryByRole("button")).toBeNull();
  expect(await screen.findByRole("button", { name: "Sending is paused. Turn sending back on" })).toBeTruthy();
  expect(get).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach", { params: { path: { workspaceId: "w1" } } });
});

test("pausing is one press, but turning sending back on asks first", async () => {
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: {} } as never);
  render(<PauseAll workspaceId="w1" paused={true} />);

  await userEvent.click(screen.getByRole("button", { name: "Sending is paused. Turn sending back on" }));
  expect(put).not.toHaveBeenCalled();
  await userEvent.click(await screen.findByRole("button", { name: "Turn sending back on" }));

  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/pause", { params: { path: { workspaceId: "w1" } }, body: { paused: false } });
  expect(await screen.findByRole("button", { name: "Pause all sending" })).toBeTruthy();
});
