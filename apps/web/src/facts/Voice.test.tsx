// SPDX-License-Identifier: AGPL-3.0-only
// Brand's Voice section: examples and swaps as read, pasting closed until the check has passed its eval,
// saving and retiring by someone who may approve, and refusals in words.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { Voice } from "./Voice";

const W = "00000000-0000-4000-8000-0000000000aa";
const at = "2026-11-11T09:00:00.000Z";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const example = { id: "00000000-0000-4000-8000-000000000001", kind: "example" as const, text: "We bake at dawn.\nYou eat by nine.", prefer: null, source: "person" as const, at };
const swap = { id: "00000000-0000-4000-8000-000000000002", kind: "swap" as const, text: "users", prefer: "customers", source: "person" as const, at };
const at_ = { params: { path: { workspaceId: W } } };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(o: { pasteOpen: boolean; post?: () => Promise<unknown> }) {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { entries: [example, swap], pasteOpen: o.pasteOpen })) as never);
  return vi.spyOn(api, "POST").mockImplementation((o.post ?? (() => reply(200, { id: "00000000-0000-4000-8000-000000000003" }))) as never);
}

test("Voice shows its examples and swaps; pasting is closed until the check has passed, and says so", async () => {
  serve({ pasteOpen: false });
  render(withQueries(<Voice workspaceId={W} role="owner" />));
  const like = within(await screen.findByRole("region", { name: "Sounds like us" }));
  expect(like.getByText(/We bake at dawn\./)).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Say this, not that" })).getByText(/not users/).textContent).toBe("Say customers, not users");
  expect(like.getByText("Pasting examples is coming soon. Use 'Say this, not that' for now.")).toBeTruthy();
  expect(like.queryByRole("button", { name: "Add example" })).toBeNull();
});

test("someone who may approve pastes an example and adds a swap; a refusal says what to change", async () => {
  const post = serve({ pasteOpen: true });
  render(withQueries(<Voice workspaceId={W} role="marketer" />));
  const like = within(await screen.findByRole("region", { name: "Sounds like us" }));
  await userEvent.type(like.getByRole("textbox", { name: "Paste a passage that sounds like you" }), "Most bakeries lose a morning a week.");
  await userEvent.click(like.getByRole("button", { name: "Add example" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/voice/examples", { ...at_, body: { text: "Most bakeries lose a morning a week." } });
  expect(await screen.findByText("Example added.")).toBeTruthy();
  post.mockImplementationOnce((() => reply(409, { error: "voice_check_no_model" })) as never);
  await userEvent.type(like.getByRole("textbox", { name: "Paste a passage that sounds like you" }), "We bake at dawn.");
  await userEvent.click(like.getByRole("button", { name: "Add example" }));
  expect(await screen.findByText("Direx checks each example with Claude Code first. Sign in to Claude Code under Settings, AI models, then add it again.")).toBeTruthy();
  const swaps = within(screen.getByRole("region", { name: "Say this, not that" }));
  post.mockImplementation((() => reply(409, { error: "voice_swap_exists" })) as never);
  await userEvent.type(swaps.getByRole("textbox", { name: "Instead of" }), "users");
  await userEvent.type(swaps.getByRole("textbox", { name: "Say" }), "clients");
  await userEvent.click(swaps.getByRole("button", { name: "Add swap" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/voice/swaps", { ...at_, body: { avoid: "users", prefer: "clients" } });
  expect(await screen.findByText("That word already has a swap.")).toBeTruthy();
});

test("retiring asks first; a viewer reads Voice but can't change it", async () => {
  const post = serve({ pasteOpen: true });
  render(withQueries(<Voice workspaceId={W} role="owner" />));
  await userEvent.click(await screen.findByRole("button", { name: "Remove the swap for users" }));
  await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/voice/{id}/retire", { params: { path: { workspaceId: W, id: swap.id } } });
  cleanup();
  serve({ pasteOpen: true });
  render(withQueries(<Voice workspaceId={W} role="viewer" />));
  expect(await screen.findByText(/We bake at dawn\./)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Remove|Add example|Add swap/ })).toBeNull();
});
