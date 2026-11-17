// SPDX-License-Identifier: AGPL-3.0-only
// Members loads through the query layer: a loading state first, then the members, and an error
// panel with Retry when they can't be read.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { toast } from "@/components/toast";
import { listFor, withQueries, pick } from "../testing";
import { Members, ROLE_DOES } from "./Members";

const W = "00000000-0000-4000-8000-0000000000aa";
const workspace = { id: W, name: "Shop", role: "owner" as const, organization: { id: "o1", name: "Acme" } };
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function serve(members: () => Promise<unknown>) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/members") return members();
    if (path === "/api/w/{workspaceId}/invites") return reply(200, { invites: [{ id: "i1", email: "new@example.com", role: "viewer" }] });
    return reply(404, { error: "not_found" });
  }) as never);
}

test("Members shows a loading state, then the members and waiting invites", async () => {
  serve(() => reply(200, { members: [{ userId: "u1", name: "Sam", email: "sam@example.com", role: "admin" }] }));
  render(withQueries(<Members workspace={workspace} />));
  expect(screen.getAllByRole("status").some((s) => s.textContent === "Loading")).toBe(true);
  expect(await screen.findByText("sam@example.com")).toBeTruthy();
  expect(screen.getByRole("combobox", { name: "Role of Sam" })).toBeTruthy();
  expect(await screen.findByText("new@example.com as Viewer")).toBeTruthy();
});

test("when the members can't be read, Members says so and Retry reads them again", async () => {
  let fail = true;
  serve(() => (fail ? reply(403, { error: "forbidden" }) : reply(200, { members: [{ userId: "u1", name: "", email: "sam@example.com", role: "viewer" }] })));
  render(withQueries(<Members workspace={workspace} />));
  expect((await screen.findByRole("alert")).textContent).toContain("Your role in this Workspace can't do that.");
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findAllByText("sam@example.com")).toHaveLength(1);
  expect(screen.getByText("No name yet")).toBeTruthy();
});

const sam = { userId: "u1", name: "Sam", email: "sam@example.com", role: "admin" as const };

/** Members and invites always answer; each write answers with `write`. */
function serveWrites(write: (method: string, path: string, init: unknown) => Promise<unknown>) {
  serve(() => reply(200, { members: [sam] }));
  const spies = Object.fromEntries(
    (["POST", "PATCH", "DELETE"] as const).map((m) => [m, vi.spyOn(api, m).mockImplementation(((path: string, init: unknown) => write(m, path, init)) as never)]),
  );
  return spies as Record<"POST" | "PATCH" | "DELETE", ReturnType<typeof vi.spyOn>>;
}

test("changing a role sends it, and a refusal shows its message", async () => {
  const s = serveWrites(() => reply(409, { error: "last_owner" }));
  render(withQueries(<Members workspace={workspace} />));
  await pick(await screen.findByRole("combobox", { name: "Role of Sam" }), "Viewer");
  expect((await screen.findByRole("alert")).textContent).toContain("A Workspace needs at least one Owner.");
  expect(s.PATCH).toHaveBeenCalledWith("/api/w/{workspaceId}/members/{userId}", { params: { path: { workspaceId: W, userId: "u1" } }, body: { role: "viewer" } });
});

test("removing a member that needs a recent sign-in asks for one and keeps the change", async () => {
  const s = serveWrites(() => reply(403, { error: "step_up_required" }));
  render(withQueries(<Members workspace={workspace} />));
  await userEvent.click(await screen.findByRole("button", { name: "Remove Sam" }));
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
  expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeTruthy();
  expect(s.DELETE).toHaveBeenCalledWith("/api/w/{workspaceId}/members/{userId}", { params: { path: { workspaceId: W, userId: "u1" } } });
  expect(JSON.parse(sessionStorage.getItem("direx.pendingChange")!)).toEqual({ workspaceId: W, userId: "u1", role: null });
});

test("a change that waited for sign-in runs once when the page opens", async () => {
  sessionStorage.setItem("direx.pendingChange", JSON.stringify({ workspaceId: W, userId: "u1", role: "owner" }));
  const s = serveWrites(() => reply(200, { ok: true }));
  render(withQueries(<Members workspace={workspace} />));
  await vi.waitFor(() => expect(s.PATCH).toHaveBeenCalledTimes(1));
  expect(s.PATCH).toHaveBeenCalledWith("/api/w/{workspaceId}/members/{userId}", { params: { path: { workspaceId: W, userId: "u1" } }, body: { role: "owner" } });
  expect(sessionStorage.getItem("direx.pendingChange")).toBeNull();
  expect(await screen.findByText("sam@example.com")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("inviting someone sends the email and role, then clears the field and says so", async () => {
  const s = serveWrites(() => reply(201, { invite: { id: "i2" }, resent: false }));
  const add = vi.spyOn(toast, "add");
  render(withQueries(<Members workspace={workspace} />));
  const email = screen.getByLabelText("Email") as HTMLInputElement;
  await userEvent.type(email, "pat@example.com");
  await pick(screen.getByRole("combobox", { name: "Role" }), "Contributor");
  await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
  await vi.waitFor(() => expect(email.value).toBe(""));
  expect(s.POST).toHaveBeenCalledWith("/api/w/{workspaceId}/invites", { params: { path: { workspaceId: W } }, body: { email: "pat@example.com", role: "contributor" } });
  expect(add).toHaveBeenCalledWith({ title: "Invite sent to pat@example.com." });
});

test("inviting an email that already has an invite waiting says it went out again", async () => {
  serveWrites(() => reply(200, { invite: { id: "i1" }, resent: true }));
  const add = vi.spyOn(toast, "add");
  render(withQueries(<Members workspace={workspace} />));
  await userEvent.type(screen.getByLabelText("Email"), "New@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
  await vi.waitFor(() => expect(add).toHaveBeenCalledWith({ title: "New@example.com already had an invite waiting. We sent it again with a new link." }));
});

test("an invite to an existing member keeps the email and says why", async () => {
  serveWrites(() => reply(409, { error: "already_member" }));
  render(withQueries(<Members workspace={workspace} />));
  await userEvent.type(screen.getByLabelText("Email"), "sam@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Send invite" }));
  expect((await screen.findByRole("alert")).textContent).toContain("They're already a member of this Workspace.");
  expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe("sam@example.com");
});

test("withdrawing an invite deletes it", async () => {
  const s = serveWrites(() => reply(200, { ok: true }));
  render(withQueries(<Members workspace={workspace} />));
  await userEvent.click(await screen.findByRole("button", { name: "Withdraw the invite to new@example.com" }));
  await vi.waitFor(() => expect(s.DELETE).toHaveBeenCalledWith("/api/w/{workspaceId}/invites/{inviteId}", { params: { path: { workspaceId: W, inviteId: "i1" } } }));
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a Viewer sees roles as text, with nothing to change", async () => {
  serve(() => reply(200, { members: [sam] }));
  render(withQueries(<Members workspace={{ ...workspace, role: "viewer" }} />));
  expect(await screen.findByText("Admin")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Remove Sam" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Send invite" })).toBeNull();
});

