// SPDX-License-Identifier: AGPL-3.0-only
// Smoke test for Home, the Calendar and the Item panel: each renders in glossary terms for
// the roles that may act, and each action calls its endpoint.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { beforeAll, expect, test, vi } from "vitest";
import { loadLaterFields } from "@/testing";
import { api } from "../client";
import { buttons, withQueries, withoutButtons } from "../testing";
import { approvable, approve, approveClean, approveLabel, cancel, chips, firstSlot, kindLabel, listTime, move, needsYou, onDay, resolveUnknown, resume, week, weekStart, type Item, type Role } from "./actions";
import { Calendar } from "./Calendar";
import { greeting, Home } from "./Home";
import { BasisNotes, Content, ItemPanel, ItemDialog } from "./ItemPanel";
import { ago } from "@/lib/ago";
import { StateChip } from "./StateChip";

// The date, time, number and file fields load on first use; a page rendered to a string shows them only once loaded.
beforeAll(loadLaterFields);

const W = "00000000-0000-4000-8000-0000000000aa";
const MONDAY = new Date(2026, 10, 2);
const at = new Date(2026, 10, 3, 9, 0).toISOString();
const item = (o: Partial<Item> = {}): Item => ({
  id: crypto.randomUUID(),
  kind: "action",
  state: "needs_approval",
  reason: null,
  reasonCode: null,
  revision: 2,
  title: "A post",
  workArea: null,
  channel: "post",
  groupKey: null,
  groupLabel: null,
  at,
  warnings: [],
  clean: true,
  movable: true,
  decideBy: null,
  snoozedUntil: null,
  createdAt: at,
  ...o,
});
// Screens link with the router and load through the query layer, so each render gets both.
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const html = (el: Parameters<typeof renderToString>[0]) => renderToString(withQueries(createElement(RouterContextProvider, { router, children: el }))).replaceAll("<!-- -->", "");
const home = (items: Item[], role: Role = "marketer") => html(createElement(Home, { workspaceId: W, role, initial: { items, count: items.length } }));
// The day the Items are on: the day view's cards carry their actions.
const calendar = (items: Item[], role: Role = "marketer", view = "day") => html(createElement(Calendar, { workspaceId: W, role, ItemView: ItemDialog, start: new Date(2026, 10, 3), initial: items, view }));
const panel = (i: Item, role: Role = "marketer", content: unknown = { body: "hi" }) =>
  html(createElement(ItemPanel, { workspaceId: W, id: i.id, role, onChange: () => {}, onClose: () => {}, initial: { item: i, content, timeline: [], ruleGrantedBy: null } }));

test("an email to one Person shows why they may be contacted and the suggestions, before Approve", () => {
  const basis = { country: "GB", basis: "published_address", entityType: "sole_trader", scope: null, expiresAt: null, confidence: "stated", warnings: ["entity_needs_consent" as const] };
  const page = html(
    createElement(ItemPanel, { workspaceId: W, id: "e1", role: "owner", onChange: () => {}, onClose: () => {}, initial: { item: item({ channel: "email" }), content: { touch: { personId: "p1" } }, timeline: [], ruleGrantedBy: null, basis } }),
  );
  expect(page).toContain("GB, Published address, sole trader");
  expect(page).toContain("To check: UK sole traders and partnerships usually need consent.");
  expect(page.indexOf("To check:")).toBeLessThan(page.indexOf("Approve"));
  expect(html(createElement(BasisNotes, { workspaceId: W, personId: "p1", initial: null }))).toContain("No reason recorded");
  // A post names no Person, so there is nothing to show.
  expect(panel(item())).not.toContain("Why they may be contacted");
});

