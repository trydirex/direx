// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// The newsletter settings screen: each state reads plainly, only an Admin or Owner gets the form, and
// saving sends what was chosen.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { api } from "../client";
import { withQueries, selectOptions } from "../testing";
import { accountLists, chooseList, saveSettings, type AccountList, type SettingsPage } from "./actions";
import { Settings } from "./Settings";
import { loadLaterFields } from "@/testing";

// The date, time, number and file fields load on first use; a page rendered to a string shows them only once loaded.
beforeAll(loadLaterFields);

const W = "00000000-0000-4000-8000-0000000000aa";
const KIT = "00000000-0000-4000-8000-000000000001";
const settings = { list: "connected" as const, credentialId: KIT, weekday: 2, sendTime: "09:00", timeZone: "Europe/Berlin", enabled: true, readOnlySince: null, readOnlyReason: null, lastSentAt: null };
const MC = "00000000-0000-4000-8000-000000000002";
const none = { hasLists: false, listId: null, listName: null };
const kitOn = { connection: "kit", name: "Kit", credentialId: KIT, ...none };
const beehiivOff = { connection: "beehiiv", name: "beehiiv", credentialId: null, ...none };
const mailchimpOff = { connection: "mailchimp", name: "Mailchimp", credentialId: null, ...none, hasLists: true };
const on: SettingsPage = { settings, platforms: [kitOn, beehiivOff, mailchimpOff], lists: [{ credentialId: KIT, connection: "kit", name: "Kit" }], nextSlot: "2026-11-10T08:00:00.000Z", quiet: false, subscriberCount: null };
const pageEl = (initial: SettingsPage, role: "owner" | "admin" | "marketer" | "viewer" = "owner", initialLists?: AccountList[]) =>
  withQueries(createElement(Settings, { workspaceId: W, role, initial, ...(initialLists && { initialLists }) }));
const page = (initial: SettingsPage, role: "owner" | "admin" | "marketer" | "viewer" = "owner", initialLists?: AccountList[]) => renderToString(pageEl(initial, role, initialLists));
const mailchimpSaved = (listId: string | null, listName: string | null): SettingsPage => ({
  ...on,
  settings: { ...settings, credentialId: MC },
  platforms: [kitOn, beehiivOff, { ...mailchimpOff, credentialId: MC, listId, listName }],
  lists: [...on.lists, { credentialId: MC, connection: "mailchimp", name: "Mailchimp" }],
});
const TWO = [{ id: "a1", name: "Founders", subscriberCount: 340 }, { id: "b2", name: "Customers", subscriberCount: 1200 }];

test("on: the next issue, its list and that it needs approval; an Owner gets the form", () => {
  const html = page(on);
  const tools = selectOptions(pageEl(on))["Newsletter tool"]?.options;
  expect(html).toContain("Next issue: Tuesday 10 November, 09:00 (Europe/Berlin), to Kit.");
  expect(html).toContain("if nobody does, that week&#x27;s issue is skipped");
  expect(tools).toContain("Substack (you copy and paste each issue)");
  expect(html).toContain("<button>Save</button>");
});

test("not set up, with nothing connected: every tool and Substack are offered, and the first asks for its key before any slot", () => {
  const unset = { settings: null, platforms: [{ ...kitOn, credentialId: null }, beehiivOff, mailchimpOff], lists: [], nextSlot: null, quiet: false, subscriberCount: null };
  const html = page(unset);
  const tools = selectOptions(pageEl(unset))["Newsletter tool"]?.options;
  for (const name of ["Kit (not connected yet)", "beehiiv (not connected yet)", "Mailchimp (not connected yet)", "Substack (you copy and paste each issue)"]) expect(tools).toContain(name);
  expect(html).toContain("Kit API key");
  expect(html).toContain("<button>Connect Kit</button>");
  expect(html).not.toContain("<button>Save</button>");
  expect(html).not.toContain("Next issue");
});

test("a connected tool skips the key step and goes straight to the slot", () => {
  const html = page(on);
  expect(html).not.toContain("API key");
  expect(html).toContain("<button>Save</button>");
});

test("a tool whose account holds several lists asks which one, and says no issue is made until then", () => {
  const html = page(mailchimpSaved(null, null), "owner", TWO);
  expect(html).toContain("Which Mailchimp list gets the newsletter");
  const lists = selectOptions(pageEl(mailchimpSaved(null, null), "owner", TWO))["Which Mailchimp list gets the newsletter"]?.options;
  expect(lists).toContain("Founders (340 subscribers)");
  expect(lists).toContain("Customers (1,200 subscribers)");
  expect(html).toContain("No issue is made until you do.");
});

test("once a list is chosen, the waiting sentence goes and the issue names the list", () => {
  const html = page(mailchimpSaved("a1", "Founders"), "owner", TWO);
  expect(html).not.toContain("No issue is made until you do.");
  expect(html).toContain("to Mailchimp, list Founders.");
});

test("an account with one list needs no choice", () => {
  const html = page(mailchimpSaved(null, null), "owner", [TWO[0]!]);
  expect(html).toContain("Mailchimp has one list, Founders, so the newsletter goes there.");
  expect(html).not.toContain("Which Mailchimp list");
});

test("choosing a list and reading lists call the right routes", async () => {
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: {} } as never);
  expect(await chooseList(W, MC, "b2")).toBeNull();
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/newsletter/keys/{credentialId}/list", { params: { path: { workspaceId: W, credentialId: MC } }, body: { listId: "b2" } });
  vi.spyOn(api, "GET").mockResolvedValue({ data: { lists: TWO } } as never);
  expect(await accountLists(W, MC)).toEqual(TWO);
  vi.spyOn(api, "GET").mockResolvedValue({ error: { error: "tool_unreachable" } } as never);
  expect(await accountLists(W, MC)).toBe("tool_unreachable");
});

test("off, read-only and quiet each say so", () => {
  expect(page({ ...on, settings: { ...settings, enabled: false }, nextSlot: null })).toContain("The weekly issue is off.");
  expect(page({ ...on, settings: { ...settings, readOnlySince: "2026-11-10T08:00:00.000Z", readOnlyReason: "beehiiv Pro" } })).toContain("it needs beehiiv Pro.");
  expect(page({ ...on, quiet: true })).toContain("more than a month since your last issue");
});

test("an Admin may change it; a Marketer or Viewer only reads it", () => {
  expect(page(on, "admin")).toContain("<button>Save</button>");
  for (const role of ["marketer", "viewer"] as const) {
    const html = page(on, role);
    expect(html).not.toContain("<form");
    expect(html).toContain("Tuesdays at 09:00 (Europe/Berlin), to Kit. Only an Admin or Owner can change this.");
  }
});

test("saving sends the chosen list and slot", async () => {
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: {} } as never);
  const body = { list: "substack" as const, credentialId: null, weekday: 5, sendTime: "07:30", timeZone: "America/New_York", enabled: true };
  expect(await saveSettings(W, body)).toBeNull();
  expect(put).toHaveBeenCalledWith("/api/w/{workspaceId}/newsletter/settings", { params: { path: { workspaceId: W } }, body });
});
