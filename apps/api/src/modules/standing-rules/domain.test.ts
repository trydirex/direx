// SPDX-License-Identifier: AGPL-3.0-only
// One block and one allow fixture per condition, plus the near misses.
import { expect, test } from "vitest";
import { sameProducer, suspendsRule, whyNotCovered, type RuleScope, type Subject } from "./domain/cover";

const at = new Date("2026-11-01T00:00:00Z");
const rule: RuleScope = {
  status: "active",
  expiresAt: new Date("2026-12-01T00:00:00Z"),
  capability: "mail/send",
  touchClass: "cold",
  campaignId: "c",
  stepKey: "s",
  templateRevision: 2,
  facts: [{ id: "f", version: "1" }],
  capabilityHash: "h",
  peopleAsOf: at,
  dailyCap: 2,
};
const subject: Subject = {
  capability: "mail/send",
  dedupe: "queryable",
  touchClass: "cold",
  campaignId: "c",
  stepKey: "s",
  snapshot: [
    { kind: "template", id: "campaign:c:step:s", version: "2" },
    { kind: "fact", id: "f", version: "1" },
    { kind: "capability", id: "mail/send", version: "h" },
  ],
  personJoinedAt: at,
  clean: true,
  granterMayGrant: true,
  movedKinds: [],
  usedToday: 1,
};

test("all conditions true: covered, at the cap's last place and once counted", () => {
  expect(whyNotCovered(rule, subject, at)).toBeNull();
  expect(whyNotCovered(rule, { ...subject, usedToday: null }, at)).toBeNull();
});

test.each<[string, Partial<RuleScope>, Partial<Subject>]>([
  ["not_active", { status: "suspended" }, {}],
  ["not_active", { status: "revoked" }, {}],
  ["expired", { expiresAt: at }, {}],
  ["granter_lost_permission", {}, { granterMayGrant: false }],
  ["blind", {}, { dedupe: "blind" }],
  ["other_capability", {}, { capability: "other/send" }],
  ["other_touch_class", {}, { touchClass: "consented_marketing" }],
  ["other_step", {}, { stepKey: "s2" }],
  ["other_step", {}, { campaignId: "c2" }],
  ["fact_changed", {}, { movedKinds: ["fact"] }],
  ["capability_changed", {}, { movedKinds: ["capability"] }],
  ["template_changed", {}, { movedKinds: ["template"] }],
  ["over_cap", {}, { usedToday: 2 }],
])("%s", (why, r, s) => {
  expect(whyNotCovered({ ...rule, ...r }, { ...subject, ...s }, at)).toBe(why);
});

const without = (kind: string) => subject.snapshot.filter((e) => e.kind !== kind);

test("near miss: the same template with a warning", () => {
  expect(whyNotCovered(rule, { ...subject, clean: false }, at)).toBe("not_clean");
});
test("near miss: the same step at the next revision", () => {
  expect(whyNotCovered({ ...rule, templateRevision: 3 }, subject, at)).toBe("template_changed");
});
test("near miss: the same template with a Person added later", () => {
  expect(whyNotCovered(rule, { ...subject, personJoinedAt: new Date(at.getTime() + 1) }, at)).toBe("person_added_later");
});
test("a per-address or hand-edited email has no template entry, so it never matches", () => {
  expect(whyNotCovered(rule, { ...subject, snapshot: without("template") }, at)).toBe("template_changed");
});
test("a cited fact at another version, an extra fact or a missing one doesn't match", () => {
  expect(whyNotCovered(rule, { ...subject, snapshot: [...without("fact"), { kind: "fact", id: "f", version: "2" }] }, at)).toBe("fact_changed");
  expect(whyNotCovered(rule, { ...subject, snapshot: [...subject.snapshot, { kind: "fact", id: "g", version: "1" }] }, at)).toBe("fact_changed");
  expect(whyNotCovered(rule, { ...subject, snapshot: without("fact") }, at)).toBe("fact_changed");
});
test("no capability entry, or another hash, doesn't match", () => {
  expect(whyNotCovered(rule, { ...subject, snapshot: without("capability") }, at)).toBe("capability_changed");
  expect(whyNotCovered({ ...rule, capabilityHash: "other" }, subject, at)).toBe("capability_changed");
});
test("only causes in the rule's own basis suspend it", () => {
  expect(["fact_changed", "capability_changed", "granter_lost_permission"].every((w) => suspendsRule(w as never))).toBe(true);
  expect(["template_changed", "over_cap", "not_clean", "person_added_later"].some((w) => suspendsRule(w as never))).toBe(false);
});

