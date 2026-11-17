// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
// Smoke test for the outreach screen: each role sees what it may do, and each action calls its endpoint.
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { api } from "../client";
import { addPerson, addProfile, logTouch, makeHoldHook, recordWords, removeTouch, setPaused, undoOptOut, verdict, writeEmail, type Overview } from "./actions";
import { HoldHook } from "./HoldHook";
import { Outreach } from "./Outreach";
import { PauseAll } from "./PauseAll";
import { Touches } from "./Touches";
import { withQueries } from "../testing";

const W = "00000000-0000-4000-8000-0000000000aa";
const record = { country: "US", basis: "consent", entityType: "unknown", scope: null, expiresAt: null, confidence: "stated", warnings: [], name: null, company: null, campaign: null, lastEmailAt: null, replied: false };
const data: Overview = {
  senderName: "Sam",
  postalAddress: "1 Main St",
  senderCountry: "US",
  paused: false,
  people: [
    { id: "00000000-0000-4000-8000-000000000001", email: "kim@example.com", ...record, suppressed: false, suppressedBecause: null, quote: null, newsletterSince: "2026-11-04T05:00:00.000Z", hold: { reason: "may_be_talking", detail: "sent_mail", release: "inferred", waitUntil: null } },
    { id: "00000000-0000-4000-8000-000000000002", email: "gone@example.com", ...record, suppressed: true, suppressedBecause: "unsubscribe", quote: null, newsletterSince: null, hold: null },
    { id: "00000000-0000-4000-8000-000000000004", email: "said@example.com", ...record, suppressed: true, suppressedBecause: "reply", quote: "take me off the list", newsletterSince: null, hold: null },
    {
      id: "00000000-0000-4000-8000-000000000003",
      email: "jo@example.co.uk",
      ...record,
      country: "GB",
      basis: "published_address",
      entityType: "sole_trader",
      expiresAt: "2027-01-31T00:00:00.000Z",
      warnings: ["entity_needs_consent"],
      suppressed: false,
      suppressedBecause: null,
      quote: null,
      newsletterSince: null,
      hold: { reason: "in_conversation", detail: "Deal: renewal", release: null, waitUntil: null },
    },
  ],
};
const page = (role: "owner" | "viewer") => renderToString(withQueries(createElement(Outreach, { workspaceId: W, role, initial: { data, boxes: [{ id: "b", name: "Sam's Gmail" }] } })));

test("each row says whether Direx can email them, with the reason when it can't", () => {
  const html = page("viewer");
  expect(html).toContain("Asked to stop");
  expect(html).toContain("Replied &quot;take me off the list&quot;");
  expect(html).toContain("Not now");
  expect(html).not.toMatch(/Send for approval|Opted out/);
});

test("a verdict: asked to stop, bounced, talking to them, a guess, no reason, a reason that ended, or yes", () => {
  const base = data.people[0]!;
  const v = (o: Partial<typeof base>) => verdict({ ...base, newsletterSince: null, hold: null, ...o }, new Date("2026-11-13"));
  expect(v({})).toEqual({ kind: "yes", label: "Can be emailed", reason: null, group: null });
  expect(v({ suppressed: true, suppressedBecause: "reply", quote: "stop" })).toMatchObject({ kind: "stop", label: "Asked to stop", reason: 'Replied "stop"' });
  expect(v({ suppressed: true, suppressedBecause: "unsubscribe" })).toMatchObject({ kind: "stop", label: "Asked to stop", reason: null });
  expect(v({ suppressed: true, suppressedBecause: "hard_bounce" })).toMatchObject({ kind: "stop", label: "Address doesn't exist", group: "bounced" });
  expect(v({ hold: { reason: "in_conversation", detail: "Deal: renewal", release: null, waitUntil: null } })).toMatchObject({ kind: "not_now", label: "Not now", reason: "Talking to them: Deal: renewal", group: "talking to them" });
  // Once the hold has ended only the 90-day wait is left, which is not "Talking to them".
  expect(v({ hold: { reason: "in_conversation", detail: "Deal: renewal", release: null, waitUntil: "2027-02-11T09:00:00.000Z" } })).toMatchObject({ kind: "not_now", reason: "Held until 2027-02-11: cold email waits 90 days after a hold ends", group: "held until a date" });
  expect(v({ hold: { reason: "may_be_talking", detail: "sent_mail", release: "inferred", waitUntil: null } }).reason).toBe("May be talking to them: you wrote to them in the last 90 days. Cold email waits");
  expect(v({ hold: { reason: "may_be_talking", detail: "company:Acme", release: "company", waitUntil: null } }).reason).toBe("May be talking to them: you're talking to someone at Acme. Cold email waits");
  expect(v({ country: null })).toMatchObject({ kind: "not_now", reason: "No reason recorded" });
  expect(v({ expiresAt: "2026-01-01T00:00:00.000Z" })).toMatchObject({ kind: "not_now", reason: "Reason ended 2026-01-01", group: "reason ended" });
  expect(v({ expiresAt: "2027-01-01T00:00:00.000Z" }).kind).toBe("yes");
});

