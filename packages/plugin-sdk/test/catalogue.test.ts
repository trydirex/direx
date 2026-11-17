// SPDX-License-Identifier: MIT
// The query catalogue (ADR 0028 rule 001): every name has a versioned input and a strict output,
// the agent query keeps its own narrower input, and a plugin author gets schemas without agent text.
import { expect, test } from "vitest";
import { effectSchemas, querySchemas, type EffectName, type QueryName } from "../src/index";
import * as host from "../src/host";
import { AGENT_QUERIES, CATALOGUE, PROVIDER_KINDS, QUERY_NAMES, queryEntry } from "../src/host";

const skip = { from: "a@b.example", subject: "Placement", after: 0, before: 1 };
/** One answer each entry accepts, and one input. */
const SAMPLES: { [N in QueryName]: { input: unknown; output: unknown } } = {
  "mail.from": { input: { email: "ann@b.example", skip: [skip] }, output: { events: [{ eventId: "1", data: { anything: true } }] } },
  "mailbox.profile": { input: null, output: { emailAddress: "me@b.example", hasSent: true } },
  "mailbox.probe_read": { input: { actionId: "0b5e-41", subject: "Check 1" }, output: { found: true, folder: "junk", headers: "From: x", text: "t", html: null } },
  "placement.read": { input: skip, output: { found: true, messageId: null, inbox: true, spam: false, otherTab: false } },
  "email.verify": { input: { email: "ann@b.example" }, output: { result: "deliverable", vendorStatus: "safe", credits: 1, costMicros: 0 } },
  "email.verify_balance": { input: null, output: { remainingCredits: 10 } },
  "search.properties": { input: null, output: [{ siteUrl: "sc-domain:b.example", permissionLevel: "siteOwner" }] },
  "search.analytics": {
    input: { siteUrl: "sc-domain:b.example", startDate: "2026-10-01", endDate: "2026-10-28", dimensions: ["query", "page"], rowLimit: 10, startRow: 0 },
    output: { rows: [{ keys: ["q", "https://b.example/"], clicks: 1, impressions: 10, ctr: 0.1, position: 4 }] },
  },
  "newsletter.subscribers": { input: { listId: "l1" }, output: { subscribers: [{ email: "a@b.co", state: "subscribed", createdAt: "2026-11-04T20:29:05Z" }], nextCursor: null } },
  "newsletter.profile": { input: { listId: "l1" }, output: { listName: "Weekly", subscriberCount: 3, canSend: true } },
  "newsletter.stats": { input: { issueId: "26803362" }, output: { recipients: 3, delivered: 3, clicks: 1, unsubscribes: 0, opens: 2 } },
  "newsletter.lists": { input: {}, output: [{ id: "l1", name: "Weekly", subscriberCount: 3 }] },
  "social.identity": { input: null, output: { accountId: "1", accountLabel: "@ann", targets: [{ id: "p1", name: "Page", type: "page" }] } },
  "social.health": { input: null, output: { ok: false, reason: "auth" } },
  "docs.sources": { input: { kind: "database" }, output: { pages: [{ id: "p1", title: "Plan", url: null, editedAt: null }], more: false } },
  "docs.page_text": { input: { pageId: "p1" }, output: { title: "Plan", text: "Hello", cut: false } },
  "docs.rows": {
    input: { sourceId: "s1", cursor: "c" },
    output: { title: "Calendar", columns: [{ name: "Status", id: "st", type: "status", options: ["Done"], choices: [{ id: "o1", name: "Done" }] }], rows: [{ id: "r1", editedAt: null, values: { Status: "Done", Tags: ["a"], Date: null } }], next: null },
  },
};

