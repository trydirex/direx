// SPDX-License-Identifier: AGPL-3.0-only
// The invite page names the Workspace and its sender, or says why the invite can't be used; and the
// bootstrap page makes the signed-in person Server admin, or says the link can't be used.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { AcceptInvite, ClaimServer } from "./AcceptInvite";

const TOKEN = "a".repeat(64);
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("claiming sends the link's token and moves on", async () => {
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(200, { ok: true })) as never);
  const onClaimed = vi.fn();
  render(<ClaimServer token={TOKEN} onClaimed={onClaimed} />);
  await userEvent.click(screen.getByRole("button", { name: "Become Server admin" }));
  await vi.waitFor(() => expect(onClaimed).toHaveBeenCalled());
  expect(post).toHaveBeenCalledWith("/api/server/claim", { body: { token: TOKEN } });
});

test("with no token in the URL, claiming leaves it to the held cookie, and says to reopen the link when none is held", async () => {
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(409, { error: "link_needed" })) as never);
  render(<ClaimServer onClaimed={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Become Server admin" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Open the setup link again in this browser to claim this server.");
  expect(post).toHaveBeenCalledWith("/api/server/claim", { body: {} });
});

test("an expired or used link says so and asks for a new one", async () => {
  vi.spyOn(api, "POST").mockImplementation((() => reply(409, { error: "link_unusable" })) as never);
  const onClaimed = vi.fn();
  render(<ClaimServer token={TOKEN} onClaimed={onClaimed} />);
  await userEvent.click(screen.getByRole("button", { name: "Become Server admin" }));
  expect((await screen.findByRole("alert")).textContent).toBe("This link has expired or has already been used. Ask whoever runs this server for a new one.");
  expect(onClaimed).not.toHaveBeenCalled();
});

const W = "00000000-0000-4000-8000-0000000000aa";
const invitePage = (preview: Promise<unknown>) => {
  const post = vi.spyOn(api, "POST").mockImplementation(((path: string) => (path === "/api/invites/preview" ? preview : reply(200, { workspace: { id: W, role: "marketer" } }))) as never);
  const onJoined = vi.fn();
  render(withQueries(<AcceptInvite workspaceId={W} token={TOKEN} onJoined={onJoined} />));
  return { post, onJoined };
};

test("the invite page names who invited you and to which Workspace, and Accept joins it", async () => {
  const { post, onJoined } = invitePage(reply(200, { workspace: { name: "Acme Rota" }, invitedBy: "Ana" }));
  expect(await screen.findByRole("heading", { name: "Ana invited you to Acme Rota" })).toBeTruthy();
  expect(post).toHaveBeenCalledWith("/api/invites/preview", { body: { workspaceId: W, token: TOKEN } });
  await userEvent.click(screen.getByRole("button", { name: "Accept invite" }));
  await vi.waitFor(() => expect(onJoined).toHaveBeenCalled());
});

test("an invite that can't be used says why, with no Accept to press", async () => {
  for (const [code, text] of [
    ["not_found", "This invite link doesn't work. Check that you copied all of it, or ask for a new one."],
    ["expired", "This invite has expired. Ask for a new one."],
  ]) {
    invitePage(reply(code === "not_found" ? 404 : 409, { error: code }));
    expect((await screen.findByRole("alert")).textContent).toBe(text);
    expect(screen.queryByRole("button", { name: "Accept invite" })).toBeNull();
    cleanup();
    vi.restoreAllMocks();
  }
});

test("a link with a cut-short or mistyped token says the link isn't valid, on the invite and the bootstrap page", async () => {
  const BAD = "This link isn't valid. Check that you copied all of it, or ask for a new one.";
  invitePage(reply(400, { error: "token: Invalid string: must match pattern /^[0-9a-f]{64}$/" }));
  expect((await screen.findByRole("alert")).textContent).toBe(BAD);
  cleanup();
  vi.restoreAllMocks();
  vi.spyOn(api, "POST").mockImplementation((() => reply(400, { error: "token: Invalid string" })) as never);
  render(<ClaimServer token="abc" onClaimed={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "Become Server admin" }));
  expect((await screen.findByRole("alert")).textContent).toBe(BAD);
});

test("if the invite can't be looked up, the page still offers Accept", async () => {
  invitePage(Promise.reject(new Error("offline")));
  expect(await screen.findByRole("heading", { name: "Join a Workspace" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Accept invite" })).toBeTruthy();
});
