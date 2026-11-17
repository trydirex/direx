// SPDX-License-Identifier: AGPL-3.0-only
// Granting and re-confirming a rule over email an agent writes. Its basis is a person's unedited
// approvals of one drafter on this step; the granter always comes from the session.
import { activeRulesForStep, approvedByAPerson, insertRevision, insertRule, lockRule, lockStepRules, updateRule, type RuleRow, type RulesTx } from "../adapters/repo";
import { sameProducer, type ProducerPart, type RuleFact, type RuleProducer, type SnapshotEntry } from "../domain/cover";
import { wordingSigned, type Wording } from "../domain/wording";
import { touchClassOf, type MayGrant } from "./check";
import type { CampaignPort } from "./port";

/** Unedited approvals of one drafter on one step before a rule may cover it. */
export const MIN_UNEDITED_APPROVALS = 5;
const LANGUAGE = "en";

export type AgentGate = { offered: boolean; missing: readonly string[] };
export type AgentRefusal =
  | "forbidden"
  | "two_person_rule"
  | "not_found"
  | "not_per_person"
  | "not_email"
  | "outside_content_off"
  | "gate_closed"
  | "wording_unsigned"
  | "too_few_approvals"
  | "step_has_rule"
  | "bad_expiry"
  | "wording_outdated"
  | "wrong_state"
  | "capability_unavailable";
export type AgentResult = { ok: true; rule: RuleRow } | { ok: false; reason: AgentRefusal; missing?: readonly string[]; count?: number };

export type AgentDeps = {
  port: CampaignPort;
  mayGrant: MayGrant;
  agentGate: () => AgentGate;
  twoPersonRule: (tx: RulesTx) => Promise<boolean>;
  wording: Wording;
};

type DraftProducer = RuleProducer & { factVersions: { id: string; version: number | string }[] };
const partKey = (p: ProducerPart) => JSON.stringify([p.agent, p.definitionVersion, p.promptDigest, p.routeHash, p.lessons ?? ""]);

/**
 * The drafter a rule would rest on, and how many unedited approvals of it a person made. With two
 * writers on record, the newer definition wins, so a rule is never granted on a drafter already replaced.
 */
async function basisFor(d: AgentDeps, tx: RulesTx, campaignId: string, stepKey: string) {
  const approved = await approvedByAPerson(tx, await d.port.actionsIn(tx, campaignId, stepKey));
  const samples: { row: (typeof approved)[number]; producer: DraftProducer }[] = [];
  for (const row of approved) {
    if (((row.snapshot ?? []) as SnapshotEntry[]).some((e) => e.kind === "template")) continue;
    const draft = await d.port.draftOf(tx, row.actionId);
    // An edited draft no longer matches the words its checks read, so it isn't evidence.
    if (draft?.checksPassed) samples.push({ row, producer: draft.producer as DraftProducer });
  }
  let best: { producer: RuleProducer; allowedFacts: RuleFact[]; count: number; sample: (typeof samples)[number] } | null = null;
  const writers = new Map(samples.map((s) => [partKey(s.producer.writer), s.producer.writer]));
  for (const writer of writers.values()) {
    const mine = samples.filter((s) => partKey(s.producer.writer) === partKey(writer));
    const allowedFacts = [...new Map(mine.flatMap((s) => s.producer.factVersions).map((f) => [`${f.id}@${f.version}`, { id: f.id, version: String(f.version) }])).values()];
    const readers: (ProducerPart | null)[] = [...new Map(mine.flatMap((s) => (s.producer.reader ? [[partKey(s.producer.reader), s.producer.reader] as const] : []))).values()];
    for (const reader of readers.length ? readers : [null]) {
      const producer = { reader, writer };
      const count = mine.filter((s) => sameProducer({ producer, allowedFacts, campaignId, stepKey }, s.producer)).length;
      const better = !best || writer.definitionVersion > best.producer.writer.definitionVersion || (writer.definitionVersion === best.producer.writer.definitionVersion && count > best.count);
      if (better) best = { producer, allowedFacts, count, sample: mine[0]! };
    }
  }
  return best;
}