test("a Person's record shows its kind of business, its end date and the suggestions, which say they are only that", () => {
  const html = page("viewer");
  expect(html).toContain("GB, Published address, sole trader, until 2027-01-31");
  expect(html).toContain("To check: UK sole traders and partnerships usually need consent.");
  expect(html).not.toMatch(/compliant|legal advice/i);
});

test("a hold shows its reason in one set of words, and the actions on it sit in the row menu", () => {
  const owner = page("owner");
  expect(owner).toContain("May be talking to them: you wrote to them in the last 90 days. Cold email waits");
  expect(owner).toContain("Talking to them: Deal: renewal");
  expect(owner).not.toMatch(/>Release<|>End hold<|Pause emails|Held\b/);
  expect(owner).toContain('aria-label="Actions for kim@example.com"');
  const viewer = page("viewer");
  expect(viewer).toContain("Deal: renewal");
  expect(viewer).not.toContain("Actions for");
});

test("without the sender's own country, the page says so once rather than on every Person", () => {
  const noCountry = { ...data, senderCountry: null, people: data.people.map((x) => ({ ...x, warnings: [...x.warnings, "sender_country_missing" as const] })) };
  const html = renderToString(withQueries(createElement(Outreach, { workspaceId: W, role: "viewer", initial: { data: noCountry, boxes: [] } })));
  expect(html.split("add your own country under Who is sending")).toHaveLength(2);
  expect(html).toContain("To check: UK sole traders and partnerships usually need consent.");
});

test("a basis past its end date says it has ended, not that it runs until then", () => {
  const r = { country: "US", basis: "consent", entityType: "unknown", expiresAt: "2020-01-01T00:00:00.000Z" };
  expect(recordWords(r, new Date("2026-11-02"))).toBe("US, Consent, ended 2020-01-01, so no cold or marketing email");
  expect(recordWords(r, new Date("2019-06-01"))).toBe("US, Consent, until 2020-01-01");
});

test("a newsletter subscriber says so, and nobody else does", () => {
  const html = page("viewer");
  expect(html.match(/>Newsletter subscriber</g)).toHaveLength(1);
  expect(html).toContain("so no cold email without your yes");
});

test("a viewer reads and can't write", () => {
  const html = page("viewer");
  expect(html).toContain("kim@example.com");
  expect(html).not.toContain("Add a Person");
  expect(html).not.toContain("Actions for");
});

test("the pause says what it does in both positions", () => {
  expect(renderToString(createElement(PauseAll, { workspaceId: W, paused: false }))).toContain("Pause all sending");
  expect(renderToString(createElement(PauseAll, { workspaceId: W, paused: true }))).toContain("Sending is paused");
});

test("touches outside Direx: an editor logs and removes them, a viewer only reads", () => {
  const people = data.people.map(({ id, email }) => ({ id, email }));
  const touches = [
    { id: "00000000-0000-4000-8000-0000000000t1", channel: "call", direction: "outbound", occurredAt: "2026-11-05T10:00:00.000Z", source: "manual", canDelete: true },
    { id: "00000000-0000-4000-8000-0000000000t2", channel: "linkedin", direction: "inbound", occurredAt: "2026-11-04T10:00:00.000Z", source: "manual", canDelete: false },
  ];
  const view = (canEdit: boolean) => renderToString(withQueries(createElement(Touches, { workspaceId: W, people, canEdit, initial: { personId: people[0]!.id, touches } })));
  const edit = view(true);
  expect(edit).toContain("Log it");
  expect(edit).toContain(">Person<");
  expect(edit).toContain("Save profile");
  expect(edit).toContain("They replied");
  expect(edit).toContain("Call, sent");
  expect(edit).toContain("LinkedIn message, received");
  expect(edit.match(/>Remove</g)).toHaveLength(1);
  const read = view(false);
  expect(read).toContain("Call, sent");
  expect(read).not.toContain("Log it");
  expect(read).not.toContain("Save profile");
  expect(read).not.toContain(">Remove<");
  // From one Person's row there is nobody to pick.
  expect(renderToString(withQueries(createElement(Touches, { workspaceId: W, people: people.slice(0, 1), canEdit: true, initial: { personId: people[0]!.id, touches } })))).not.toContain(">Person<");
});

