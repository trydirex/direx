// SPDX-License-Identifier: AGPL-3.0-only
// External tokens in Settings: every role sees the list and revokes; only Owners and Admins get the
// form, whose personal readers start unchecked; a new token shows once; a stale sign-in asks again.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { toast } from "@/components/toast";
import { withQueries } from "../testing";
import { Tokens } from "./Tokens";

const W = "00000000-0000-4000-8000-0000000000aa";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const NEW = `dxt_${"x".repeat(43)}`;
const choices = {
  lifetimes: [7, 30, 90],
  readers: [
    { name: "read_changes", personal: false },
    { name: "read_needs_you", personal: true },
    { name: "read_schedule", personal: true },
    { name: "read_campaign", personal: false },
  ],
  kinds: ["fact_proposal", "draft"],
};
const token = (o: Record<string, unknown>) => ({ readers: ["read_changes"], kinds: [], createdBy: "u2", createdAt: "2026-11-01T10:00:00.000Z", expiresAt: "2026-12-01T10:00:00.000Z", revokedBy: null, revokedAt: null, lastUsedAt: null, state: "live", ...o });
const tokens = [
  token({ id: "t1", name: "Zapier", hint: "AbCd" }),
  token({ id: "t2", name: "Old script", hint: "WxYz", state: "stopped", createdBy: "gone" }),
  token({ id: "t3", name: "n8n", hint: "QrSt", state: "revoked", revokedBy: "u2", revokedAt: "2026-11-05T10:00:00.000Z" }),
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(post: () => ReturnType<typeof reply> = () => reply(200, { id: "t9", token: NEW, expiresAt: "2026-12-17T10:00:00.000Z" })) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/external-tokens") return reply(200, { tokens, choices });
    if (path === "/api/w/{workspaceId}/members") return reply(200, { members: [{ userId: "u2", email: "sam@example.com", name: "Sam", role: "admin", createdAt: "2026-10-01T10:00:00.000Z" }] });
    return reply(404, { error: "not_found" });
  }) as never);
  return { post: vi.spyOn(api, "POST").mockImplementation(post as never), del: vi.spyOn(api, "DELETE").mockImplementation((() => reply(200, { ok: true })) as never) };
}

