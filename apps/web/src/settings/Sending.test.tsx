// SPDX-License-Identifier: AGPL-3.0-only
// Who is sending, in Settings: the sender identity saves, a viewer only reads it, and an Admin makes the CRM webhook.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { Sending } from "./Sending";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const overview = { senderName: "Sam", postalAddress: "1 Main St", senderCountry: "US", paused: false, people: [] };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(o: { code?: string; hook?: unknown } = {}) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/outreach") return reply(200, overview);
    if (path === "/api/w/{workspaceId}/outreach/hold-hook") return reply(200, { hook: o.hook ?? null });
    return reply(404, { error: "not_found" });
  }) as never);
  const put = vi.spyOn(api, "PUT").mockImplementation((() => (o.code ? reply(400, { error: o.code }) : reply(200, {}))) as never);
  vi.spyOn(api, "POST").mockImplementation(((path: string) =>
    o.code ? reply(400, { error: o.code }) : path.endsWith("/hold-hook") ? reply(200, { id: "h1", path: "/api/hooks/holds/x", secret: "s3cr3t" }) : reply(200, {})) as never);
  return put;
}

test("an Admin saves who is sending; a refusal is an alert", async () => {
  const put = serve();
  render(withQueries(<Sending workspaceId={W} role="admin" />));
  expect(screen.getByRole("heading", { level: 1, name: "Who is sending" })).toBeTruthy();
  const sender = within(await screen.findByRole("region", { name: "Sender" }));
  expect((await sender.findAllByDisplayValue("1 Main St")).length).toBeGreaterThan(0);
  await userEvent.click(await sender.findByRole("button", { name: "Save" }));
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/identity", { params: { path: { workspaceId: W } }, body: { senderName: "Sam", postalAddress: "1 Main St", senderCountry: "US" } });
  expect(await screen.findByText("Saved.")).toBeTruthy();
  cleanup();
  vi.restoreAllMocks();
  serve({ code: "bad_email" });
  render(withQueries(<Sending workspaceId={W} role="owner" />));
  await userEvent.click(await within(await screen.findByRole("region", { name: "Sender" })).findByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe("That isn't an email address.");
});

test("a Viewer, Marketer or Contributor reads who is sending and can't change it, as the API allows only Owners and Admins", async () => {
  for (const role of ["viewer", "marketer", "contributor"] as const) {
    serve();
    render(withQueries(<Sending workspaceId={W} role={role} />));
    const sender = within(await screen.findByRole("region", { name: "Sender" }));
    expect(await sender.findByText("Sam")).toBeTruthy();
    expect(sender.getByText("1 Main St")).toBeTruthy();
    expect(sender.queryByRole("button", { name: "Save" })).toBeNull();
    // Nor is the CRM webhook theirs to make.
    expect(screen.queryByRole("region", { name: "Deals in another CRM" })).toBeNull();
    cleanup();
    vi.restoreAllMocks();
  }
});

test("with no sender yet, someone who can't add it is told who can", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { ...overview, senderName: null, postalAddress: null })) as never);
  render(withQueries(<Sending workspaceId={W} role="marketer" />));
  expect(await screen.findByText("Not added yet. Emails can't go out until an Owner or Admin adds it.")).toBeTruthy();
});

test("the hold hook: an Admin makes a webhook and sees its secret once", async () => {
  serve();
  render(withQueries(<Sending workspaceId={W} role="admin" />));
  const hook = await screen.findByRole("region", { name: "Deals in another CRM" });
  expect(document.getElementById("hold-hook")?.contains(hook)).toBe(true);
  await userEvent.click(await within(hook).findByRole("button", { name: "Make a webhook" }));
  expect(await within(hook).findByText("s3cr3t")).toBeTruthy();
  expect(within(hook).getByText(/\/api\/hooks\/holds\/x/)).toBeTruthy();
  expect(within(hook).getByRole("button", { name: "New secret" })).toBeTruthy();
  expect(within(hook).getByText("Setup for Zapier or Make").closest("details")!.open).toBe(false);
});

test("a refused new secret says to confirm it's you", async () => {
  serve({ code: "step_up_required", hook: { id: "h1", path: "/api/hooks/holds/x", createdAt: "2026-11-08T00:00:00.000Z" } });
  render(withQueries(<Sending workspaceId={W} role="admin" />));
  const hook = await screen.findByRole("region", { name: "Deals in another CRM" });
  await userEvent.click(await within(hook).findByRole("button", { name: "New secret" }));
  expect((await within(hook).findByRole("alert")).textContent).toBe("Confirm it's you: sign in again, then try once more.");
});