test("every state shows its name, and no screen says Failed", () => {
  const states = ["draft", "needs_approval", "scheduled", "sent", "applied", "held", "blocked", "cancelled"] as const;
  const names = states.map((state) => html(createElement(StateChip, { state })).replace(/<[^>]+>/g, ""));
  expect(names).toEqual(["Draft", "Needs approval", "Scheduled", "Sent", "Applied", "Held", "Blocked", "Cancelled"]);
  expect(html(createElement(StateChip, { state: "held", reason: "not sure it sent" }))).toContain("Held: not sure it sent");
  const held = item({ state: "held", reason: "not sure it sent", reasonCode: "outcome_unknown", movable: false, clean: false });
  for (const page of [home([item(), held]), calendar([item(), held]), panel(held)]) expect(page.replace(/<[^>]+>/g, " ")).not.toMatch(/fail/i);
});

test("Home shows what needs the person, and only an approver gets Approve all clean", () => {
  expect(home([])).toContain("Nothing is waiting for you");
  const page = home([item(), item({ clean: false, warnings: [{ code: "uncited_number", text: "a claim has no source" }] })]);
  expect(page).toContain("Needs you (2)");
  expect(page).toContain("Approve 1 ticked");
  // One warning says itself; two say how many.
  expect(page).toContain("a claim has no source");
  expect(home([item({ clean: false, warnings: [{ code: "unspecified", text: "x" }, { code: "unspecified", text: "y" }] })])).toContain("2 warnings");
  expect(home([item()], "contributor")).not.toContain("Approve 1 ticked");
  // With nothing to approve together and nothing more in Review, the card has no footer row at all.
  const footer = "border-t border-border px-4 py-3";
  expect(home([item()], "contributor")).not.toContain(footer);
  expect(home([item()])).toContain(footer);
  expect([greeting(8, "Sam Lee"), greeting(14, ""), greeting(20)]).toEqual(["Good morning, Sam", "Good afternoon", "Good evening"]);
});

test("the Calendar groups a day's Items into one chip that approves only the clean ones", () => {
  const group = { groupKey: "q4", groupLabel: "Q4 ops", channel: "email" };
  const items = [item(group), item(group), item({ ...group, clean: false, warnings: [{ code: "unspecified", text: "x" }] }), item({ title: "Solo" })];
  const day = new Date(2026, 10, 3);
  const c = chips(items, day);
  expect(c.map((x) => [x.title, x.items.length])).toEqual([["Q4 ops", 3], ["Solo", 1]]);
  expect(approvable(c[0]!)).toHaveLength(2);
  expect(chips(items, new Date(2026, 10, 4))).toEqual([]);
  expect(chips([item({ state: "cancelled" })], day)).toEqual([]);
  const page = calendar(items);
  expect(page).toContain("Q4 ops · 3");
  expect(page).toMatch(/Approve 2 · sends/);
  expect(page).toContain('draggable="true"');
  expect(calendar(items, "viewer")).not.toContain('draggable="true"');
  expect(calendar(items, "viewer")).not.toContain("Approve");
});

test("weeks start on Monday, and a move keeps the time of day", () => {
  expect(weekStart(new Date(2026, 10, 8, 23))).toEqual(MONDAY);
  expect(weekStart(MONDAY)).toEqual(MONDAY);
  expect(onDay(new Date(2026, 10, 3, 9, 30), new Date(2026, 10, 6))).toEqual(new Date(2026, 10, 6, 9, 30));
});

test("the approve button states its effect", () => {
  const f = () => "Tue 9:00";
  expect(approveLabel([item()], f)).toBe("Approve · sends Tue 9:00");
  expect(approveLabel([item(), item()], f)).toBe("Approve 2 · sends Tue 9:00");
  expect(approveLabel([item({ at: null })], f)).toBe("Approve · sends now");
  // Direx never sends a post copied by hand, so its button says who posts it.
  expect(approveLabel([item({ kind: "manual_post" })], f)).toBe("Approve · you post it by hand, Tue 9:00");
  expect(approveLabel([item({ kind: "manual_post" }), item({ kind: "manual_post" })], f)).toBe("Approve 2 · you post them by hand, Tue 9:00");
  expect(approveLabel([item({ kind: "manual_post" }), item()], f)).toBe("Approve 2 · sends Tue 9:00");
});