test("a role change that worked offers Undo, which puts the old role back through the same call", async () => {
  const s = serveWrites(() => reply(200, { ok: true }));
  render(withQueries(<Members workspace={workspace} />));
  await pick(await screen.findByRole("combobox", { name: "Role of Sam" }), "Viewer");
  expect(await screen.findByText("Role changed to Viewer.")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  await vi.waitFor(() => expect(s.PATCH).toHaveBeenCalledTimes(2));
  expect(s.PATCH).toHaveBeenLastCalledWith("/api/w/{workspaceId}/members/{userId}", { params: { path: { workspaceId: W, userId: "u1" } }, body: { role: "admin" } });
});

test("your own row is read-only: no role picker and no Remove, so you can't demote or remove yourself", async () => {
  serve(() => reply(200, { members: [sam, { userId: "u2", name: "Ana", email: "ana@example.com", role: "owner" }] }));
  render(withQueries(<Members workspace={workspace} me="u2" />));
  expect(await screen.findByRole("combobox", { name: "Role of Sam" })).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Role of Ana" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove Ana" })).toBeNull();
  expect(screen.getByRole("button", { name: "Remove Sam" })).toBeTruthy();
  expect(screen.getByText("You")).toBeTruthy();
});

test("on a phone each member stacks into a grid whose cells may use the full width", async () => {
  serve(() => reply(200, { members: [sam] }));
  render(withQueries(<Members workspace={workspace} />));
  const row = (await screen.findByText("sam@example.com")).closest("tr")!;
  expect(row.className).toContain("max-sm:grid");
  expect(row.className).toContain("max-sm:[&>td]:max-w-none");
  expect(screen.getByRole("button", { name: "Remove Sam" }).closest("td")!.className).toContain("max-sm:row-start-1");
  expect(row.closest("table")!.querySelector("thead")!.className).toContain("max-sm:sr-only");
});

test("each role says what it can do, in the list and under the invite's role", async () => {
  serveWrites(() => reply(201, { id: "i2" }));
  render(withQueries(<Members workspace={workspace} />));
  expect(await screen.findByText(ROLE_DOES.admin)).toBeTruthy();
  expect(screen.getByText(ROLE_DOES.marketer)).toBeTruthy();
  await pick(screen.getByRole("combobox", { name: "Role" }), "Contributor");
  expect(await screen.findByText(ROLE_DOES.contributor)).toBeTruthy();
});

test("an Admin isn't offered Owner: not in the invite's roles, not on a member, and an Owner's row is read-only", async () => {
  serve(() => reply(200, { members: [sam, { userId: "u2", name: "Olive", email: "olive@example.com", role: "owner" }] }));
  render(withQueries(<Members workspace={{ ...workspace, role: "admin" }} />));
  expect(await screen.findByText("olive@example.com")).toBeTruthy();
  expect(screen.queryByRole("combobox", { name: "Role of Olive" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove Olive" })).toBeNull();
  for (const name of ["Role of Sam", "Role"]) {
    const list = listFor(screen.getByRole("combobox", { name }));
    expect(list.getByRole("option", { name: "Viewer" })).toBeTruthy();
    expect(list.queryByRole("option", { name: "Owner" })).toBeNull();
  }
});

test("making someone an Owner asks first, and only Make Owner sends it", async () => {
  const s = serveWrites(() => reply(200, { ok: true }));
  render(withQueries(<Members workspace={workspace} />));
  await pick(await screen.findByRole("combobox", { name: "Role of Sam" }), "Owner");
  expect(await screen.findByRole("heading", { name: "Make Sam an Owner?" })).toBeTruthy();
  expect(s.PATCH).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(s.PATCH).not.toHaveBeenCalled();
  await pick(screen.getByRole("combobox", { name: "Role of Sam" }), "Owner");
  await userEvent.click(await screen.findByRole("button", { name: "Make Owner" }));
  await vi.waitFor(() => expect(s.PATCH).toHaveBeenCalledWith("/api/w/{workspaceId}/members/{userId}", { params: { path: { workspaceId: W, userId: "u1" } }, body: { role: "owner" } }));
});
