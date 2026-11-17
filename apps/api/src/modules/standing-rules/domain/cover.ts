// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the one answer to "does this rule cover this Action?", used at match, claim and dispatch.
export type RuleFact = { id: string; version: string };
export type SnapshotEntry = { kind: string; id: string; version: string };

/**
 * One drafting agent as it ran: which definition, which prompt, which route, and the digest of the
 * Agent lessons it carried. A part recorded before lessons existed carries none, the same as "".
 */
export type ProducerPart = { agent: string; definitionVersion: number; promptDigest: string; routeHash: string; lessons?: string };
/** What an agent-written rule was granted on: the reader and writer in use at grant. */
export type RuleProducer = { reader: ProducerPart | null; writer: ProducerPart };
/** The writer a rule trusted, in words a person reads: never the agent's id. */
export const writerWords = (w: ProducerPart) => `Direx's email writer, version ${w.definitionVersion}`;

export type RuleScope = {
  status: string;
  expiresAt: Date;
  /** Absent on rows from before agent-written rules, which are all template rules. */
  mode?: string;
  capability: string;
  touchClass: string;
  campaignId: string;
  stepKey: string;
  templateRevision: number | null;
  facts: RuleFact[];
  capabilityHash: string;
  peopleAsOf: Date;
  dailyCap: number | null;
  producer?: unknown;
  allowedFacts?: RuleFact[] | null;
  outsideContent?: boolean | null;
};

/** What an agent-written rule needs to know about one draft. Absent for text a person wrote. */
export type Drafted = {
  /** The producer record stored with the draft, as read from the database. */
  producer: unknown;
  checksPassed: boolean;
  blockingWarnings: number;
  /** The campaign's answer now. */
  outsideContent: boolean;
  gateOpen: boolean;
};

export type Subject = {
  capability: string;
  dedupe: string;
  touchClass: string | null;
  campaignId: string;
  stepKey: string;
  snapshot: SnapshotEntry[];
  personJoinedAt: Date;
  clean: boolean;
  granterMayGrant: boolean;
  /** Kinds of snapshot entry whose live version moved. The ledger compares these itself at claim and dispatch. */
  movedKinds: readonly string[];
  /** Null once this Action has been counted. */
  usedToday: number | null;
  drafted?: Drafted;
};

const WORDS = {
  not_active: "rule isn't active",
  expired: "rule expired",
  granter_lost_permission: "granter can no longer create standing rules",
  blind: "this can't be checked after sending",
  other_capability: "sends a different way",
  other_touch_class: "a different kind of email",
  other_step: "a different campaign step",
  template_changed: "template changed",
  fact_changed: "a cited fact changed",
  capability_changed: "how it sends changed",
  person_added_later: "this Person joined after the rule was granted",
  not_clean: "has a warning",
  over_cap: "daily cap reached",
  other_producer: "written by a different drafter version",
  fact_moved: "a Fact it used changed after it was written",
  checks_not_passed: "a draft check failed or didn't run",
  blocking_warning: "has a warning",
  outside_content_changed: "the campaign's website question changed",
  gate_closed: "safety results missing for this drafter",
} as const;

export type NotCovered = keyof typeof WORDS;
export const notCoveredWords = (why: NotCovered) => WORDS[why];

/** These stop the rule itself, until a person re-confirms it. The rest only stop this Action. */
const SUSPENDS: readonly NotCovered[] = ["granter_lost_permission", "fact_changed", "capability_changed", "outside_content_changed"];
export const suspendsRule = (why: NotCovered) => SUSPENDS.includes(why);

const key = (f: RuleFact) => `${f.id}@${f.version}`;
const sameFacts = (a: RuleFact[], b: RuleFact[]) => {
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((k, i) => k === right[i]);
};

const isPart = (p: unknown): p is ProducerPart => {
  const o = p as Partial<ProducerPart> | null;
  return !!o && typeof o.agent === "string" && typeof o.definitionVersion === "number" && typeof o.promptDigest === "string" && typeof o.routeHash === "string";
};
const samePart = (a: ProducerPart, b: ProducerPart) =>
  a.agent === b.agent && a.definitionVersion === b.definitionVersion && a.promptDigest === b.promptDigest && a.routeHash === b.routeHash && (a.lessons ?? "") === (b.lessons ?? "");