test("the catalogue holds every query a manifest may declare, each versioned", () => {
  expect(Object.keys(CATALOGUE).sort()).toEqual([...QUERY_NAMES].sort());
  expect(Object.keys(SAMPLES).sort()).toEqual([...QUERY_NAMES].sort());
  for (const [name, e] of Object.entries(CATALOGUE)) {
    expect(e.name, name).toBe(name);
    expect(e.version, name).toBe(1);
  }
  expect(queryEntry("mail.from")).toBe(CATALOGUE["mail.from"]);
  expect(queryEntry("crm.contacts")).toBeUndefined();
  expect(queryEntry("toString")).toBeUndefined();
});

test.each(Object.entries(SAMPLES))("%s takes its input and its answer, and refuses an answer with a field it doesn't know", (name, s) => {
  const e = queryEntry(name)!;
  expect(e.input.safeParse(s.input).success).toBe(true);
  expect(e.output.safeParse(s.output).success).toBe(true);
  const extra = Array.isArray(s.output) ? [{ ...s.output[0], extra: 1 }] : { ...(s.output as object), extra: 1 };
  expect(e.output.safeParse(extra).success).toBe(false);
});

test("where first-party providers differ, the entry takes the union and the stricter input", () => {
  // IMAP reports hasSent and Gmail doesn't; Gmail needs the probe's subject, IMAP takes it.
  expect(CATALOGUE["mailbox.profile"].output.safeParse({ emailAddress: "me@b.example" }).success).toBe(true);
  expect(CATALOGUE["mailbox.profile"].output.safeParse({ emailAddress: null }).success).toBe(false);
  expect(CATALOGUE["mailbox.probe_read"].input.safeParse({ actionId: "a1" }).success).toBe(false);
  expect(CATALOGUE["mailbox.probe_read"].input.safeParse({ actionId: "a1", subject: "two\nlines" }).success).toBe(false);
  expect(CATALOGUE["mailbox.probe_read"].input.safeParse({ actionId: "a".repeat(201), subject: "s" }).success).toBe(false);
  // A tool with one list ignores the profile's input, so none is fine.
  expect(CATALOGUE["newsletter.profile"].input.safeParse(null).success).toBe(true);
  expect(CATALOGUE["newsletter.profile"].input.safeParse({ listId: "" }).success).toBe(false);
  expect(CATALOGUE["search.analytics"].input.safeParse({ siteUrl: "x", startDate: "2026-10-01", endDate: "2026-10-02", dimensions: ["query", "query"] }).success).toBe(false);
});

test("mail.from's code call takes a skip list; the model's input stays the address alone", () => {
  const e = CATALOGUE["mail.from"];
  expect(e.input.safeParse({ email: "ann@b.example", skip: [skip] }).success).toBe(true);
  expect(e.input.safeParse({ email: "ann (x)@b.example" }).success).toBe(false);
  expect(e.agent.input.safeParse({ email: "ann@b.example", skip: [skip] }).success).toBe(false);
  const [agent] = AGENT_QUERIES;
  expect(AGENT_QUERIES).toHaveLength(1);
  expect(agent).toMatchObject({ name: "mail.from", version: 1, scope: "person_address_in_run", input: e.agent.input, output: e.output, description: e.agent.description });
});

test("a plugin author gets a query's schemas and no agent text", () => {
  const s = querySchemas("mail.from");
  expect(Object.keys(s).sort()).toEqual(["input", "output"]);
  expect(s.input).toBe(CATALOGUE["mail.from"].input);
});

test("each provider kind names capabilities, its queries all in the catalogue", () => {
  for (const [kind, needed] of Object.entries(PROVIDER_KINDS)) {
    expect(needed.length, kind).toBeGreaterThan(1);
    for (const [k, name] of needed) if (k === "query") expect(QUERY_NAMES.has(name), name).toBe(true);
  }
});