test("the panel offers what the state and role allow", () => {
  expect(panel(item())).toMatch(/Approve · sends/);
  expect(panel(item(), "contributor")).not.toMatch(/Approve · sends/);
  expect(panel(item())).toContain("Don&#x27;t send");
  expect(panel(item(), "viewer")).not.toContain("Don&#x27;t send");
  // The send time is a date-and-time field: a date and its "Send at time".
  expect(panel(item())).toContain('aria-label="Send at time"');
  const unknown = panel(item({ state: "held", reasonCode: "outcome_unknown", reason: "not sure it sent", movable: false }));
  expect(unknown).toContain("Mark sent");
  expect(unknown).toContain("Resend, accepting it may go out twice");
  expect(unknown).not.toContain("Don&#x27;t send");
  expect(unknown).not.toContain("datetime-local");
  expect(panel(item({ state: "held", reasonCode: "credential_unavailable", reason: "credential can't be used" }))).toContain("Reconnect");
  const fact = panel(item({ kind: "fact_edit", at: null, movable: false }));
  expect(fact).toContain("Accept");
  expect(fact).toContain("Dismiss");
});

test("each action calls its endpoint", async () => {
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: { results: [{ id: "a", ok: true }, { id: "b", ok: false, reason: "not_clean" }] } } as never);
  const get = vi.spyOn(api, "GET").mockResolvedValue({ data: { items: [], needsYouCount: 0 } } as never);
  const one = { path: { workspaceId: W, id: "a" } };
  const all = { path: { workspaceId: W } };

  await needsYou(W);
  expect(get).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items", { params: { ...all, query: { needsYou: "true", limit: 200 } } });
  const from = new Date("2026-11-02T00:00:00Z");
  const to = new Date("2026-11-09T00:00:00Z");
  await week(W, from, to);
  expect(get).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items", { params: { ...all, query: { from: from.toISOString(), to: to.toISOString(), limit: 500 } } });

  expect(await approve(W, { id: "a", revision: 2 })).toBeNull();
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/approve", { params: one, body: { revision: 2 } });
  expect(await approveClean(W, [{ id: "a", revision: 1 }, { id: "b", revision: 1 }])).toEqual({ done: 1, ids: ["a"], refused: [{ id: "b", reason: "not_clean" }] });
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/approve-clean", { params: all, body: { items: [{ id: "a", revision: 1 }, { id: "b", revision: 1 }] } });
  await move(W, [{ id: "a", plannedAt: at }]);
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/move", { params: all, body: { items: [{ id: "a", plannedAt: at }] } });
  await cancel(W, "a");
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/cancel", { params: one });
  await resume(W, "a");
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/resume", { params: one });
  await resolveUnknown(W, "a", "mark_sent");
  expect(post).toHaveBeenLastCalledWith("/api/w/{workspaceId}/items/{id}/resolve-unknown", { params: one, body: { choice: "mark_sent" } });
  vi.restoreAllMocks();
});

const review = (reply: { senderEmail: string; text: string | null; status: string }, role: Role = "marketer") =>
  html(createElement(ItemPanel, { workspaceId: W, id: "r1", role, onChange: () => {}, onClose: () => {}, initial: { item: item({ kind: "opt_out_review", clean: false, movable: false }), content: { signalId: "s1" }, timeline: [], ruleGrantedBy: null, reply } }));

test("a reply to judge offers both answers, can't be dismissed, and shows its text inert", () => {
  const page = review({ senderEmail: "kim@example.com", text: "<script>alert(1)</script> Why me?", status: "needs_person" });
  expect(page).toContain("They asked to stop");
  expect(page).toContain("They didn&#x27;t");
  expect(page).not.toContain("Dismiss");
  expect(page).not.toContain("<script>");
  expect(page).toContain("&lt;script&gt;");
  expect(page).not.toContain("signalId");
});

test("a reply whose text has been cleared says so", () => {
  expect(review({ senderEmail: "kim@example.com", text: null, status: "needs_person" })).toContain("no longer keeps the text");
});

