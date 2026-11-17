// SPDX-License-Identifier: AGPL-3.0-only
// The Owner's export section: the warning that a purge keeps no proof, no export yet, one building, a
// refusal, a ready download link, and an ended or failed one; and only an Owner sees it on the Overview.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { ExportData } from "./ExportData";
import { Overview } from "./Overview";
import type { WorkspaceExport } from "./actions";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const made = (o: Partial<WorkspaceExport>): WorkspaceExport => ({ id: "e1", state: "ready", requestedAt: "2026-11-16T10:00:00.000Z", readyAt: "2026-11-16T10:01:00.000Z", expiresAt: "2026-11-17T10:01:00.000Z", bytes: 3 * 1024 ** 2, ...o });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("with no export yet, starting one shows it building", async () => {
  let list: WorkspaceExport[] = [];
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { exports: list })) as never);
  const post = vi.spyOn(api, "POST").mockImplementation((() => {
    list = [made({ state: "building", readyAt: null, expiresAt: null, bytes: null })];
    return reply(202, { export: list[0] });
  }) as never);
  render(withQueries(<ExportData workspaceId={W} />));
  expect(await screen.findByText("No export yet.")).toBeTruthy();
  expect(screen.getByText("After a deleted Workspace is purged, Direx keeps no record of what it sent or of consent. Keep this export for at least 6 years.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Start an export" }));
  expect(post).toHaveBeenCalledWith("/api/exports/{workspaceId}", { params: { path: { workspaceId: W } } });
  expect(await screen.findByText("Building your export. This page updates when it is ready.")).toBeTruthy();
});

test("a refusal says one is already being built", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { exports: [] })) as never);
  vi.spyOn(api, "POST").mockImplementation((() => reply(409, { error: "export_running" })) as never);
  render(withQueries(<ExportData workspaceId={W} />));
  await userEvent.click(await screen.findByRole("button", { name: "Start an export" }));
  expect(await screen.findByText("An export is already being built.")).toBeTruthy();
});

test("a ready export links to its download with its size", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { exports: [made({})] })) as never);
  render(withQueries(<ExportData workspaceId={W} />));
  const link = await screen.findByRole("link", { name: "Download the ZIP" });
  expect(link.getAttribute("href")).toBe(`/api/exports/${W}/e1`);
  expect(link.parentElement!.textContent).toContain("(3.0 MB), until");
});

test("an ended or failed export asks for a new one", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { exports: [made({ state: "expired" })] })) as never);
  render(withQueries(<ExportData workspaceId={W} />));
  expect(await screen.findByText("The last export's link has ended. Start a new one to download again.")).toBeTruthy();
  cleanup();
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { exports: [made({ state: "failed", readyAt: null, expiresAt: null, bytes: null })] })) as never);
  render(withQueries(<ExportData workspaceId={W} />));
  expect(await screen.findByText("The last export could not be built. Start it again.")).toBeTruthy();
});

test("only an Owner sees the export on the Overview", async () => {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => (path === "/api/exports/{workspaceId}" ? reply(200, { exports: [] }) : reply(404, { error: "not_found" }))) as never);
  const ws = (role: "owner" | "admin") => ({ id: W, name: "Shop", role, organization: { id: "o", name: "Acme" } });
  render(withQueries(<Overview workspace={ws("owner")} me="u1" />));
  expect(await screen.findByRole("heading", { name: "Export this Workspace" })).toBeTruthy();
  cleanup();
  render(withQueries(<Overview workspace={ws("admin")} me="u1" />));
  expect(screen.queryByRole("heading", { name: "Export this Workspace" })).toBeNull();
});
