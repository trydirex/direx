// SPDX-License-Identifier: AGPL-3.0-only
// The text of Placement checks: every library entry and a template step, with nothing in them that
// names a Workspace, a Person or a way to unsubscribe anyone.
import { expect, test } from "vitest";
import { contentProbe, plainEntry, plainProbe, plainSubject, renderPlain } from "./application/render";
import { LIBRARY, LIBRARY_APPROVED } from "./domain/library";

const WORKSPACE = "3b6f1a2e-5c4d-4e8f-9a1b-2c3d4e5f6a7b";
const sender = { address: "Founder@Contosohq.example", name: "Sam Carter", postalAddress: "1 Example Street, London" };
const RECEIVER = "member@circle.test";

/** What no Placement check may carry. */
function expectClean(text: string) {
  for (const banned of ["/api/unsubscribe/", WORKSPACE, "List-Unsubscribe", "X-Direx-Action", "Unsubscribe:", "{sender}", "{{", "http"]) expect(text).not.toContain(banned);
}
/** The footer a real send has, with no unsubscribe link. */
function expectFooter(text: string) {
  expect(text.endsWith(`--\n${sender.name}\n${sender.postalAddress}\nReply "stop" and I won't email you again.`)).toBe(true);
}

test("the approved library renders a plain check", () => {
  expect(LIBRARY_APPROVED).toBe(true);
  expect(plainProbe(sender, RECEIVER, 0).subject).toBeTruthy();
});

test("a pair goes through every library entry once before any repeats, and every entry renders clean", () => {
  expect(LIBRARY).toHaveLength(60);
  for (const cycle of [0, 1, 7]) {
    const seen = new Set<number>();
    for (let i = 0; i < 60; i++) seen.add(plainEntry(sender.address, RECEIVER, cycle * 60 + i));
    expect(seen.size).toBe(60);
  }
  const subjects = new Set<string>();
  for (let seq = 0; seq < 60; seq++) {
    const p = renderPlain(sender, RECEIVER, seq);
    subjects.add(p.subject);
    expect(p.text).toContain(sender.name);
    expectClean(p.subject);
    expectClean(p.text);
    expectFooter(p.text);
    // The receiver finds the check by the same subject, from the pair and its count alone, whatever the case of the addresses.
    expect(plainSubject(sender.address.toLowerCase(), RECEIVER.toUpperCase(), seq)).toBe(p.subject);
  }
  expect(subjects.size).toBe(60);
});

test("the order depends on the pair, and the next run of 60 is shuffled afresh", () => {
  const order = (from: string, receiver: string, start = 0) => Array.from({ length: 60 }, (_, i) => plainEntry(from, receiver, start + i)).join();
  expect(order(sender.address, RECEIVER)).toBe(order(sender.address, RECEIVER));
  expect(order(sender.address, RECEIVER)).not.toBe(order(sender.address, "other@circle.test"));
  expect(order(sender.address, RECEIVER)).not.toBe(order("other@circle.test", RECEIVER));
  expect(order(sender.address, RECEIVER)).not.toBe(order(sender.address, RECEIVER, 60));
  expect(() => plainEntry(sender.address, RECEIVER, -1)).toThrow();
});

const step = {
  subject: "{{firstName}}, a question for {{company}}",
  text: "Hi {{firstName}},\n\nWe built a checklist for {{company}}: {{steps.page.url}}\n\n{{senderName}}",
};

test("a content check fills every merge field with the placeholders and the real sender, never a Person's values", () => {
  const r = contentProbe(step, { page: "https://contosohq.example/checklist" }, sender);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.probe.subject).toBe("Alex, a question for Example Ltd");
  expect(r.probe.text).toContain("Hi Alex,\n\nWe built a checklist for Example Ltd: https://contosohq.example/checklist\n\nSam Carter");
  for (const real of ["Kim", "Acme"]) expect(`${r.probe.subject}${r.probe.text}`).not.toContain(real);
  const tail = r.probe.text.slice(r.probe.text.indexOf("\n--\n") + 1);
  expectClean(tail);
  expectFooter(tail);
  for (const banned of ["/api/unsubscribe/", WORKSPACE, "List-Unsubscribe", "X-Direx-Action"]) expect(r.probe.text).not.toContain(banned);
});

test("a content check whose step URL is not known yet is not rendered", () => {
  expect(contentProbe(step, {}, sender)).toEqual({ ok: false, missing: ["steps.page.url"] });
});