export function agentWritten(d: AgentDeps) {
  /** Everything a grant and a re-confirm both refuse on, in the order a person would fix them. */
  async function preconditions(tx: RulesTx, userId: string, campaignId: string, stepKey: string): Promise<Extract<AgentResult, { ok: false }> | null> {
    if (!(await d.mayGrant(tx, userId))) return { ok: false, reason: "forbidden" };
    if (await d.twoPersonRule(tx)) return { ok: false, reason: "two_person_rule" };
    const step = await d.port.stepOf(tx, campaignId, stepKey);
    if (!step) return { ok: false, reason: "not_found" };
    if (!step.perPerson) return { ok: false, reason: "not_per_person" };
    if (!step.email) return { ok: false, reason: "not_email" };
    if (!step.outsideContent) return { ok: false, reason: "outside_content_off" };
    const gate = d.agentGate();
    if (!gate.offered) return { ok: false, reason: "gate_closed", missing: gate.missing };
    if (!wordingSigned(d.wording)) return { ok: false, reason: "wording_unsigned" };
    return null;
  }

  async function enoughBasis(tx: RulesTx, campaignId: string, stepKey: string) {
    const basis = await basisFor(d, tx, campaignId, stepKey);
    if (!basis || basis.count < MIN_UNEDITED_APPROVALS) return { ok: false, reason: "too_few_approvals", count: basis?.count ?? 0 } as const;
    const capabilityHash = ((basis.sample.row.snapshot ?? []) as SnapshotEntry[]).find((e) => e.kind === "capability")?.version;
    const touchClass = touchClassOf(basis.sample.row.spec);
    if (!capabilityHash || !touchClass) return { ok: false, reason: "capability_unavailable" } as const;
    return { ok: true, ...basis, capabilityHash, touchClass } as const;
  }

  const otherActiveRule = async (tx: RulesTx, campaignId: string, stepKey: string, at: Date, except?: string) => {
    await lockStepRules(tx, campaignId, stepKey);
    return (await activeRulesForStep(tx, campaignId, stepKey)).some((r) => r.id !== except && r.expiresAt > at);
  };

  return {
    basisFor: (tx: RulesTx, campaignId: string, stepKey: string) => basisFor(d, tx, campaignId, stepKey),

    async grant(tx: RulesTx, workspaceId: string, a: { campaignId: string; stepKey: string; expiresAt: Date | null; wordingVersion: string }, session: { userId: string }, at: Date): Promise<AgentResult> {
      const refused = await preconditions(tx, session.userId, a.campaignId, a.stepKey);
      if (refused) return refused;
      const basis = await enoughBasis(tx, a.campaignId, a.stepKey);
      if (!basis.ok) return basis;
      if (await otherActiveRule(tx, a.campaignId, a.stepKey, at)) return { ok: false, reason: "step_has_rule" };
      if (!a.expiresAt) return { ok: false, reason: "bad_expiry" };
      if (a.wordingVersion !== d.wording.version) return { ok: false, reason: "wording_outdated" };
      const rule = await insertRule(tx, {
        workspaceId,
        mode: "agent_written",
        capability: basis.sample.row.capability,
        touchClass: basis.touchClass,
        campaignId: a.campaignId,
        stepKey: a.stepKey,
        templateRevision: null,
        facts: [],
        capabilityHash: basis.capabilityHash,
        dailyCap: null,
        producer: basis.producer,
        allowedFacts: basis.allowedFacts,
        outsideContent: true,
        language: LANGUAGE,
        wordingVersion: d.wording.version,
        expiresAt: a.expiresAt,
        grantedBy: session.userId,
        grantedAt: at,
        peopleAsOf: at,
        draftingAgent: basis.producer.writer.agent,
      });
      await insertRevision(tx, rule, "grant", session, null, at);
      return { ok: true, rule };
    },

    /** Stores the drafter in use now, in this person's name. A new drafter needs its own five approvals. */
    async reconfirm(tx: RulesTx, ruleId: string, session: { userId: string }, at: Date, expiresAt: Date): Promise<AgentResult> {
      const rule = await lockRule(tx, ruleId);
      if (!rule) return { ok: false, reason: "not_found" };
      if (rule.status === "revoked") return { ok: false, reason: "wrong_state" };
      const refused = await preconditions(tx, session.userId, rule.campaignId, rule.stepKey);
      if (refused) return refused;
      // The granter agreed to words that have since changed: they read the new ones on a new grant.
      if (rule.wordingVersion !== d.wording.version) return { ok: false, reason: "wording_outdated" };
      const basis = await enoughBasis(tx, rule.campaignId, rule.stepKey);
      if (!basis.ok) return basis;
      if (await otherActiveRule(tx, rule.campaignId, rule.stepKey, at, ruleId)) return { ok: false, reason: "step_has_rule" };
      const next = await updateRule(tx, ruleId, {
        status: "active",
        suspendedReason: null,
        producer: basis.producer,
        allowedFacts: basis.allowedFacts,
        capabilityHash: basis.capabilityHash,
        outsideContent: true,
        draftingAgent: basis.producer.writer.agent,
        grantedBy: session.userId,
        grantedAt: at,
        peopleAsOf: at,
        expiresAt,
        revision: rule.revision + 1,
      });
      await insertRevision(tx, next, "reconfirm", session, null, at);
      return { ok: true, rule: next };
    },
  };
}