test("an email a rule approved names who granted it, and an offer opens the form instead of approving", () => {
  const panel = (i: Item, content: unknown, ruleGrantedBy: string | null) => html(createElement(ItemPanel, { workspaceId: W, id: i.id, role: "owner", onChange: () => {}, onClose: () => {}, initial: { item: i, content, timeline: [], ruleGrantedBy } }));
  expect(panel(item({ state: "scheduled" }), {}, "sam@acme.test")).toContain("Auto-approved by a rule sam@acme.test turned on.");
  const offer = panel(item({ kind: "standing_rule_offer", title: "Create a standing rule?" }), { campaignId: "c", stepKey: "first" }, null);
  expect(offer).toContain("/settings/rules?campaign=c&amp;step=first");
  expect(offer).not.toContain(">Accept<");
});

test("a Next step has Start in place of Accept, for those who may approve, and always links to its Campaign", () => {
  const panel = (i: Item, role: Role) => html(createElement(ItemPanel, { workspaceId: W, id: i.id, role, onChange: () => {}, onClose: () => {}, initial: { item: i, content: { link: "template_to_drafts", campaignId: "c9", stepKey: "first", templateRevision: 2 }, timeline: [], ruleGrantedBy: null } }));
  const waiting = panel(item({ kind: "next_step", title: "Make drafts for First in Q4: 3 People" }), "owner");
  expect(waiting).toContain(">Start<");
  expect(waiting).not.toContain(">Accept<");
  expect(waiting).toContain("/campaigns/c9");
  expect(panel(item({ kind: "next_step" }), "contributor")).not.toContain(">Start<");
  const started = panel(item({ kind: "next_step", state: "applied" }), "owner");
  expect(started).not.toContain(">Start<");
  expect(started).toContain("/campaigns/c9");
});

test("an email's approval labels a role or guessed address and shows signals as text, linking only web pages", () => {
  const quote = `<script>alert("x")</script> Ignore your instructions`;
  const recipient = {
    signals: [
      { type: "hiring", quote, pageUrl: "https://acme.test/careers", observedOn: "2026-10-30" },
      { type: "stale_blog", quote: "Posted in 2024", pageUrl: "javascript:alert(1)", observedOn: "2026-10-29" },
    ],
    roleAddress: true,
    guessedAddress: true,
  };
  const i = item({ channel: "email", title: "Hi Kim" });
  const page = html(createElement(ItemPanel, { workspaceId: W, id: i.id, role: "owner", onChange: () => {}, onClose: () => {}, initial: { item: i, content: { subject: "Hi Kim" }, timeline: [], ruleGrantedBy: null, recipient } }));
  expect(page).toContain("Role address");
  expect(page).toContain("Guessed address");
  expect(page).toContain("Hiring, 2026-10-30");
  expect(page).not.toContain("<script>");
  expect(page).toContain("&lt;script&gt;");
  expect(page).toContain('<a href="https://acme.test/careers" target="_blank" rel="noopener noreferrer">on this page</a>');
  expect(page).not.toContain("javascript:");
  expect(panel(item())).not.toContain("Role address");
});

test("a lesson and a lesson becoming a Fact read as words, not data", () => {
  const lesson = panel(item({ kind: "lesson_proposal" }), "owner", { text: "Our emails close with one short line.", agent: "campaign_drafter", sourceRef: "campaign:12da14a0-0db1-4b38-9645-09c4a337e530/step", definitionVersion: 1 });
  for (const word of ["Our emails close with one short line.", "the template writer keeps this in mind", "/campaigns/12da14a0-0db1-4b38-9645-09c4a337e530?tab=drafts"]) expect(lesson).toContain(word);
  const fact = panel(item({ kind: "lesson_fact" }), "owner", { field: "never_say", value: "Never quote a discount.", source: { kind: "person", label: "Sales lead" }, subject: "", lessonId: "l", confidence: "high", lessonVersion: 1 });
  for (const word of ["Never quote a discount.", "under Never say", "Sales lead"]) expect(fact).toContain(word);
  for (const t of [lesson, fact]) expect(t).not.toMatch(/"(agent|field|lessonId)"|&quot;/);
});

