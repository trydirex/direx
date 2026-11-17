// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { optOutFooter } from "./domain/footer";
import { compareProbe, type Received, type Sent } from "./domain/header-check";

const URL_ = "https://direx.example/api/unsubscribe/w1/probe-a1";
const who = { senderName: "Sam at Acme", postalAddress: "1 Main St" };
const footer = optOutFooter({ ...who, unsubscribeUrl: URL_ });
const body = `This is a test from Direx.\n\n${footer}`;
const sent: Sent = { unsubscribeUrl: URL_, text: body, footer, messageId: "<a1@direx.example>" };
const SIGNED = "DKIM-Signature: v=1; a=rsa-sha256; d=acme.example; s=s1;\r\n\th=from:to:subject:list-unsubscribe:\r\n\tlist-unsubscribe-post:message-id; bh=x; b=y";
const kept = [SIGNED, "Message-ID: <a1@direx.example>", `List-Unsubscribe: <${URL_}>`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click", "X-Direx-Action: a1"].join("\r\n");
const got = (headers: string, over: Partial<Received> = {}): Received => ({ headers, text: body, html: null, ...over });
const without = (name: string) => kept.split("\r\n").filter((l) => !l.startsWith(name)).join("\r\n");

test("our link, one-click and signature arrive as sent: passed, no warnings", () => {
  expect(compareProbe(sent, got(kept))).toEqual({ state: "passed", failures: [], warnings: [] });
});

test("a folded List-Unsubscribe still matches", () => {
  expect(compareProbe(sent, got(kept.replace(`List-Unsubscribe: <${URL_}>`, `List-Unsubscribe:\r\n <${URL_}>`))).state).toBe("passed");
});

test("AgentMail's rewrite, as received on 2026-11-04, makes the Mailbox replies only", () => {
  const agentmail = [
    "Message-ID: <010001a1a9cf2926-c00f-000000@email.amazonses.com>",
    "X-Direx-Action: a1",
    "List-Unsubscribe:\r\n <https://api.agentmail.to/v0/unsubscribe/redacted>",
    "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
  ].join("\r\n");
  const v = compareProbe(sent, got(agentmail, { text: `${body}\n\n--\nSent via AgentMail` }));
  expect(v.state).toBe("replies_only");
  expect(v.failures).toEqual(["unsubscribe_link_replaced", "not_signed"]);
  expect(v.warnings).toEqual(["message_id_replaced", "text_added"]);
});

test.each([
  ["our URL embedded in theirs", `List-Unsubscribe: <https://relay.example/u?to=${encodeURIComponent(URL_)}>`],
  ["an extra URI beside ours", `List-Unsubscribe: <${URL_}>, <https://relay.example/u/1>`],
  ["a mailto beside ours", `List-Unsubscribe: <mailto:u@relay.example>, <${URL_}>`],
  ["a second header", `List-Unsubscribe: <${URL_}>\r\nList-Unsubscribe: <https://relay.example/u/1>`],
  ["no angle brackets", `List-Unsubscribe: ${URL_}`],
])("%s fails", (_why, line) => {
  const v = compareProbe(sent, got(kept.replace(`List-Unsubscribe: <${URL_}>`, line)));
  expect(v.failures).toContain("unsubscribe_link_replaced");
  expect(v.state).toBe("replies_only");
});

test.each([
  ["missing", without("List-Unsubscribe-Post")],
  ["wrong value", kept.replace("List-Unsubscribe=One-Click", "List-Unsubscribe=Yes")],
  ["twice", `${kept}\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click`],
])("one-click POST %s fails", (_why, headers) => {
  expect(compareProbe(sent, got(headers)).failures).toEqual(["one_click_missing"]);
});

test.each([
  ["no signature", without("DKIM-Signature")],
  ["a signature not covering the POST header", kept.replace("\tlist-unsubscribe-post:", "\t")],
])("%s fails as not signed", (_why, headers) => {
  expect(compareProbe(sent, got(headers)).failures).toEqual(["not_signed"]);
});

test("with no link sent, the Mailbox passes only if no List-Unsubscribe arrives", () => {
  const plain = optOutFooter({ ...who, unsubscribeUrl: null });
  const s: Sent = { unsubscribeUrl: null, text: `Hi.\n\n${plain}`, footer: plain };
  expect(compareProbe(s, { headers: "Message-ID: <x@y>", text: s.text, html: null })).toEqual({ state: "passed", failures: [], warnings: [] });
  const added = compareProbe(s, { headers: "List-Unsubscribe: <https://relay.example/u/1>", text: s.text, html: null });
  expect(added).toMatchObject({ state: "replies_only", failures: ["unsubscribe_header_added"] });
});

test("a changed footer fails, in the text or in an HTML part", () => {
  expect(compareProbe(sent, got(kept, { text: body.replace(URL_, "https://relay.example/c/1") })).failures).toEqual(["footer_changed"]);
  expect(compareProbe(sent, got(kept, { text: body.replace("Reply", "Write") })).failures).toEqual(["footer_changed"]);
  const html = `<div>This is a test from Direx.</div><div>Reply &quot;stop&quot; and I won&#39;t email you again.<br>Unsubscribe: <a href="https://relay.example/c/1">https://relay.example/c/1</a></div>`;
  expect(compareProbe(sent, got(kept, { html })).failures).toEqual(["footer_changed"]);
});

test("an HTML part that keeps the footer's line and link passes", () => {
  const html = `<div>This is a test from Direx.</div><p>Sam at Acme<br>1 Main St<br>Reply &quot;stop&quot; and I won&#x27;t email you again.<br>Unsubscribe: <a href="${URL_}">${URL_}</a></p>`;
  expect(compareProbe(sent, got(kept, { html })).state).toBe("passed");
});

test("added text only warns, and so does a replaced Message-ID", () => {
  const v = compareProbe(sent, got(kept.replace("<a1@direx.example>", "<other@relay.example>"), { text: `${body}\n\nSent via Relay` }));
  expect(v).toEqual({ state: "passed", failures: [], warnings: ["message_id_replaced", "text_added"] });
});