// Agent-written rules: no one reads the words, so the drafter and its checks are the basis.
const writer = { agent: "recipient_writer", definitionVersion: 1, promptDigest: "w", routeHash: "r" };
const reader = { agent: "recipient_reader", definitionVersion: 1, promptDigest: "p", routeHash: "r" };
const agentRule: RuleScope = { ...rule, mode: "agent_written", templateRevision: null, dailyCap: null, producer: { reader, writer }, allowedFacts: [{ id: "f", version: "1" }], outsideContent: true };
const drafted = { producer: { reader, writer, factVersions: [{ id: "f", version: 1 }], campaignId: "c", stepKey: "s" }, checksPassed: true, blockingWarnings: 0, outsideContent: true, gateOpen: true };
const agentSubject: Subject = { ...subject, snapshot: without("template"), clean: false, usedToday: 500, drafted };
const producerWith = (p: object) => ({ ...agentSubject, drafted: { ...drafted, producer: { ...drafted.producer, ...p } } });

test("agent-written: all conditions true, with no cap and an exempt warning that makes it not clean", () => {
  expect(whyNotCovered(agentRule, agentSubject, at)).toBeNull();
});
test("agent-written: a Person with no page has no reader, and is still covered", () => {
  expect(whyNotCovered(agentRule, producerWith({ reader: null }), at)).toBeNull();
});

test.each<[string, Partial<RuleScope>, Partial<Subject>]>([
  ["not_active", { status: "revoked" }, {}],
  ["expired", { expiresAt: at }, {}],
  ["granter_lost_permission", {}, { granterMayGrant: false }],
  ["blind", {}, { dedupe: "blind" }],
  ["other_touch_class", {}, { touchClass: "consented_marketing" }],
  ["other_step", {}, { stepKey: "s2" }],
  ["other_producer", {}, { drafted: undefined }],
  ["outside_content_changed", {}, { drafted: { ...drafted, outsideContent: false } }],
  ["gate_closed", {}, { drafted: { ...drafted, gateOpen: false } }],
  ["fact_moved", {}, { movedKinds: ["fact"] }],
  ["capability_changed", {}, { movedKinds: ["capability"] }],
  ["person_added_later", {}, { personJoinedAt: new Date(at.getTime() + 1) }],
  ["checks_not_passed", {}, { drafted: { ...drafted, checksPassed: false } }],
  ["blocking_warning", {}, { drafted: { ...drafted, blockingWarnings: 1 } }],
])("agent-written: %s", (why, r, s) => {
  expect(whyNotCovered({ ...agentRule, ...r }, { ...agentSubject, ...s }, at)).toBe(why);
});

test("agent-written near misses: the next writer version, another route, another prompt", () => {
  expect(whyNotCovered(agentRule, producerWith({ writer: { ...writer, definitionVersion: 2 } }), at)).toBe("other_producer");
  expect(whyNotCovered(agentRule, producerWith({ writer: { ...writer, routeHash: "other" } }), at)).toBe("other_producer");
  expect(whyNotCovered(agentRule, producerWith({ reader: { ...reader, promptDigest: "other" } }), at)).toBe("other_producer");
});
test("agent-written near misses: a Fact outside the allowed set, another step in the record, a broken record", () => {
  expect(whyNotCovered(agentRule, producerWith({ factVersions: [{ id: "f", version: 2 }] }), at)).toBe("other_producer");
  expect(whyNotCovered(agentRule, producerWith({ stepKey: "s2" }), at)).toBe("other_producer");
  expect(whyNotCovered(agentRule, { ...agentSubject, drafted: { ...drafted, producer: { writer: "recipient_writer" } } }, at)).toBe("other_producer");
  expect(whyNotCovered({ ...agentRule, producer: null }, agentSubject, at)).toBe("other_producer");
});
test("a template rule never covers a per-person draft, and an agent-written rule never covers a template email", () => {
  expect(whyNotCovered(rule, { ...agentSubject, clean: true }, at)).toBe("template_changed");
  expect(whyNotCovered(agentRule, { ...subject, drafted }, at)).toBe("other_producer");
});
test("only a changed campaign answer suspends an agent-written rule; a new drafter stops one Action", () => {
  expect(suspendsRule("outside_content_changed")).toBe(true);
  expect(["other_producer", "fact_moved", "checks_not_passed", "blocking_warning", "gate_closed"].some((w) => suspendsRule(w as never))).toBe(false);
});

test("a writer that carried different lessons is a different producer, and none matches none", () => {
  const writer = { agent: "person_drafter", definitionVersion: 2, promptDigest: "p", routeHash: "r" };
  const rule = { producer: { reader: null, writer }, allowedFacts: [], campaignId: "c", stepKey: "s" };
  const drafted = (lessons?: string) => ({ reader: null, writer: { ...writer, ...(lessons !== undefined && { lessons }) }, factVersions: [], campaignId: "c", stepKey: "s" });
  expect(sameProducer(rule, drafted(""))).toBe(true);
  expect(sameProducer(rule, drafted())).toBe(true);
  expect(sameProducer(rule, drafted("abc"))).toBe(false);
  expect(sameProducer({ ...rule, producer: { reader: null, writer: { ...writer, lessons: "abc" } } }, drafted("abc"))).toBe(true);
});
