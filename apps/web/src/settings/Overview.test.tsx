// SPDX-License-Identifier: AGPL-3.0-only
// Settings' Overview: what needs someone now, each area's state, and the Hard floors.
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { api } from "../client";
import { withQueries } from "../testing";
import { Overview } from "./Overview";
import { needs } from "./needs";
import type { Credential, MailboxCheck } from "../credentials/actions";
import type { Account } from "../social/actions";
import type { Rule } from "../standing-rules/actions";

const W = "00000000-0000-4000-8000-0000000000aa";
const owner = { id: W, name: "Shop", role: "owner" as const, organization: { id: "o", name: "Acme" } };
const reply = (status: number, body: unknown) => Promise.resolve({ ...(status < 400 ? { data: body } : { error: body }), response: new Response(null, { status }) });
const box = (o: Partial<Credential>) => ({ id: "m1", name: "ana@acme.test", status: "active", connection: "gmail", scope: "user", ownerUserId: "u1", ...o }) as Credential;
const passed = (id: string) => ({ credentialId: id, state: "passed", reason: null, warnings: [] }) as unknown as MailboxCheck;
const acct = (o: Partial<Account>) => ({ id: "a1", name: "Acme Page", network: "LinkedIn", status: "active", warning: null, ...o }) as Account;
const rule = (o: Partial<Rule>) => ({ id: "r1", status: "active", total: 7, expiresAt: "2026-12-14T00:00:00.000Z", suspendedReason: null, ...o }) as Rule;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("nothing needs anyone when every account works, checks passed and the budget has room", () => {
  expect(needs({ mailboxes: [box({})], checks: [passed("m1")], accounts: [acct({})], usage: { settledMicros: "10", budgetMicros: "100" }, rules: [rule({})] })).toEqual([]);
});

test("each broken thing needs someone, says why and links where to fix it", () => {
  const list = needs({
    mailboxes: [box({ status: "needs_reauth" }), box({ id: "m2", name: "hello@acme.test" })],
    checks: [],
    accounts: [acct({ status: "needs_reauth" }), acct({ id: "a2", name: "Acme X", network: "X", warning: { level: "soon", endsAt: "2026-11-20T00:00:00.000Z" } })],
    usage: { settledMicros: "40000000", budgetMicros: "50000000" },
    rules: [rule({ status: "suspended", suspendedReason: "A fact in this template changed." })],
  });
  expect(list.map((n) => [n.what, n.to, n.act])).toEqual([
    ["ana@acme.test stopped sending.", "/w/$workspaceId/settings/credentials", "Reconnect"],
    ["hello@acme.test hasn't passed its unsubscribe check.", "/w/$workspaceId/settings/credentials", "Check it"],
    ["LinkedIn account Acme Page needs reconnecting.", "/w/$workspaceId/settings/social", "Reconnect"],
    ["X account Acme X must be reconnected by Fri 20 Nov.", "/w/$workspaceId/settings/social", "Reconnect"],
    ["An auto-approve rule stopped and needs review.", "/w/$workspaceId/settings/rules", "Review"],
    ["AI cost is at $40.00 of the $50.00 budget.", "/w/$workspaceId/settings/models", "See AI cost"],
  ]);
  expect(list[4]!.why).toBe("A fact in this template changed.");
});

test("the page lists what needs you, a card per area, and what Direx never does", async () => {
  vi.spyOn(api, "GET").mockImplementation(((path: string) => {
    if (path === "/api/w/{workspaceId}/credentials") return reply(200, { credentials: [box({ status: "needs_reauth" })] });
    if (path === "/api/w/{workspaceId}/mailbox-providers") return reply(200, { providers: [{ connection: "gmail", label: "Gmail", connect: "oauth" }] });
    if (path === "/api/w/{workspaceId}/outreach/mailbox-checks") return reply(200, { checks: [] });
    if (path === "/api/w/{workspaceId}/social/accounts") return reply(200, { accounts: [acct({})] });
    if (path === "/api/w/{workspaceId}/standing-rules") return reply(200, { rules: [rule({})] });
    return reply(404, { error: "not_found" });
  }) as never);
  render(withQueries(<Overview workspace={owner} me="u1" />));
  const needsYou = await screen.findByRole("region", { name: "Needs you" });
  expect(within(needsYou).getByRole("heading").textContent).toBe("1 thing needs you");
  expect(within(needsYou).getByRole("link", { name: "Reconnect" }).getAttribute("href")).toBe(`/w/${W}/settings/credentials`);
  expect(await screen.findByText("1 not sending")).toBeTruthy();
  expect(await screen.findByText("All working")).toBeTruthy();
  expect(screen.getByText("1 on")).toBeTruthy();
  expect(screen.getByRole("region", { name: "Never, whatever the settings say" }).textContent).toContain("Email someone who opted out");
});

test("an email account that sends but hasn't passed its unsubscribe check isn't shown as all fine", async () => {
  vi.spyOn(api, "GET").mockImplementation(((path: string, options?: { params?: { query?: { purpose?: string } } }) => {
    if (path === "/api/w/{workspaceId}/credentials") return reply(200, { credentials: [box({})] });
    if (path === "/api/w/{workspaceId}/mailbox-providers") return reply(200, { providers: options?.params?.query?.purpose === "existing" ? [{ connection: "gmail", label: "Gmail", connect: "oauth" }] : [] });
    if (path === "/api/w/{workspaceId}/outreach/mailbox-checks") return reply(200, { checks: [] });
    return reply(404, { error: "not_found" });
  }) as never);
  render(withQueries(<Overview workspace={owner} me="u1" />));
  expect(await screen.findByText("1 not checked")).toBeTruthy();
  expect(screen.getByText("Cold email waits until each passes its unsubscribe check.")).toBeTruthy();
  expect(screen.queryByText("All sending")).toBeNull();
});