test("only an Owner can undo an opt-out read from a reply, from the row menu", async () => {
  // An opted-out row has no menu for anyone but its Owner, who sees Reply misread? there.
  expect(page("owner")).toContain('aria-label="Actions for said@example.com"');
  expect(page("owner")).not.toContain('aria-label="Actions for gone@example.com"');
  expect(page("viewer")).not.toContain("Actions for said@example.com");
  const post = vi.spyOn(api, "POST").mockResolvedValue({ error: { error: "nothing_to_undo" } } as never);
  expect(await undoOptOut(W, "p", "misread")).toBe("nothing_to_undo");
  expect(post.mock.calls[0]![0]).toBe("/api/w/{workspaceId}/outreach/people/{personId}/undo-opt-out");
  expect(post.mock.calls[0]![1]).toMatchObject({ body: { reason: "misread" } });
  vi.restoreAllMocks();
});

test("each action calls its endpoint", async () => {
  const post = vi.spyOn(api, "POST").mockResolvedValue({ data: {} } as never);
  const put = vi.spyOn(api, "PUT").mockResolvedValue({ data: {} } as never);
  expect(await addPerson(W, { email: "a@b.co", country: "US", basis: "consent", evidence: "form" })).toEqual({ error: null, updated: false });
  expect(post.mock.calls[0]![0]).toBe("/api/w/{workspaceId}/outreach/people");
  expect(await writeEmail(W, { personId: "p", credentialId: "c", touchClass: "cold", subject: "s", text: "t" })).toBeNull();
  expect(post.mock.calls[1]![0]).toBe("/api/w/{workspaceId}/outreach/emails");
  expect(await setPaused(W, true)).toBeNull();
  expect(put.mock.calls[0]![0]).toBe("/api/w/{workspaceId}/outreach/pause");
  expect(await logTouch(W, "p", { channel: "call", direction: "outbound", occurredAt: "2026-11-05T10:00:00.000Z" })).toBeNull();
  expect(post.mock.calls[2]![0]).toBe("/api/w/{workspaceId}/outreach/people/{personId}/outside-touches");
  expect(await addProfile(W, "p", { kind: "x", url: "@kim" })).toBeNull();
  expect(post.mock.calls[3]![0]).toBe("/api/w/{workspaceId}/outreach/people/{personId}/profiles");
  const del = vi.spyOn(api, "DELETE").mockResolvedValue({ error: { error: "too_late" } } as never);
  expect(await removeTouch(W, "p", "t")).toBe("too_late");
  expect(del.mock.calls[0]![0]).toBe("/api/w/{workspaceId}/outreach/people/{personId}/outside-touches/{id}");
  vi.restoreAllMocks();
});

test("the CRM webhook card: not on People, the secret shown once, and each button calls its endpoint", async () => {
  expect(page("owner")).not.toContain("Deals in another CRM");
  expect(page("owner")).toContain("Settings, Who is sending");
  const hook = { id: "00000000-0000-4000-8000-0000000000bb", path: `/api/hooks/holds/${W}/bb`, createdAt: "2026-11-08T00:00:00.000Z" };
  const made = renderToString(withQueries(createElement(HoldHook, { workspaceId: W, initial: { hook, shown: { id: hook.id, path: hook.path, secret: "s3cr3t" } } })));
  expect(made).toContain(hook.path);
  expect(made).toContain("s3cr3t");
  expect(made).toContain("won&#x27;t show it again");
  expect(renderToString(withQueries(createElement(HoldHook, { workspaceId: W, initial: { hook } })))).not.toContain("Secret:");

  const post = vi.spyOn(api, "POST").mockResolvedValueOnce({ data: { ...hook, secret: "s" } } as never).mockResolvedValueOnce({ error: { error: "step_up_required" } } as never);
  expect(await makeHoldHook(W)).toMatchObject({ secret: "s" });
  expect(await makeHoldHook(W, hook.id)).toBe("step_up_required");
  expect(post.mock.calls.map((c) => c[0])).toEqual(["/api/w/{workspaceId}/outreach/hold-hook", "/api/w/{workspaceId}/outreach/hold-hook/{hookId}/rotate"]);
  vi.restoreAllMocks();
});