test("a Viewer sees every token with who made it and revokes one in a click, with no form to make one", async () => {
  const { del } = serve();
  const added = vi.spyOn(toast, "add");
  render(withQueries(<Tokens workspaceId={W} role="viewer" me="u1" />));
  const list = within(await screen.findByRole("region", { name: "Tokens" }));
  expect(await list.findByText("dxt_AbCd…")).toBeTruthy();
  expect(list.getAllByText(/Made by sam@example\.com on/)).toHaveLength(2);
  expect(list.getByText(/Made by a former member on/)).toBeTruthy();
  expect(list.getByText("Stopped: its maker is no longer an Owner or Admin")).toBeTruthy();
  // A revoked token can't be revoked again; a live or stopped one can.
  expect(list.queryByRole("button", { name: "Revoke n8n" })).toBeNull();
  expect(list.getByRole("button", { name: "Revoke Old script" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Make a token" })).toBeNull();
  expect(screen.getByText("Only Owners and Admins can make a token.")).toBeTruthy();

  await userEvent.click(list.getByRole("button", { name: "Revoke Zapier" }));
  expect(del).toHaveBeenCalledWith("/api/w/{workspaceId}/external-tokens/{tokenId}", { params: { path: { workspaceId: W, tokenId: "t1" } } });
  expect(added).toHaveBeenCalledWith({ title: "Revoked Zapier. It stops working now." });
});

test("an Owner makes a token: personal readers start unchecked, and the token shows once", async () => {
  const { post } = serve();
  render(withQueries(<Tokens workspaceId={W} role="owner" me="u1" />));
  const form = within(await screen.findByRole("region", { name: "Make a token" }));
  const box = (name: RegExp) => form.getByRole("checkbox", { name }) as HTMLInputElement;
  expect([/^State changes/, /^Needs you/, /^Calendar/, /^Campaigns/, /^Brand facts/, /^Social posts/].map((n) => box(n).checked)).toEqual([true, false, false, true, false, false]);
  expect(form.getAllByRole("option").map((o) => o.textContent)).toEqual(["7 days", "30 days", "90 days"]);

  await userEvent.type(form.getByRole("textbox", { name: /Name/ }), "Zapier");
  await userEvent.click(box(/^Social posts/));
  await userEvent.click(form.getByRole("button", { name: "Make token" }));
  expect(post).toHaveBeenCalledWith("/api/w/{workspaceId}/external-tokens", { params: { path: { workspaceId: W } }, body: { name: "Zapier", days: 30, readers: ["read_changes", "read_campaign"], kinds: ["draft"] } });
  const shown = within(await screen.findByRole("region", { name: "Your new token" }));
  expect(shown.getByText(NEW)).toBeTruthy();
  expect(screen.getByText("Copy it now. You won't see this again.")).toBeTruthy();
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  await userEvent.click(shown.getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenCalledWith(NEW);
  expect(await shown.findByRole("button", { name: "Copied" })).toBeTruthy();
  await userEvent.click(shown.getByRole("button", { name: "Hide it" }));
  expect(screen.queryByText(NEW)).toBeNull();

  // Leaving and coming back: the list has only hints, and the token is nowhere.
  cleanup();
  render(withQueries(<Tokens workspaceId={W} role="owner" me="u1" />));
  expect(await screen.findByText("dxt_AbCd…")).toBeTruthy();
  expect(screen.queryByText(NEW)).toBeNull();
});

test("an Owner whose sign-in is too old is asked to sign in again, and a refusal says why", async () => {
  serve(() => reply(400, { error: "bad_lifetime" }));
  render(withQueries(<Tokens workspaceId={W} role="admin" me="u1" />));
  const form = within(await screen.findByRole("region", { name: "Make a token" }));
  await userEvent.type(form.getByRole("textbox", { name: /Name/ }), "Script");
  await userEvent.click(form.getByRole("button", { name: "Make token" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Pick one of the lifetimes offered.");

  cleanup();
  vi.restoreAllMocks();
  serve(() => reply(403, { error: "step_up_required" }));
  render(withQueries(<Tokens workspaceId={W} role="owner" me="u1" />));
  const again = within(await screen.findByRole("region", { name: "Make a token" }));
  await userEvent.type(again.getByRole("textbox", { name: /Name/ }), "Script");
  await userEvent.click(again.getByRole("button", { name: "Make token" }));
  expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeTruthy();
});


test("a second token starts with Copy even when the previous token was copied and left visible", async () => {
  const second = `dxt_${"y".repeat(43)}`;
  let made = 0;
  serve(() => reply(200, { token: made++ === 0 ? NEW : second }));
  render(withQueries(<Tokens workspaceId={W} role="owner" me="u1" />));
  const form = within(await screen.findByRole("region", { name: "Make a token" }));
  await userEvent.type(form.getByRole("textbox", { name: /Name/ }), "First");
  await userEvent.click(form.getByRole("button", { name: "Make token" }));
  const writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await userEvent.click(await screen.findByRole("button", { name: "Copy" }));
  expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  expect(writeText).toHaveBeenLastCalledWith(NEW);
  await userEvent.type(form.getByRole("textbox", { name: /Name/ }), "Second");
  await userEvent.click(form.getByRole("button", { name: "Make token" }));
  expect(await screen.findByText(second)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(writeText).toHaveBeenLastCalledWith(second);
  await userEvent.click(screen.getByRole("button", { name: "Hide it" }));
  expect(screen.queryByText(second)).toBeNull();
});

test.each([403, 500, "network"] as const)("a failed revocation (%s) reports an error and permits a retry", async (failure) => {
  const { del } = serve();
  del.mockImplementationOnce((() => failure === "network" ? Promise.reject(new TypeError("offline")) : reply(failure, { error: "failed" })) as never);
  const added = vi.spyOn(toast, "add");
  render(withQueries(<Tokens workspaceId={W} role="viewer" me="u1" />));
  const button = await screen.findByRole("button", { name: "Revoke Zapier" });
  const get = vi.mocked(api.GET);
  const reads = get.mock.calls.length;
  await userEvent.click(button);
  expect((await screen.findByRole("alert")).textContent).toBe("Could not revoke Zapier. Try again.");
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(added).not.toHaveBeenCalled();
  expect(get.mock.calls.length).toBe(reads);
  await userEvent.click(button);
  await waitFor(() => expect(added).toHaveBeenCalledWith({ title: "Revoked Zapier. It stops working now." }));
  expect(del).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
  await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(reads));
});

test("a lost creation response refreshes the list without replaying creation and permits recovery", async () => {
  const { post } = serve();
  post.mockRejectedValueOnce(new TypeError("connection lost"));
  render(withQueries(<Tokens workspaceId={W} role="owner" me="u1" />));
  const form = within(await screen.findByRole("region", { name: "Make a token" }));
  const get = vi.mocked(api.GET);
  const reads = () => get.mock.calls.filter((call) => call[0] === "/api/w/{workspaceId}/external-tokens").length;
  const before = reads();
  await userEvent.type(form.getByRole("textbox", { name: /Name/ }), "Script");
  await userEvent.click(form.getByRole("button", { name: "Make token" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Check the token list before trying again");
  expect(reads()).toBeGreaterThan(before);
  expect(post).toHaveBeenCalledTimes(1);
  expect((form.getByRole("button", { name: "Make token" }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByRole("region", { name: "Your new token" })).toBeNull();
  await userEvent.click(form.getByRole("button", { name: "Make token" }));
  expect(await screen.findByText(NEW)).toBeTruthy();
  expect(post).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});
