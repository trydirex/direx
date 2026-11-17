// SPDX-License-Identifier: AGPL-3.0-only
// Granting, re-confirming, revoking and listing. The granter always comes from the session.
import { memberEmail } from "../../identity";
import type { Items } from "../../items";
import type { Ledger } from "../../ledger";
import { activeRulesForStep, activeRuleSteps, approvedByAPerson, inWorkspace, liveRuleGranter, lockStepRules, insertRevision, insertRule, listRules, lockRule, readRule, stopOf, totalUses, updateRule, usesOn, waitingAmong, type RuleRow, type RulesTx } from "../adapters/repo";
import { notCoveredWords, writerWords, type RuleProducer, type SnapshotEntry } from "../domain/cover";
import { AGENT_WRITTEN_WORDING, wordingSigned, type Wording } from "../domain/wording";
import { agentWritten, MIN_UNEDITED_APPROVALS, type AgentGate, type AgentResult } from "./agent-written";
import { suspend, touchClassOf, type MayGrant } from "./check";
import { matching } from "./match";
import { offers } from "./offer";
import type { CampaignPort } from "./port";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EXPIRY_DAYS = 90;

export type GrantRefusal = "forbidden" | "not_found" | "tainted_template" | "no_approved_email" | "blind_capability" | "warned_item" | "bad_expiry" | "wrong_state" | "cited_fact_changed" | "capability_unavailable" | "step_has_rule";
type Result = { ok: true; rule: RuleRow } | { ok: false; reason: GrantRefusal };