test("the triggers core reads by name each have versioned event data, strict on what core reads", () => {
  const { TRIGGER_NAMES, TRIGGERS, triggerEntry } = host;
  expect([...TRIGGER_NAMES].sort()).toEqual(["email.received", "mail.sent"]);
  expect(triggerEntry("email.received")).toBe(TRIGGERS["email.received"]);
  expect(triggerEntry("behave.feed")).toBeUndefined();
  expect(triggerEntry("toString")).toBeUndefined();
  const headers = { from: "Ann <a@b.example>", subject: "Re: Hi", date: "", inReplyTo: "<1@x>", references: "<1@x>" };
  const received = TRIGGERS["email.received"].data;
  // Gmail's fields, then IMAP's, which has no Gmail ids and no Authentication-Results.
  expect(received.safeParse({ kind: "message", gmailId: "g1", threadId: "t1", labelIds: ["INBOX"], bounce: false, autoSubmitted: "", dsn: null, headers: { ...headers, to: "", cc: "", messageId: "<2@x>", authenticationResults: "mx.google.com; dkim=pass" }, text: "Thanks" }).success).toBe(true);
  expect(received.safeParse({ kind: "message", bounce: true, autoSubmitted: "auto-replied", dsn: { recipients: [{ email: "x@b.example", status: "5.1.1" }] }, headers: { ...headers, to: "", cc: "", messageId: "" }, text: "" }).success).toBe(true);
  // A field core reads, missing or of the wrong type, or one no Mailbox sends, is refused.
  for (const bad of [{ headers, text: 1 }, { headers: { ...headers, inReplyTo: undefined }, text: "" }, { headers, text: "", extra: 1 }, { headers: { ...headers, extra: 1 }, text: "" }, { headers, text: "", dsn: { recipients: [{ email: "x" }] } }]) {
    expect(received.safeParse(bad).success).toBe(false);
  }
  const sent = TRIGGERS["mail.sent"].data;
  const s = { messageId: "<3@x>", recipients: ["kim@b.example"], sentAt: 1, xDirexAction: null, listUnsubscribe: null, precedence: null };
  expect(sent.safeParse(s).success).toBe(true);
  for (const bad of [{ ...s, recipients: "x" }, { ...s, sentAt: undefined }, { ...s, recipients: Array(1001).fill("a@b") }, { ...s, extra: 1 }]) expect(sent.safeParse(bad).success).toBe(false);
});

const mail = { to: ["kim@b.example", { name: "Ann", address: "ann@b.example" }], subject: "Hi", text: "Hello", listUnsubscribe: "https://b.example/u/1" };
const media = { mediaId: "0b5e4c1e-8d0a-4f6e-9a55-6f9a1e2b3c4d", sha256: "a".repeat(64), bytes: 10, contentType: "image/png" };
const post = { text: "Hello", followUps: ["More"], target: null, media: [media], alt: ["A chart"] };
const row = { pageId: "p1", statusPropertyId: "st", statusType: "status", optionId: "o1", lastOptionId: null, url: "https://b.example/p" };
const issue = { title: "Week 12", previewText: "This week", html: "<p>Hi</p>", listId: "l1" };
/** One input each effect takes, and, where Direx reads the spec, a spec as the first-party plugin returns it. */
const EFFECT_SAMPLES: { [N in EffectName]: { input: unknown; spec?: unknown } } = {
  "email.send": { input: mail, spec: { ...mail, boundary: "0".repeat(32) } },
  "mailbox.probe": { input: mail, spec: { ...mail, boundary: "0".repeat(32) } },
  "placement.join": { input: { ...mail, inReplyTo: "<1@x>", references: ["<1@x>"] }, spec: { ...mail, boundary: "0".repeat(32), threadId: "t1" } },
  "placement.send": { input: mail, spec: { ...mail, boundary: "0".repeat(32) } },
  "placement.report": { input: mail, spec: { ...mail, boundary: "0".repeat(32) } },
  "placement.archive": { input: { messageId: "<1@x>" } },
  "newsletter.draft": { input: issue },
  "newsletter.send": { input: { issueId: "1", at: "2026-11-20T09:00:00Z" } },
  "newsletter.publish": { input: { ...issue, at: "2026-11-20T09:00:00Z", markdown: "Hi", audience: { kind: "newsletter_list" } }, spec: { ...issue, at: "2026-11-20T09:00:00Z", markdown: "Hi" } },
  "newsletter.cancel": { input: { issueId: "1" } },
  "social.publish": { input: { ...post, links: true }, spec: post },
  "docs.row.update": { input: row, spec: row },
};

