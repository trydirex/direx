// SPDX-License-Identifier: AGPL-3.0-only
// DM steps: one LinkedIn or X message per Person, which a person copies, sends by hand and marks sent.
// Direx sends nothing here, so there is no Action and no approval; the text is checked like an email
// template's, and marking one sent logs an outside touch that holds Direx's next cold email 3 days.
import type { Facts } from "../../facts";
import type { Outreach, OutsideTouches } from "../../outreach";
import { direxTouchNear } from "../../schedule";
import { allPeople, fillTemplate, inWorkspace, lockStep, requireApproved, stepsOf, stillWaiting } from "../adapters/repo";
import { dmsOf, insertDm, profilesOf, readDm, setCopied, setSent, type DmRow } from "../adapters/dms-repo";
import { leftOut, type AudienceStep, type PersonStatus } from "../domain/audience";
import { merge, missingFields, unknownFields } from "../domain/merge";
import { reviewTemplate } from "./drafting";
import type { DraftResult } from "./make-drafts";

type Deps = {
  facts: Pick<Facts, "usableFacts" | "checkCitation" | "bannedClaimsIn">;
  outreach: () => Outreach;
  outsideTouches: () => Pick<OutsideTouches, "log">;
  now: () => Date;
};
type DmText = { text: string };
export type DmView = { id: string; personId: string; channel: string; profileUrl: string; text: string; copiedAt: string | null; sentAt: string | null };

const view = (r: DmRow): DmView => ({ id: r.id, personId: r.personId, channel: r.channel, profileUrl: r.profileUrl, text: r.text, copiedAt: r.copiedAt?.toISOString() ?? null, sentAt: r.sentAt?.toISOString() ?? null });