export function createStandingRules(d: {
  ledger: Ledger;
  port: CampaignPort;
  now: () => Date;
  mayGrant: MayGrant;
  items: () => Items;
  /** Read once at boot from the safety results. Closed unless given. */
  agentGate?: () => AgentGate;
  /** Whether the Workspace needs a second person for every approval. No such setting exists yet. */
  twoPersonRule?: (tx: RulesTx) => Promise<boolean>;
  wording?: Wording;
}) {
  const agentGate = d.agentGate ?? (() => ({ offered: false, missing: ["no safety results were read at boot"] }));
  const match = matching({ ...d, gateOpen: () => agentGate().offered });
  const wording = d.wording ?? AGENT_WRITTEN_WORDING;
  const agent = agentWritten({ port: d.port, mayGrant: d.mayGrant, agentGate, twoPersonRule: d.twoPersonRule ?? (async () => false), wording });

  const expiryFrom = (at: Date, asked?: Date) => {
    const longest = new Date(at.getTime() + DEFAULT_EXPIRY_DAYS * DAY_MS);
    if (!asked) return longest;
    return asked > at && asked <= longest ? asked : null;
  };

  /** A person approved an email of this exact template revision, with no warning on it. */
  async function evidence(tx: RulesTx, campaignId: string, stepKey: string, revision: number) {
    const approved = await approvedByAPerson(tx, await d.port.actionsIn(tx, campaignId, stepKey));
    return approved.filter((r) => ((r.snapshot ?? []) as SnapshotEntry[]).some((e) => e.kind === "template" && e.version === String(revision)));
  }

  /** What a rule on this step would rest on, or why none can. The offer asks the same question. */
  async function basisFor(tx: RulesTx, campaignId: string, stepKey: string) {
    const refuse = (reason: GrantRefusal) => ({ ok: false, reason }) as const;
    const step = await d.port.stepOf(tx, campaignId, stepKey);
    if (!step) return refuse("not_found");
    if (step.tainted) return refuse("tainted_template");
    const approved = await evidence(tx, campaignId, stepKey, step.templateRevision);
    if (!approved.length) return refuse("no_approved_email");
    const sample = approved.find((r) => (r.warnings as unknown[]).length === 0);
    if (!sample) return refuse("warned_item");
    if (sample.dedupe === "blind") return refuse("blind_capability");
    const entries = (sample.snapshot ?? []) as SnapshotEntry[];
    const capabilityHash = entries.find((e) => e.kind === "capability")?.version;
    const touchClass = touchClassOf(sample.spec);
    if (!capabilityHash || !touchClass) return refuse("capability_unavailable");
    return { ok: true, step, sample, entries, capabilityHash, touchClass, approved: approved.length, revision: step.templateRevision } as const;
  }

  return {
    onSubmitted: match.onSubmitted,
    onApproved: offers({ port: d.port, items: d.items, basisFor }),

    /** Once a day, for what a daily cap left waiting. */
    async sweepOverCap() {
      for (const s of await activeRuleSteps()) await match.retryOverCap(s.workspaceId, s.campaignId, s.stepKey);
    },

    /** Who granted the rule behind this Action's approval, and the drafter it trusted, in words for its history. */
    async ruleApprovalBy(workspaceId: string, actionId: string): Promise<{ by: string; writtenBy: string | null } | null> {
      const rule = await inWorkspace(workspaceId, (tx) => liveRuleGranter(tx, actionId));
      if (!rule) return null;
      const by = (await memberEmail(workspaceId, rule.grantedBy)) ?? "someone who has left";
      const writer = rule.mode === "agent_written" ? (rule.producer as RuleProducer | null)?.writer : undefined;
      return { by, writtenBy: writer ? writerWords(writer) : null };
    },

    async grant(workspaceId: string, a: { campaignId: string; stepKey: string; dailyCap: number; expiresAt?: Date | undefined }, session: { userId: string }): Promise<Result> {
      const at = d.now();
      const expiresAt = expiryFrom(at, a.expiresAt);
      if (!expiresAt) return { ok: false, reason: "bad_expiry" };
      const made = await inWorkspace(workspaceId, async (tx): Promise<Result> => {
        if (!(await d.mayGrant(tx, session.userId))) return { ok: false, reason: "forbidden" };
        // Rules are tried in turn, so two on one step would add their caps together.
        await lockStepRules(tx, a.campaignId, a.stepKey);
        if ((await activeRulesForStep(tx, a.campaignId, a.stepKey)).some((r) => r.expiresAt > at)) return { ok: false, reason: "step_has_rule" };
        const basis = await basisFor(tx, a.campaignId, a.stepKey);
        if (!basis.ok) return basis;
        const { step, sample, entries, capabilityHash, touchClass } = basis;
        const rule = await insertRule(tx, {
          workspaceId,
          capability: sample.capability,
          touchClass,
          campaignId: a.campaignId,
          stepKey: a.stepKey,
          templateRevision: step.templateRevision,
          facts: entries.filter((e) => e.kind === "fact").map((e) => ({ id: e.id, version: e.version })),
          capabilityHash,
          dailyCap: a.dailyCap,
          expiresAt,
          grantedBy: session.userId,
          grantedAt: at,
          peopleAsOf: at,
          draftingAgent: step.draftingAgent,
        });
        await insertRevision(tx, rule, "grant", session, null, at);
        return { ok: true, rule };
      });
      if (made.ok) await match.matchWaiting(workspaceId, a.campaignId, a.stepKey);
      return made;
    },

    /** A rule over email an agent writes. No one reads what it covers, so the form and the drafter's record are its basis. */
    async grantAgentWritten(workspaceId: string, a: { campaignId: string; stepKey: string; expiresAt?: Date | undefined; wordingVersion: string }, session: { userId: string }): Promise<AgentResult> {
      const at = d.now();
      const made = await inWorkspace(workspaceId, (tx) => agent.grant(tx, workspaceId, { ...a, expiresAt: expiryFrom(at, a.expiresAt) }, session, at));
      if (made.ok) await match.matchWaiting(workspaceId, a.campaignId, a.stepKey);
      return made;
    },

    /** How many unedited approvals of the drafter in use a person has made on this step, for the grant form. */
    agentBasis(workspaceId: string, campaignId: string, stepKey: string) {
      return inWorkspace(workspaceId, async (tx) => (await agent.basisFor(tx, campaignId, stepKey))?.count ?? 0);
    },
    /** What the agent-written form needs before it is shown: whether it may be offered, the evidence so far, and the words. */
    async agentWrittenOffer(workspaceId: string, campaignId: string, stepKey: string) {
      const gate = agentGate();
      return { offered: gate.offered && wordingSigned(wording), missing: [...gate.missing, ...(wordingSigned(wording) ? [] : ["the form's words aren't signed"])], approvals: await this.agentBasis(workspaceId, campaignId, stepKey), needed: MIN_UNEDITED_APPROVALS, wordingVersion: wording.version, statements: [...(AGENT_WRITTEN_WORDING.version === wording.version ? AGENT_WRITTEN_WORDING.statements : [])] };
    },

    /** Stores what is true now, in this person's name, and covers people in the campaign now. */
    async reconfirm(workspaceId: string, ruleId: string, session: { userId: string }): Promise<Result | AgentResult> {
      const at = d.now();
      const mode = await inWorkspace(workspaceId, async (tx) => (await readRule(tx, ruleId))?.mode);
      if (mode === "agent_written") {
        const made = await inWorkspace(workspaceId, (tx) => agent.reconfirm(tx, ruleId, session, at, new Date(at.getTime() + DEFAULT_EXPIRY_DAYS * DAY_MS)));
        if (made.ok) await match.matchWaiting(workspaceId, made.rule.campaignId, made.rule.stepKey);
        return made;
      }
      const read = await inWorkspace(workspaceId, async (tx) => {
        const rule = await readRule(tx, ruleId);
        return rule ? { rule, step: await d.port.stepOf(tx, rule.campaignId, rule.stepKey) } : null;
      });
      if (!read?.step) return { ok: false, reason: "not_found" };
      const { step } = read;
      const facts = step.citations.map((c) => ({ id: c.factId, version: String(c.version) }));
      const entries = [{ kind: "capability", id: read.rule.capability, version: "" }, ...facts.map((f) => ({ kind: "fact", ...f }))];
      const [capabilityHash, ...liveFacts] = await d.ledger.liveVersions(workspaceId, entries);
      if (!capabilityHash) return { ok: false, reason: "capability_unavailable" };
      // The template still cites an old version, so its emails would hold. It must be saved again first.
      if (facts.some((f, i) => liveFacts[i] !== f.version)) return { ok: false, reason: "cited_fact_changed" };
      const made = await inWorkspace(workspaceId, async (tx): Promise<Result> => {
        if (!(await d.mayGrant(tx, session.userId))) return { ok: false, reason: "forbidden" };
        if (step.tainted) return { ok: false, reason: "tainted_template" };
        const rule = await lockRule(tx, ruleId);
        if (!rule) return { ok: false, reason: "not_found" };
        if (rule.status === "revoked") return { ok: false, reason: "wrong_state" };
        await lockStepRules(tx, rule.campaignId, rule.stepKey);
        if ((await activeRulesForStep(tx, rule.campaignId, rule.stepKey)).some((r) => r.id !== ruleId && r.expiresAt > at)) return { ok: false, reason: "step_has_rule" };
        const next = await updateRule(tx, ruleId, {
          status: "active",
          suspendedReason: null,
          templateRevision: step.templateRevision,
          facts,
          capabilityHash,
          grantedBy: session.userId,
          grantedAt: at,
          peopleAsOf: at,
          expiresAt: new Date(at.getTime() + DEFAULT_EXPIRY_DAYS * DAY_MS),
          revision: rule.revision + 1,
        });
        await insertRevision(tx, next, "reconfirm", session, null, at);
        return { ok: true, rule: next };
      });
      if (made.ok) await match.matchWaiting(workspaceId, made.rule.campaignId, made.rule.stepKey);
      return made;
    },

    /** Stopping is always easy: any Member, with a reason. Anything it approved and hasn't sent is held by the live check. */
    revoke(workspaceId: string, ruleId: string, session: { userId: string }, reason: string): Promise<Result> {
      const at = d.now();
      return inWorkspace(workspaceId, async (tx) => {
        const rule = await lockRule(tx, ruleId);
        if (!rule) return { ok: false, reason: "not_found" };
        if (rule.status === "revoked") return { ok: true, rule };
        const next = await updateRule(tx, ruleId, { status: "revoked", suspendedReason: null });
        await insertRevision(tx, next, "revoke", session, reason, at);
        return { ok: true, rule: next };
      });
    },

    async list(workspaceId: string) {
      const at = d.now();
      const views = await inWorkspace(workspaceId, async (tx) => {
        const rows = [];
        for (const rule of await listRules(tx)) {
          const stop = rule.status === "revoked" ? await stopOf(tx, rule.id) : undefined;
          rows.push({ ...rule, status: rule.status === "active" && rule.expiresAt <= at ? "expired" : rule.status, usedToday: await usesOn(tx, rule.id, at.toISOString().slice(0, 10)), total: await totalUses(tx, rule.id), stop });
        }
        return rows;
      });
      return Promise.all(
        views.map(async ({ stop, ...v }) => ({
          ...v,
          granterEmail: (await memberEmail(workspaceId, v.grantedBy)) ?? null,
          stoppedByEmail: stop?.by ? ((await memberEmail(workspaceId, stop.by)) ?? "someone who has left") : null,
          stopReason: stop?.reason ?? null,
        })),
      );
    },

    /** The grant form's numbers. */
    coverage(workspaceId: string, campaignId: string, stepKey: string) {
      return inWorkspace(workspaceId, async (tx) => ({
        people: await d.port.peopleIn(tx, campaignId),
        waiting: (await waitingAmong(tx, await d.port.actionsIn(tx, campaignId, stepKey))).length,
      }));
    },
  };
}
export type StandingRules = ReturnType<typeof createStandingRules>;

/** The campaign's outside-content answer changed: its agent-written rules stop until a person re-confirms them. */
export async function suspendAgentRulesFor(tx: RulesTx, campaignId: string, at: Date): Promise<number> {
  let n = 0;
  for (const rule of await listRules(tx)) {
    if (rule.status === "active" && rule.mode === "agent_written" && rule.campaignId === campaignId) {
      await suspend(tx, rule, notCoveredWords("outside_content_changed"), at);
      n++;
    }
  }
  return n;
}

/**
 * A route change with no passing eval: rules over that agent's drafts stop until a person re-confirms.
 * Text a person wrote is untouched. With `agentWrittenOnly`, rules over a template the agent drafted
 * and a person read keep covering.
 */
export async function suspendForAgent(tx: RulesTx, agent: string | "all", reason: string, at: Date, agentWrittenOnly = false): Promise<number> {
  let n = 0;
  for (const rule of await listRules(tx)) {
    if (rule.status === "active" && rule.draftingAgent && (agent === "all" || rule.draftingAgent === agent) && (!agentWrittenOnly || rule.mode === "agent_written")) {
      await suspend(tx, rule, reason, at);
      n++;
    }
  }
  return n;
}
