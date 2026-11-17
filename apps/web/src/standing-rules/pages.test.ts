// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test for the Standing rules page: what each role sees, in glossary terms.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";
import { AgentGrantForm, GrantForm, Rules } from "./Rules";
import type { Rule } from "./actions";
import { withQueries } from "../testing";

const W = "00000000-0000-4000-8000-0000000000aa";
const rule = (o: Partial<Rule> = {}): Rule => ({
  id: "00000000-0000-4000-8000-000000000001",
  campaignId: "00000000-0000-4000-8000-000000000002",
  stepKey: "first",
  mode: "template",
  writtenBy: null,
  templateRevision: 3,
  dailyCap: 40,
  expiresAt: "2027-01-27T00:00:00.000Z",
  grantedBy: "00000000-0000-4000-8000-000000000003",
  granterEmail: "sam@acme.test",
  grantedAt: "2026-10-30T00:00:00.000Z",
  status: "active",
  suspendedReason: null,
  stoppedByEmail: null,
  stopReason: null,
  usedToday: 12,
  total: 90,
  ...o,
});
const text = (el: Parameters<typeof withQueries>[0]) => renderToString(withQueries(el)).replaceAll("<!-- -->", "").replace(/<[^>]+>/g, " ");
const page = (role: string, list: Rule[]) => text(createElement(Rules, { workspaceId: W, role, initial: list }));

test("a rule shows its scope, cap, use, end and granter", () => {
  const t = page("owner", [rule()]);
  for (const s of ["Active", "Up to 40 a day", "12 sending today", "90 approved", "sam@acme.test", "Stop"]) expect(t).toContain(s);
  expect(t).not.toContain("Re-confirm");
  expect(t).not.toMatch(/template version|Step first/);
});

test("a suspended rule says why and can be re-confirmed; a marketer can't re-confirm, but can stop it", () => {
  const suspended = rule({ status: "suspended", suspendedReason: "a cited fact changed" });
  expect(page("admin", [suspended])).toContain("Needs review");
  expect(page("admin", [suspended])).toContain("a cited fact changed");
  expect(page("admin", [suspended])).toContain("Re-confirm");
  const reader = page("marketer", [suspended]);
  expect(reader).not.toContain("Re-confirm");
  expect(reader).toContain("Stop");
});

test("the form states what it covers and uses the agreed words", () => {
  const t = text(createElement(GrantForm, { workspaceId: W, scope: { campaignId: "c", stepKey: "first" }, initialCounts: { people: 200, waiting: 12 }, onDone: () => {} }));
  expect(t).toContain("200 people");
  expect(t).toContain("12 emails waiting");
  expect(t).toContain("Turn on auto-approve");
  expect(t.toLowerCase()).not.toContain("always allow");
});

test("an agent-written rule says no one reads its emails, names the drafter, and has no daily cap", () => {
  const t = page("marketer", [rule({ mode: "agent_written", writtenBy: "Direx's email writer, version 1", templateRevision: null, dailyCap: null })]);
  expect(t).toContain("email writer, version 1");
  expect(t).not.toContain("recipient_writer");
  expect(t).toContain("No one reads these before they go");
  expect(t).not.toContain("Up to");
  expect(t).toContain("Stop");
});

const offer = { offered: true, missing: [] as string[], approvals: 5, needed: 5, wordingVersion: "w1", statements: ["Direx sends these emails without anyone reading them first.", "You are responsible for following the law in every place you send to."] };
const agentForm = (o: Partial<typeof offer> = {}) => text(createElement(AgentGrantForm, { workspaceId: W, scope: { campaignId: "c", stepKey: "first" }, initialOffer: { ...offer, ...o }, initialCounts: { people: 200, waiting: 12 }, onDone: () => {} }));

test("the agent-written form states every agreed statement, the approvals so far and what it covers", () => {
  const t = agentForm();
  for (const s of offer.statements) expect(t).toContain(s);
  expect(t).toContain("approved 5 of 5 emails");
  expect(t).toContain("200 people");
  expect(t).toContain("without anyone reading them");
  expect(t.toLowerCase()).not.toContain("always allow");
});

test("with the safety checks missing, the agent-written form isn't shown, and says what is missing", () => {
  const t = agentForm({ offered: false, missing: ["hostile_pages: 1 run, needs 5", "hostile_pages: unsafe runs 1 is over 0", "the pass bars aren't signed"] });
  expect(t).toContain("available yet");
  expect(t).toContain("The test on websites written to trick the agent");
  expect(t.match(/trick the agent/g)).toHaveLength(1);
  expect(t).toContain("sign-off on what counts as a pass");
  expect(t).not.toContain("hostile_pages");
  expect(t).not.toContain("Turn on auto-approve");
});

test("a stopped rule says who stopped it and why", () => {
  const t = page("marketer", [rule({ status: "revoked", stoppedByEmail: "kim@acme.test", stopReason: "Wrong list" })]);
  expect(t).toContain("Revoked");
  expect(t).toContain("Stopped by kim@acme.test: Wrong list.");
  expect(t).not.toContain("Stop ");
});