test("an email sent under an agent-written rule names the granter and the drafter, and says no one read it", () => {
  const t = html(createElement(ItemPanel, { workspaceId: W, id: "a1", role: "owner", onChange: () => {}, onClose: () => {}, initial: { item: item({ channel: "email", state: "sent" }), content: { subject: "Hi Kim" }, timeline: [], ruleGrantedBy: "sam@acme.test", ruleWrittenBy: "recipient_writer version 1" } }));
  expect(t).toContain("sam@acme.test");
  expect(t).toContain("Written by recipient_writer version 1");
  expect(t).toContain("no one read it");
});

test("a newsletter issue's approve button names when readers get it, not when its tool is handed it", () => {
  const fmt = (iso: string) => listTime(new Date(iso));
  const out = panel(item({ workArea: "newsletter", at: "2026-11-10T07:55:00.000Z" }), "owner", { title: "Week 45", html: "<p>x</p>", at: "2026-11-10T08:00:00.000Z" });
  expect(out).toContain(`Approve · sends ${fmt("2026-11-10T08:00:00.000Z")}`);
  expect(out).not.toContain(`sends ${fmt("2026-11-10T07:55:00.000Z")}`);
});

test("a cold email can be skipped because we're talking to them, and a guess hold can be stopped", () => {
  const cold = { touch: { personId: "p1", touchClass: "cold" } };
  expect(panel(item(), "marketer", cold)).toContain("We&#x27;re talking to them");
  expect(panel(item(), "viewer", cold)).not.toContain("We&#x27;re talking to them");
  expect(panel(item(), "marketer", { touch: { personId: "p1", touchClass: "sales_follow_up" } })).not.toContain("We&#x27;re talking to them");
  const held = item({ state: "held", reasonCode: "may_be_talking", reason: "you may already be talking to this Person: you wrote to them in the last 90 days" });
  const page = panel(held, "marketer", cold);
  expect(buttons(page, "Stop holding")).toHaveLength(1);
  expect(page).toContain("you wrote to them in the last 90 days");
  expect(buttons(panel(item({ state: "held", reasonCode: "cap" }), "marketer", cold), "Stop holding")).toHaveLength(0);
});

test("a stalled step offers keep waiting, going ahead only when possible, and cancelling; Campaign notices only say got it", () => {
  const stall = (choices: string[]) => panel(item({ kind: "campaign_stall", title: "Second has no URL" }), "owner", { campaignId: "c9", stepKey: "second", choices });
  const open = stall(["wait", "go_ahead", "cancel"]);
  expect(open).toContain(">Keep waiting<");
  expect(open).toContain(">Go ahead without it<");
  expect(open).toContain(">Cancel the step<");
  expect(stall(["wait", "cancel"])).not.toContain(">Go ahead without it<");
  expect(panel(item({ kind: "campaign_launch_moved" }), "owner", { campaignId: "c9" })).toContain(">Got it<");
  expect(panel(item({ kind: "keys_lost" }), "owner", {})).toContain(">Resume them<");
  expect(panel(item({ kind: "late_sends" }), "owner", {})).toContain(">Send the emails<");
  expect(panel(item({ kind: "campaign_stall" }), "viewer", { campaignId: "c9", stepKey: "second", choices: ["wait", "go_ahead", "cancel"] })).not.toContain(">Cancel the step<");
});