export function dmSteps(d: Deps) {
  /** Opted out or no longer eligible since the DM was made: nothing to copy or log. */
  const refusal = async (workspaceId: string, dm: DmRow) => (await d.outreach().whyNot(workspaceId, [dm.personId], "cold")).get(dm.personId) ?? null;

  return {
    /** A person's DM text, with the same claim checks as an email template. DMs already made keep theirs. */
    async saveDmText(workspaceId: string, campaignId: string, stepKey: string, a: { revision: number; text: string }) {
      if (unknownFields(a.text).length) return { ok: false, reason: "unknown_merge_field" } as const;
      const body = await reviewTemplate(workspaceId, d.facts, { schemaVersion: 1, subject: "", text: a.text, citations: [] });
      if (body.needsDecision.length) return { ok: false, reason: "needs_decision" } as const;
      return inWorkspace(workspaceId, async (tx) => {
        const approved = await requireApproved(tx, campaignId);
        if (!approved.ok) return approved;
        const step = await lockStep(tx, campaignId, stepKey);
        if (!step) return { ok: false, reason: "not_found" } as const;
        if (step.type !== "dm") return { ok: false, reason: "not_a_dm_step" } as const;
        if (step.templateRevision !== a.revision) return { ok: false, reason: "target_changed" } as const;
        await fillTemplate(tx, { campaignId, stepKey, template: body, revision: a.revision + 1, runId: null, now: d.now() });
        return { ok: true, revision: a.revision + 1, warnings: body.warnings.map((w) => w.text) } as const;
      });
    },

    /** One DM per Person who can get one; everyone else with the reason. Running it again adds only the new ones. */
    async makeDms(workspaceId: string, campaignId: string, stepKey: string) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const approved = await requireApproved(tx, campaignId);
        if (!approved.ok) return approved;
        const step = (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey);
        if (!step) return { ok: false, reason: "not_found" } as const;
        if (step.type !== "dm" || !step.dmChannel) return { ok: false, reason: "not_a_dm_step" } as const;
        const text = (step.template as DmText | null)?.text;
        if (!text) return { ok: false, reason: "no_template" } as const;
        const people = await allPeople(tx, campaignId);
        const channel = step.dmChannel as "linkedin" | "x";
        return { ok: true, step, channel, text, people, existing: await dmsOf(tx, campaignId, stepKey), waiting: await stillWaiting(tx, campaignId), profiles: await profilesOf(tx, people.map((p) => p.personId), channel) } as const;
      });
      if (!read.ok) return read;
      const senderName = await d.outreach().senderName(workspaceId);
      const blocked = await d.outreach().whyNot(workspaceId, read.people.map((p) => p.personId), "cold");
      const made = new Map(read.existing.map((x) => [x.personId, x.id]));
      const results: DraftResult[] = [];
      await inWorkspace(workspaceId, async (tx) => {
        for (const person of read.people) {
          const base = { personId: person.personId, email: person.email };
          const already = made.get(person.personId);
          if (already) {
            results.push({ ...base, ok: true, itemId: already, already: true });
            continue;
          }
          const values = { firstName: person.firstName, company: person.company, senderName };
          const why = blocked.get(person.personId);
          const out = leftOut(
            {
              status: (read.waiting.has(person.personId) ? "conflict" : person.status) as PersonStatus,
              replied: person.status === "replied",
              mergeFieldsMissing: missingFields(read.text, values),
              eligibilityMissing: why ? [why] : [],
            },
            { audience: read.step.audience as AudienceStep["audience"] },
          );
          if (out) {
            results.push({ ...base, ok: false, leftOut: out });
            continue;
          }
          const profileUrl = read.profiles.get(person.personId);
          if (!profileUrl) {
            results.push({ ...base, ok: false, reason: "no_profile" });
            continue;
          }
          const merged = merge(read.text, values);
          if (!merged.ok) continue;
          const dm = await insertDm(tx, { workspaceId, campaignId, stepKey, personId: person.personId, channel: read.channel, profileUrl, text: merged.text, templateRevision: read.step.templateRevision, createdAt: d.now() });
          results.push({ ...base, ok: true, itemId: dm?.id, already: !dm });
        }
      });
      return { ok: true, results } as const;
    },

    async dms(workspaceId: string, campaignId: string, stepKey: string): Promise<DmView[]> {
      return (await inWorkspace(workspaceId, (tx) => dmsOf(tx, campaignId, stepKey))).map(view);
    },

    /** A person copied the text to send it. Says so when Direx emailed them, or will, within 3 days; it never stops them. */
    async copyDm(workspaceId: string, dmId: string) {
      const dm = await inWorkspace(workspaceId, (tx) => readDm(tx, dmId));
      if (!dm) return { ok: false, reason: "not_found" } as const;
      const refused = await refusal(workspaceId, dm);
      if (refused) return { ok: false, reason: refused } as const;
      const at = d.now();
      await inWorkspace(workspaceId, (tx) => setCopied(tx, dmId, at));
      return { ok: true, direxTouchNear: await direxTouchNear(workspaceId, dm.personId, at) } as const;
    },

    /** A person sent it by hand. Logged once as their touch, so Direx's next cold email waits 3 days. */
    async markDmSent(workspaceId: string, dmId: string, userId: string) {
      const dm = await inWorkspace(workspaceId, (tx) => readDm(tx, dmId));
      if (!dm) return { ok: false, reason: "not_found" } as const;
      if (dm.sentAt) return { ok: true, dm: view(dm) } as const;
      const approved = await inWorkspace(workspaceId, (tx) => requireApproved(tx, dm.campaignId));
      if (!approved.ok) return approved;
      const refused = await refusal(workspaceId, dm);
      if (refused) return { ok: false, reason: refused } as const;
      const at = d.now();
      const logged = await d.outsideTouches().log(workspaceId, dm.personId, { channel: dm.channel as "linkedin" | "x", direction: "outbound", occurredAt: at, source: "direx_draft", sourceRef: dm.id }, userId);
      if (!logged.ok) return logged;
      const sent = await inWorkspace(workspaceId, async (tx) => {
        await setSent(tx, dmId, at, userId);
        return (await readDm(tx, dmId))!;
      });
      return { ok: true, dm: view(sent) } as const;
    },
  };
}
