// SPDX-License-Identifier: AGPL-3.0-only
// The join form shows only to the person whose yes placement runs under, sends the four values, and
// says a refusal in words.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { PlacementJoin } from "./PlacementJoin";

const W = "00000000-0000-4000-8000-0000000000aa";
const M = "00000000-0000-4000-8000-0000000000c1";
const ME = "00000000-0000-4000-8000-0000000000d1";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const state = (status: string, answeredBy = ME) => ({ address: "me@acme.test", status, wordingVersion: "2026-11-10", wording: "", mayAnswer: true, grant: { answeredBy } });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("the granter fills in both parts and the part 1 email, and a refusal is said in words", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, state("on"))) as never);
  const post = vi.spyOn(api, "POST").mockImplementationOnce((() => reply(409, { error: "not_granted" })) as never).mockImplementationOnce((() => reply(200, { actionId: M })) as never);
  render(withQueries(<PlacementJoin workspaceId={W} credentialId={M} name="me@acme.test" me={ME} />));
  await userEvent.click(await screen.findByRole("button", { name: "Join the Placement circle: me@acme.test" }));
  await userEvent.type(screen.getByLabelText("Part 1, from the email"), "p1");
  await userEvent.type(screen.getByLabelText("Part 2, from the signer"), "p2");
  await userEvent.type(screen.getByLabelText("The email's Message ID"), "<id@mail.gmail.com>");
  await userEvent.type(screen.getByLabelText("The address it came from"), "signer@circle.test");
  await userEvent.click(screen.getByRole("button", { name: "Send the join reply" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "This email account has no live yes to Placement checks, so it can't join.");
  await userEvent.click(screen.getByRole("button", { name: "Send the join reply" }));
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/mailboxes/{credentialId}/placement/join", { params: { path: { workspaceId: W, credentialId: M } }, body: { part1: "p1", part2: "p2", signer: "signer@circle.test", messageId: "<id@mail.gmail.com>" } });
  expect(await screen.findByText(/The join reply is on its way/)).toBeTruthy();
});

test("nothing shows for someone else's yes, for a Mailbox not on, or where placement isn't available", async () => {
  for (const r of [reply(200, state("on", "someone-else")), reply(200, state("unanswered")), reply(404, { error: "not_available" })]) {
    vi.spyOn(api, "GET").mockImplementation((() => r) as never);
    const { container } = render(withQueries(<PlacementJoin workspaceId={W} credentialId={M} name="me@acme.test" me={ME} />));
    await new Promise((done) => setTimeout(done, 20));
    expect(container.textContent).toBe("");
    cleanup();
    vi.restoreAllMocks();
  }
});
