// SPDX-License-Identifier: AGPL-3.0-only
// A Campaign's notes: shown with who edited them, edited over the revision read, a stale save refused
// without losing what was typed, and a viewer reads them without an Edit.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { CampaignNotes } from "./CampaignNotes";

const W = "00000000-0000-4000-8000-0000000000aa";
const ID = "00000000-0000-4000-8000-0000000000bb";
const SAM = "00000000-0000-4000-8000-0000000000cc";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const none = { id: ID, notes: "", notesRevision: 0, notesUpdatedBy: null, notesUpdatedAt: null };
const some = { id: ID, notes: "Launch call Tuesday.\nKeep it short.", notesRevision: 3, notesUpdatedBy: SAM, notesUpdatedAt: "2026-11-10T15:00:00.000Z" };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const members = () => vi.spyOn(api, "GET").mockImplementation((() => reply(200, { members: [{ userId: SAM, name: "Sam Lee", email: "sam@acme.test", role: "marketer" }] })) as never);

test("an editor adds notes: they save over the revision read and show as theirs", async () => {
  members();
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { revision: 1 })) as never);
  render(withQueries(<CampaignNotes workspaceId={W} campaign={none} edit />));
  expect(screen.getByText(/Context, feedback or meeting notes/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Add notes" }));
  expect((screen.getByRole("button", { name: "Save notes" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.type(screen.getByRole("textbox", { name: /Notes/ }), "  Ask Sam about pricing  ");
  await userEvent.click(screen.getByRole("button", { name: "Save notes" }));
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/campaigns/{id}/notes", { params: { path: { workspaceId: W, id: ID } }, body: { notes: "  Ask Sam about pricing  ", revision: 0 } });
  expect(await screen.findByText("Ask Sam about pricing")).toBeTruthy();
  expect(screen.getByText("Edited by you, just now")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
});

test("notes show who edited them; a stale save says so and keeps what was typed; Cancel puts them back", async () => {
  members();
  vi.spyOn(api, "PUT").mockImplementation((() => reply(409, { error: "revision_moved" })) as never);
  render(withQueries(<CampaignNotes workspaceId={W} campaign={some} edit />));
  expect(screen.getByText(/Launch call Tuesday\./)).toBeTruthy();
  expect(await screen.findByText(/^Edited by Sam Lee, /)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const box = screen.getByRole("textbox", { name: /Notes/ });
  await userEvent.type(box, " Moved to Wednesday.");
  await userEvent.click(screen.getByRole("button", { name: "Save notes" }));
  expect(await screen.findByText("Someone saved these notes while you were editing. Reload the page.")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: /Notes/ }) as HTMLTextAreaElement).value).toBe("Launch call Tuesday.\nKeep it short. Moved to Wednesday.");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByText(/Moved to Wednesday/)).toBeNull();
});

test("a viewer reads notes without an Edit, and sees nothing when there are none", () => {
  members();
  render(withQueries(<CampaignNotes workspaceId={W} campaign={some} edit={false} />));
  expect(screen.getByText(/Launch call Tuesday\./)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  cleanup();
  render(withQueries(<CampaignNotes workspaceId={W} campaign={none} edit={false} />));
  expect(screen.queryByRole("heading", { name: "Notes" })).toBeNull();
});
