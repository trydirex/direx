// SPDX-License-Identifier: AGPL-3.0-only
// The deleted Workspaces page: each one the person deleted as an Owner, when it can be purged, and its
// export; an empty list says what will show here; with no live Workspace the way out is a new Organization.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { DeletedWorkspaces } from "./DeletedWorkspaces";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const gone = { id: W, name: "Shop", organization: { id: "o", name: "Acme" }, deletedAt: "2026-11-16T10:00:00.000Z", purgeFrom: "2026-12-16T10:00:00.000Z" };
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(deleted: unknown[], live: unknown[]) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/me/deleted-workspaces") return reply(200, { workspaces: deleted });
    if (path === "/api/me/workspaces") return reply(200, { workspaces: live });
    if (path === "/api/exports/{workspaceId}") return reply(200, { exports: [] });
    return reply(404, { error: "not_found" });
  }) as never);
}

test("each deleted Workspace shows when it can be purged, and starts its export", async () => {
  serve([gone], [{ id: "w2", name: "Blog", role: "owner", organization: { id: "o", name: "Acme" } }]);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(202, { export: { id: "e1", state: "building", requestedAt: "2026-11-16T11:00:00.000Z", readyAt: null, expiresAt: null, bytes: null } })) as never);
  render(withQueries(<DeletedWorkspaces />));
  expect(screen.getByRole("heading", { level: 1, name: "Deleted Workspaces" })).toBeTruthy();
  const section = within(await screen.findByRole("region", { name: "Shop (Acme)" }));
  expect(section.getByText(`Deleted on ${day(gone.deletedAt)}. It can be purged from ${day(gone.purgeFrom)}, so download its export before then.`)).toBeTruthy();
  expect(section.getByText("After a deleted Workspace is purged, Direx keeps no record of what it sent or of consent. Keep this export for at least 6 years.")).toBeTruthy();
  await userEvent.click(await section.findByRole("button", { name: "Start an export" }));
  expect(post).toHaveBeenCalledWith("/api/exports/{workspaceId}", { params: { path: { workspaceId: W } } });
  expect((await screen.findByRole("link", { name: "Back to your Workspace" })).getAttribute("href")).toBe("/");
});

test("with nothing deleted the page says what shows here; with no live Workspace it offers a new Organization", async () => {
  serve([], []);
  render(withQueries(<DeletedWorkspaces />));
  expect(await screen.findByText("No deleted Workspaces")).toBeTruthy();
  expect(screen.getByText("A Workspace you delete as an Owner shows here until it is purged, so you can export its data.")).toBeTruthy();
  expect((await screen.findByRole("link", { name: "Create an Organization" })).getAttribute("href")).toBe("/new-org");
});