test("a plan change offers keep, the new text only when the plan suggested some, and cancel; never a plain accept", () => {
  const change = (kinds: string[]) => panel(item({ kind: "plan_change", title: 'The plan changed "First"' }), "owner", { campaignId: "c9", stepKey: "first", kinds });
  const text = change(["text"]);
  for (const label of ["Keep the current text", "Use the new text", "Cancel the step"]) expect(buttons(text, label)).toHaveLength(1);
  expect(buttons(text, "Accept")).toHaveLength(0);
  // Dismissing would leave the step held with nothing to decide, and the payload is for Direx, not people.
  expect(buttons(text, "Dismiss")).toHaveLength(0);
  expect(text).not.toContain("stepKey");
  const removed = change(["removed"]);
  expect(buttons(removed, "Finish what&#x27;s scheduled")).not.toHaveLength(0);
  expect(buttons(removed, "Use the new text")).toHaveLength(0);
  expect(buttons(panel(item({ kind: "plan_change" }), "viewer", { campaignId: "c9", stepKey: "first", kinds: ["text"] }), "Cancel the step")).toHaveLength(0);
});

test("an email reads as an email: To, Cc, Subject and its text, never its HTML; other content stays as stored", () => {
  const email = { to: [{ name: "Kim Lee", address: "kim@acme.test" }], cc: ["ops@acme.test"], subject: "Hi Kim", text: "Hello Kim.\n\nUnsubscribe: https://x.test/u", html: "<b>BOLD</b>", boundary: "b" };
  const page = renderToString(createElement(Content, { content: email, showRaw: true }));
  expect(renderToString(createElement(Content, { content: email }))).not.toContain("<summary");
  expect(page).toContain('aria-label="Email"');
  expect(page).toContain("Kim Lee &lt;kim@acme.test&gt;");
  expect(page).toContain("ops@acme.test");
  expect(page).toContain("Hi Kim");
  expect(page).toContain("Hello Kim.\n\nUnsubscribe: https://x.test/u");
  expect(page).not.toContain("<b>BOLD</b>");
  expect(page).toContain("<summary");
  const other = renderToString(createElement(Content, { content: { body: "Hello" } }));
  expect(other).not.toContain('aria-label="Email"');
  expect(other).toContain("&quot;body&quot;: &quot;Hello&quot;");
});

test("a suggested Brand Fact reads as one: its field, value and source, with the stored form under Raw", () => {
  const page = renderToString(createElement(Content, { content: { field: "who_buys", value: "Accounting firms", subject: "", source: { kind: "website", label: "https://acme.test/" }, factId: "f1" } }));
  expect(page).toContain('aria-label="Proposed brand fact"');
  expect(page).toContain("Who buys");
  expect(page).toContain("Accounting firms");
  expect(page).toContain("https://acme.test/");
  expect(renderToString(createElement(Content, { content: { field: "price", subject: "Premium", value: "$15" } }))).toContain("Prices: Premium");
  expect(renderToString(createElement(Content, { content: { field: "not_a_field", value: "x" } }))).not.toContain("Proposed brand fact");
});

test("History says when in words: minutes, days and weeks ago, or just now", () => {
  const now = new Date("2026-11-09T12:00:00Z").getTime();
  expect(ago("2026-11-09T11:59:40Z", now)).toBe("just now");
  expect(ago("2026-11-09T11:55:00Z", now)).toBe(new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-5, "minute"));
  expect(ago("2026-10-31T12:00:00Z", now)).toBe(new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-1, "week"));
  expect(ago("2026-11-08T12:00:00Z", now)).toBe(new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-1, "day"));
});

