// SPDX-License-Identifier: AGPL-3.0-only
// Deleting a Workspace from Settings: only an Owner sees it, the dialog says what happens before anything
// does, the Workspace's name must be typed to confirm, a stale sign-in asks for a fresh one, and a refusal
// says so.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { openDialog, withQueries } from "../testing";
import { DELETE_SAYS, DeleteWorkspace } from "./DeleteWorkspace";
import { Overview } from "./Overview";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function show() {
  const onStepUp = vi.fn();
  const onDeleted = vi.fn();
  render(withQueries(<DeleteWorkspace workspaceId={W} name="Shop" onStepUp={onStepUp} onDeleted={onDeleted} />));
  return { onStepUp, onDeleted };
}

async function openAndType(name: string) {
  await userEvent.click(screen.getByRole("button", { name: "Delete Workspace" }));
  const dialog = within(openDialog("Delete Shop?")!);
  await userEvent.type(dialog.getByLabelText("Type Shop to confirm"), name);
  return dialog;
}

test("the dialog says what happens, and deletes only once the Workspace's name is typed", async () => {
  const del = vi.spyOn(api, "DELETE").mockImplementation((() => reply(200, { ok: true })) as never);
  const { onDeleted, onStepUp } = show();
  expect(screen.getByRole("heading", { name: "Delete this Workspace" })).toBeTruthy();
  expect(screen.getByText("Stops all sending and closes it for every member. Owners can export its data until it is purged.")).toBeTruthy();
  const dialog = await openAndType("Sho");
  expect(DELETE_SAYS).toEqual([
    "Sending stops now. Anything not yet sent is cancelled.",
    "Members lose access now. Owners can still export its data until it is purged, no sooner than 30 days from now.",
    "After the purge, Direx keeps no record of what was sent or of consent. Keep your export for at least 6 years.",
  ]);
  for (const line of DELETE_SAYS) expect(dialog.getByText(line)).toBeTruthy();
  const confirm = dialog.getByRole("button", { name: "Delete Workspace" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  expect(del).not.toHaveBeenCalled();

  await userEvent.type(dialog.getByLabelText("Type Shop to confirm"), "p");
  expect(confirm.disabled).toBe(false);
  await userEvent.click(confirm);
  expect(del).toHaveBeenCalledWith("/api/w/{workspaceId}", { params: { path: { workspaceId: W } } });
  expect(onDeleted).toHaveBeenCalledOnce();
  expect(onStepUp).not.toHaveBeenCalled();
});

test("Cancel closes the dialog, deletes nothing and forgets what was typed", async () => {
  const del = vi.spyOn(api, "DELETE");
  show();
  const dialog = await openAndType("Shop");
  await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  expect(openDialog("Delete Shop?")).toBeNull();
  expect(del).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Delete Workspace" }));
  expect((within(openDialog("Delete Shop?")!).getByLabelText("Type Shop to confirm") as HTMLInputElement).value).toBe("");
});

test("a stale sign-in asks for a fresh one, and a refusal says the delete did not happen", async () => {
  vi.spyOn(api, "DELETE").mockImplementation((() => reply(403, { error: "step_up_required" })) as never);
  const { onStepUp, onDeleted } = show();
  let dialog = await openAndType("Shop");
  await userEvent.click(dialog.getByRole("button", { name: "Delete Workspace" }));
  expect(onStepUp).toHaveBeenCalledOnce();
  expect(onDeleted).not.toHaveBeenCalled();
  cleanup();

  vi.spyOn(api, "DELETE").mockImplementation((() => reply(403, { error: "forbidden" })) as never);
  const second = show();
  dialog = await openAndType("Shop");
  await userEvent.click(dialog.getByRole("button", { name: "Delete Workspace" }));
  expect(await dialog.findByText("The Workspace could not be deleted. Try again.")).toBeTruthy();
  expect(second.onDeleted).not.toHaveBeenCalled();
});

test("on the Overview only an Owner can delete, and a stale sign-in there shows the step-up sign-in", async () => {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => (path === "/api/exports/{workspaceId}" ? reply(200, { exports: [] }) : reply(404, { error: "not_found" }))) as never);
  vi.spyOn(api, "DELETE").mockImplementation((() => reply(403, { error: "step_up_required" })) as never);
  const ws = (role: "owner" | "admin") => ({ id: W, name: "Shop", role, organization: { id: "o", name: "Acme" } });
  render(withQueries(<Overview workspace={ws("admin")} me="u1" />));
  expect(screen.queryByRole("heading", { name: "Delete this Workspace" })).toBeNull();
  cleanup();
  render(withQueries(<Overview workspace={ws("owner")} me="u1" />));
  expect(screen.getByRole("heading", { name: "Delete this Workspace" })).toBeTruthy();
  const dialog = await openAndType("Shop");
  await userEvent.click(dialog.getByRole("button", { name: "Delete Workspace" }));
  expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeTruthy();
  expect(screen.getByText("Deleting a Workspace needs a recent sign-in. Sign in again, then delete it again.")).toBeTruthy();
});
