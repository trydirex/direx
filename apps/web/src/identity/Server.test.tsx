// SPDX-License-Identifier: AGPL-3.0-only
// The Server page: the sign-up rule (locked while mail fails), Server admins, and the accounts.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../client";
import { withQueries } from "../testing";
import { Server } from "./Server";

const ME = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const accounts = [
  { userId: ME, email: "me@example.com", emailVerified: true, createdAt: "2026-11-01T10:00:00.000Z", serverAdmin: true },
  { userId: OTHER, email: "sam@example.com", emailVerified: false, createdAt: "2026-11-02T10:00:00.000Z", serverAdmin: false },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function serve(mailOk: boolean) {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/server/policy") return reply(200, { policy: "invite_only", domains: [] });
    if (path === "/api/server/mail-status") return reply(200, { ok: mailOk });
    if (path === "/api/server/accounts") return reply(200, { accounts });
    if (path === "/api/server/plugins") return reply(200, { plugins: [] });
    return reply(404, { error: "not_found" });
  }) as never);
}

test("the page shows the sign-up rule, the Server admins and every account", async () => {
  serve(true);
  render(withQueries(<Server me={ME} />));
  expect(((await screen.findByLabelText(/Invite only/)) as HTMLInputElement).checked).toBe(true);
  expect(await screen.findByText("Mail is working, so new accounts can confirm their email.")).toBeTruthy();
  const admins = await screen.findByRole("region", { name: "Server admins" });
  expect(within(admins).getByText("me@example.com")).toBeTruthy();
  expect(within(admins).queryByText("sam@example.com")).toBeNull();
  const rows = within(screen.getByRole("region", { name: "Accounts" })).getAllByRole("row");
  expect(rows).toHaveLength(3);
  expect(rows[2]!.textContent).toContain("sam@example.com");
  expect(rows[2]!.textContent).toContain("No");
});

test("choosing Allowed domains saves the listed domains", async () => {
  serve(true);
  const put = vi.spyOn(api, "PUT").mockImplementation((() => reply(200, { policy: "domains", domains: ["example.com"] })) as never);
  render(withQueries(<Server me={ME} />));
  await screen.findByText("Mail is working, so new accounts can confirm their email.");
  await userEvent.click(await screen.findByLabelText(/Allowed domains/));
  await userEvent.type(screen.getByLabelText("Domains"), "example.com, example.org");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await vi.waitFor(() => expect(put).toHaveBeenCalledWith("/api/server/policy", { body: { policy: "domains", domains: ["example.com", "example.org"] } }));
});

test("while mail fails, the rule is locked and the page says why", async () => {
  serve(false);
  render(withQueries(<Server me={ME} />));
  expect((await screen.findByRole("alert")).textContent).toContain("This server can't send mail");
  expect(((await screen.findByLabelText(/Anyone/)) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
});

test("someone who isn't a Server admin sees one plain note, not mail or role errors", async () => {
  vi.spyOn(api, "GET").mockImplementation((() => reply(403, { error: "forbidden" })) as never);
  render(withQueries(<Server me={ME} />));
  expect(await screen.findByText("Only Server admins can open this page. Ask whoever runs this server if something here needs to change.")).toBeTruthy();
  expect(screen.queryByText(/can't send mail/)).toBeNull();
  expect(screen.queryByText(/Your role in this Workspace/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("adding a Server admin sends the email; a stale sign-in asks to sign in again", async () => {
  serve(true);
  const post = vi.spyOn(api, "POST").mockImplementation((() => reply(403, { error: "step_up_required" })) as never);
  render(withQueries(<Server me={ME} />));
  await userEvent.type(await screen.findByLabelText("Email of an existing account"), "sam@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Add Server admin" }));
  expect(post).toHaveBeenCalledWith("/api/server/admins", { body: { email: "sam@example.com" } });
  expect(await screen.findByRole("heading", { name: "Confirm it's you" })).toBeTruthy();
});

test("an email with no account says how to fix it", async () => {
  serve(true);
  vi.spyOn(api, "POST").mockImplementation((() => reply(404, { error: "no_account" })) as never);
  render(withQueries(<Server me={ME} />));
  await userEvent.type(await screen.findByLabelText("Email of an existing account"), "nobody@example.com");
  await userEvent.click(screen.getByRole("button", { name: "Add Server admin" }));
  expect((await screen.findByRole("alert")).textContent).toBe("No account has that email. Ask them to sign in to this server once, then add them.");
});
