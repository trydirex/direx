// SPDX-License-Identifier: AGPL-3.0-only
// A Mailbox's pause on its card: why it's paused, Resume only for someone who approves, and Pause by hand.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { MailboxPause } from "./MailboxPause";

const W = "00000000-0000-4000-8000-0000000000aa";
const M = "00000000-0000-4000-8000-0000000000c1";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const paused = (reason: string) => ({ pauses: [{ credentialId: M, pausedAt: "2026-11-16T09:00:00Z", reason }] });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("a Mailbox its bounces paused says why, and Resume sends what it held", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, paused("bounces"))) as never);
  const put = vi.spyOn(api, "PUT").mockImplementationOnce((() => reply(500, { error: "boom" })) as never).mockImplementationOnce((() => reply(200, { ok: true })) as never);
  render(withQueries(<MailboxPause workspaceId={W} credentialId={M} name="me@acme.test" mayPause mayResume />));
  expect(await screen.findByText(/^Paused because 3 of its latest emails bounced\. Nothing goes from it until someone resumes it/)).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Resume sending: me@acme.test" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "That didn't save. Try again.");
  await userEvent.click(screen.getByRole("button", { name: "Resume sending: me@acme.test" }));
  expect(put).toHaveBeenLastCalledWith("/api/w/{workspaceId}/outreach/mailboxes/{credentialId}/pause", { params: { path: { workspaceId: W, credentialId: M } }, body: { paused: false } });
  expect(screen.queryByRole("alert")).toBeNull();
});

test("someone who can't approve sees the pause but no Resume, and a viewer sees no Pause", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, paused("person"))) as never);
  render(withQueries(<MailboxPause workspaceId={W} credentialId={M} name="me@acme.test" mayPause mayResume={false} />));
  expect(await screen.findByText(/^Paused by hand\. Nothing goes from it until someone resumes it\.$/)).toBeTruthy();
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { pauses: [] })) as never);
  const { container } = render(withQueries(<MailboxPause workspaceId={W} credentialId={M} name="me@acme.test" mayPause={false} mayResume={false} />));
  await Promise.resolve();
  expect(container.textContent).toBe("");
});

test("a sending Mailbox offers Pause, which saves", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { pauses: [] })) as never);
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { ok: true })) as never);
  render(withQueries(<MailboxPause workspaceId={W} credentialId={M} name="me@acme.test" mayPause mayResume={false} />));
  await userEvent.click(await screen.findByRole("button", { name: "Pause sending: me@acme.test" }));
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/mailboxes/{credentialId}/pause", { params: { path: { workspaceId: W, credentialId: M } }, body: { paused: true } });
});
