// SPDX-License-Identifier: AGPL-3.0-only
// A Mailbox's sending domain on its card: set up, a shared provider's, or each problem with its fix.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { MailboxDomain } from "./MailboxDomain";

const W = "00000000-0000-4000-8000-0000000000aa";
const M = "00000000-0000-4000-8000-0000000000c1";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const GOOD = { domain: "acme.test", consumer: false, mx: "pass", spf: "pass", dkim: "pass", dmarc: "quarantine", authenticated: true };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("a domain with SPF, DKIM and DMARC says so, from the Mailbox's own report", async () => {
  const get = vi.spyOn(api, "GET").mockImplementation((() => reply(200, GOOD)) as never);
  render(withQueries(<MailboxDomain workspaceId={W} credentialId={M} />));
  expect(await screen.findByText("Sends from acme.test: SPF, DKIM and DMARC (quarantine) are set up, so receivers can check its mail is genuine.")).toBeTruthy();
  expect(get).toHaveBeenCalledWith("/api/w/{workspaceId}/outreach/mailboxes/{credentialId}/domain", { params: { path: { workspaceId: W, credentialId: M } } });
});

test("each problem says what to fix, and a lookup that failed says so", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { ...GOOD, mx: "missing", spf: "no_provider_include", dkim: "not_found", dmarc: "unknown", authenticated: false })) as never);
  render(withQueries(<MailboxDomain workspaceId={W} credentialId={M} />));
  expect(await screen.findByText(/^Sends from acme\.test\. Receivers can't yet check its mail is genuine/)).toBeTruthy();
  expect(screen.getAllByRole("listitem").map((l) => l.textContent)).toEqual([
    "It has no MX record, so it can't receive replies or bounces. Add the MX records your email provider gives you.",
    "Its SPF record doesn't include this account's email provider. Add the provider's include to it.",
    "No DKIM key was found. Turn on DKIM signing in your email provider's admin console.",
    "Couldn't read it from DNS just now.",
  ]);
  cleanup();
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { ...GOOD, spf: "missing", dmarc: "missing", authenticated: false })) as never);
  render(withQueries(<MailboxDomain workspaceId={W} credentialId={M} />));
  expect((await screen.findAllByRole("listitem")).map((l) => l.textContent)).toEqual(["It has no SPF record. Add the SPF record your email provider gives you.", "It has no DMARC record. Add one; p=none is enough to start."]);
});

test("an authenticated domain with a missing MX still lists it", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { ...GOOD, mx: "missing" })) as never);
  render(withQueries(<MailboxDomain workspaceId={W} credentialId={M} />));
  expect(await screen.findByText("Sends from acme.test. Receivers can check its mail is genuine, but:")).toBeTruthy();
});

test("a shared provider's domain needs nothing from the sender, and a failed read can be tried again", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(200, { ...GOOD, domain: "gmail.com", consumer: true, spf: "missing" })) as never);
  render(withQueries(<MailboxDomain workspaceId={W} credentialId={M} />));
  expect(await screen.findByText("Sends from gmail.com, whose sender checks are the provider's own.")).toBeTruthy();
  cleanup();
  vi.spyOn(api, "GET").mockImplementationOnce((() => reply(500, { error: "boom" })) as never).mockImplementationOnce((() => reply(200, GOOD)) as never);
  render(withQueries(<MailboxDomain workspaceId={W} credentialId={M} />));
  expect(screen.getByRole("status").textContent).toBe("Checking the sending domain…");
  await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
  expect(await screen.findByText(/^Sends from acme\.test: SPF, DKIM and DMARC/)).toBeTruthy();
});