/**
 * The draft came from the writer the rule was granted on, for this step, using only Fact versions the
 * rule allows. A draft for a Person with no page has no reader, and nothing on a page steered it.
 */
export function sameProducer(rule: Pick<RuleScope, "producer" | "allowedFacts" | "campaignId" | "stepKey">, drafted: unknown): boolean {
  const granted = rule.producer as Partial<RuleProducer> | null | undefined;
  const d = drafted as { reader?: unknown; writer?: unknown; factVersions?: unknown; campaignId?: unknown; stepKey?: unknown } | null;
  if (!granted || !isPart(granted.writer) || !d || !isPart(d.writer) || !samePart(granted.writer, d.writer)) return false;
  if (d.campaignId !== rule.campaignId || d.stepKey !== rule.stepKey) return false;
  if (d.reader !== null && !(isPart(d.reader) && isPart(granted.reader) && samePart(granted.reader, d.reader))) return false;
  if (!Array.isArray(d.factVersions)) return false;
  const allowed = new Set((rule.allowedFacts ?? []).map(key));
  return d.factVersions.every((f: { id?: unknown; version?: unknown }) => typeof f?.id === "string" && allowed.has(`${f.id}@${String(f.version)}`));
}

export function whyNotCovered(rule: RuleScope, s: Subject, now: Date): NotCovered | null {
  if (rule.status !== "active") return "not_active";
  if (rule.expiresAt <= now) return "expired";
  if (!s.granterMayGrant) return "granter_lost_permission";
  if (s.dedupe === "blind") return "blind";
  if (s.capability !== rule.capability) return "other_capability";
  if (s.touchClass !== rule.touchClass) return "other_touch_class";
  if (s.campaignId !== rule.campaignId || s.stepKey !== rule.stepKey) return "other_step";
  if (rule.mode === "agent_written") return whyNotCoveredDrafted(rule, s);
  const template = s.snapshot.find((e) => e.kind === "template");
  if (!template || template.id !== `campaign:${rule.campaignId}:step:${rule.stepKey}` || template.version !== String(rule.templateRevision) || s.movedKinds.includes("template")) return "template_changed";
  const facts = s.snapshot.filter((e) => e.kind === "fact").map((e) => ({ id: e.id, version: e.version }));
  if (!sameFacts(facts, rule.facts) || s.movedKinds.includes("fact")) return "fact_changed";
  const capability = s.snapshot.find((e) => e.kind === "capability");
  if (capability?.version !== rule.capabilityHash || s.movedKinds.includes("capability")) return "capability_changed";
  if (s.personJoinedAt > rule.peopleAsOf) return "person_added_later";
  if (!s.clean) return "not_clean";
  if (s.usedToday !== null && rule.dailyCap !== null && s.usedToday >= rule.dailyCap) return "over_cap";
  return null;
}

// No one reads these, so the drafter, its checks and the campaign's answer stand in for a person's look.
function whyNotCoveredDrafted(rule: RuleScope, s: Subject): NotCovered | null {
  const d = s.drafted;
  if (!d || s.snapshot.some((e) => e.kind === "template")) return "other_producer";
  if (d.outsideContent !== rule.outsideContent) return "outside_content_changed";
  if (!d.gateOpen) return "gate_closed";
  if (!sameProducer(rule, d.producer)) return "other_producer";
  if (s.movedKinds.includes("fact")) return "fact_moved";
  const capability = s.snapshot.find((e) => e.kind === "capability");
  if (capability?.version !== rule.capabilityHash || s.movedKinds.includes("capability")) return "capability_changed";
  if (s.personJoinedAt > rule.peopleAsOf) return "person_added_later";
  if (!d.checksPassed) return "checks_not_passed";
  if (d.blockingWarnings > 0) return "blocking_warning";
  return null;
}