test("each effect core prepares by name has a versioned input, and a spec where Direx reads one", () => {
  const { EFFECTS, EFFECT_NAMES, effectEntry } = host;
  expect(Object.keys(EFFECTS).sort()).toEqual([...EFFECT_NAMES].sort());
  expect(Object.keys(EFFECT_SAMPLES).sort()).toEqual([...EFFECT_NAMES].sort());
  for (const [name, e] of Object.entries(EFFECTS)) {
    expect(e.name, name).toBe(name);
    expect(e.version, name).toBe(1);
  }
  expect(effectEntry("crm.write")).toBeUndefined();
  expect(effectEntry("toString")).toBeUndefined();
  expect(effectSchemas("social.publish")).toBe(EFFECTS["social.publish"]);
});

test.each(Object.entries(EFFECT_SAMPLES))("%s takes its input and refuses one with a field it doesn't know; its spec may carry more", (name, s) => {
  const e = host.effectEntry(name)!;
  expect(e.input.safeParse(s.input).success).toBe(true);
  expect(e.input.safeParse({ ...(s.input as object), extra: 1 }).success).toBe(false);
  expect(e.spec?.safeParse(s.spec).success ?? s.spec === undefined).toBe(true);
  if (e.spec) expect(e.spec.safeParse({ ...(s.spec as object), extra: 1 }).success).toBe(true);
});

test("a message's header fields are one line, and its spec must give what Direx reads", () => {
  const { EFFECTS } = host;
  expect(EFFECTS["email.send"].input.safeParse({ ...mail, subject: "two\nlines" }).success).toBe(false);
  expect(EFFECTS["email.send"].input.safeParse({ ...mail, to: [] }).success).toBe(false);
  expect(EFFECTS["newsletter.draft"].input.safeParse({ ...issue, title: "Week\n12" }).success).toBe(false);
  expect(EFFECTS["email.send"].spec.safeParse({ to: mail.to, subject: "Hi" }).success).toBe(false);
  expect(EFFECTS["email.send"].spec.safeParse({ ...mail, touch: { personId: "p1", touchClass: "cold" } }).success).toBe(false);
  expect(EFFECTS["social.publish"].spec.safeParse({ ...post, followUps: "More" }).success).toBe(false);
  expect(EFFECTS["docs.row.update"].spec.safeParse({ url: "https://b.example/p" }).success).toBe(false);
});

test("a stored spec reads field by field, and a Touch whole or one field at a time", () => {
  const { storedSpec, touchField, touchOf } = host;
  const personId = crypto.randomUUID();
  const touch = { personId, touchClass: "cold" };
  // A field that is missing or doesn't fit is left out; the others still read.
  expect(storedSpec("email.send", { ...mail, subject: 5, touch, boundary: "b" })).toEqual({ to: mail.to, text: "Hello", listUnsubscribe: mail.listUnsubscribe, touch });
  expect(storedSpec("social.publish", { text: "Hi", followUps: [1] })).toEqual({ text: "Hi" });
  expect(storedSpec("docs.row.update", null)).toEqual({});
  expect(storedSpec("newsletter.publish", "not a spec")).toEqual({});
  expect(touchOf({ touch })).toEqual(touch);
  expect(touchOf({ touch: { ...touch, extra: 1 } })).toBeUndefined();
  expect(touchOf({ touch: { personId } })).toBeUndefined();
  expect(touchOf(null)).toBeUndefined();
  expect(touchField({ touch: { personId } }, "personId")).toBe(personId);
  expect(touchField({ touch: { personId: "p1", touchClass: "service" } }, "touchClass")).toBe("service");
  expect(touchField({ touch: { personId: "p1" } }, "personId")).toBeUndefined();
  expect(touchField({}, "touchClass")).toBeUndefined();
});