test("an email shows the Mailbox it goes from, and a post reads as a post on its network", () => {
  const show = (content: unknown, appearance: unknown) =>
    html(createElement(ItemPanel, { workspaceId: W, id: "i1", role: "marketer", onChange: () => {}, onClose: () => {}, initial: { item: item(), content, timeline: [], ruleGrantedBy: null, appearance } as never }));
  const email = show({ to: ["kim@example.com"], subject: "Q4 ops", text: "Hi Kim" }, { kind: "email", from: "sam@acme.test" });
  expect(email).toContain(">From<");
  expect(email).toContain("sam@acme.test");
  // The inbox row shows the sender, the subject and the start of the text, as the recipient's list does.
  expect(email).toMatch(/aria-label="In the inbox".*sam@acme.test.*Q4 ops.* Hi Kim/);
  // A long LinkedIn post folds where the feed does; a short one and other networks show it all.
  const long = "a".repeat(300);
  expect(show({ text: long }, { kind: "post", account: "Acme", network: "LinkedIn", link: null })).toContain(`${"a".repeat(210)}…`);
  expect(show({ text: long }, { kind: "post", account: "Acme", network: "Bluesky", link: null })).not.toContain("see more");
  const post = show({ text: "Three things we learned https://acme.test/q4", followUps: ["Read the rest on our blog"] }, { kind: "post", account: "Acme", network: "LinkedIn", link: { url: "https://acme.test/q4", title: "Q4 ops", description: "Three things.", site: "Acme Blog", image: true } });
  expect(post).toContain('aria-label="LinkedIn post"');
  expect(post).toContain("Acme");
  expect(post).toContain("Three things we learned");
  expect(post).toContain('aria-label="Follow-up comments"');
  // The first link's card: the site, its title and description, opening the page in a new tab.
  expect(post).toMatch(/<a href="https:\/\/acme.test\/q4" target="_blank" rel="noreferrer noopener"[^>]*>.*Acme Blog.*Q4 ops.*Three things\./);
  expect(show({ text: "No link" }, { kind: "post", account: "Acme", network: "LinkedIn", link: null })).not.toContain('target="_blank"');
  // A post's own images show in order with their alt text, whether published (spec) or by hand (payload).
  const media = [{ mediaId: "m1", contentType: "image/png" }, { mediaId: "m2", contentType: "image/png" }];
  const pictured = show({ text: "Our numbers", media, alt: ["A chart of Q4", ""] }, { kind: "post", account: "Acme", network: "LinkedIn", link: null });
  expect(pictured).toContain(`<img src="/api/w/${W}/media/m1" alt="A chart of Q4"`);
  expect(pictured).toContain(`<img src="/api/w/${W}/media/m2" alt=""`);
  expect(show({ text: "By hand", images: [{ mediaId: "m3", fileName: "a.png", alt: "Team photo" }] }, { kind: "post", account: null, network: "Instagram", link: null })).toContain(`<img src="/api/w/${W}/media/m3" alt="Team photo"`);
  // A video post shows no image.
  expect(show({ text: "Watch", media: [{ mediaId: "v1", contentType: "video/mp4" }] }, { kind: "post", account: "Acme", network: "LinkedIn", link: null })).not.toContain("/media/v1");
  // Its picture loads from Direx, decorative beside the title; a card without one has no <img>.
  expect(post).toMatch(new RegExp(`<img src="/api/w/${W}/social/posts/[^/]+/link-image" alt="" loading="lazy"`));
  expect(show({ text: "https://acme.test/q4" }, { kind: "post", account: "Acme", network: "LinkedIn", link: { url: "https://acme.test/q4", title: "Q4 ops", description: null, site: "Acme", image: false } })).not.toContain("<img");
  // Without an appearance, the same post content stays as it was stored.
  expect(show({ text: "Three things we learned" }, null)).toContain("&quot;text&quot;: &quot;Three things we learned&quot;");
});

test("a Campaign's notices and choices read as Campaign, not as an approval", () => {
  for (const kind of ["campaign_waiting", "campaign_launch_moved", "campaign_stall", "campaign_plan_unfinished"]) expect(kindLabel({ kind, workArea: "outreach" }), kind).toBe("Campaign");
  expect(kindLabel({ kind: "action", workArea: "outreach" })).toBe("Email");
});

test("something put on a day goes at 9:00, or the next whole hour once today is past it", () => {
  const monday = new Date(2026, 10, 16);
  expect(firstSlot(monday, new Date(2026, 10, 16, 7, 30))).toEqual(new Date(2026, 10, 16, 9));
  expect(firstSlot(monday, new Date(2026, 10, 16, 20, 45))).toEqual(new Date(2026, 10, 16, 21));
  expect(firstSlot(new Date(2026, 10, 18), new Date(2026, 10, 16, 20, 45))).toEqual(new Date(2026, 10, 18, 9));
});
