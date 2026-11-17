// SPDX-License-Identifier: AGPL-3.0-only
// From a template a person has read to one Action Item per Person, through outreach so the footer and
// floors always apply. Nothing here approves. A step's text changes under the same Actions.
import { datedSteps, decideBy } from "../domain/anchor";
import type { Facts } from "../../facts";
import type { Items } from "../../items";
import type { Outreach } from "../../outreach";
import type { Plans } from "../../plans";
import type { TemplateBody } from "../definitions/drafter";
import { activeActions, allPeople, fillTemplate, inWorkspace, lockStep, readCampaign, stepMailboxes, stepsOf, stillWaiting, type CampaignsTx } from "../adapters/repo";
import { leftOut, type AudienceStep, type LeftOut, type PersonStatus } from "../domain/audience";
import { merge, missingFields, stepFields, unknownFields } from "../domain/merge";
import { reviewTemplate, type OnTemplateSaved } from "./drafting";
import { placeDraft, plannedSenders, reviseDraft } from "./place-draft";
import { stepOutputEntries, templateEntries } from "./snapshot";
import { stepUrls } from "./step-links";

export type DraftResult = { personId: string; email: string | null; ok: boolean; itemId?: string; already?: boolean; leftOut?: LeftOut; reason?: string };
/** After a template is saved and committed. Only suggests work, so a failure never undoes the save. */
type Deps = { plans: Plans; facts: Pick<Facts, "usableFacts" | "checkCitation" | "bannedClaimsIn">; items: () => Items; outreach: () => Outreach; now: () => Date; onTemplateSaved?: OnTemplateSaved | undefined };

// Only an email step gets here, and it always has a class.
const touch = (touchClass: string | null) => touchClass as "cold" | "consented_marketing";
// Only text that names the step's output rests on it, so only that text is held when it changes.
const outputEntries = (campaignId: string, text: string, used: { stepKey: string; version: number } | null) => stepOutputEntries(campaignId, stepFields(text).length ? used : null);

/** Why this step can't make drafts yet, or the parts it needs. */
async function readyStep(tx: CampaignsTx, campaignId: string, stepKey: string) {
  const campaign = await readCampaign(tx, campaignId);
  if (!campaign) return { ok: false, reason: "not_found" } as const;
  const step = (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey);
  if (step?.type !== "email") return { ok: false, reason: "not_an_email_step" } as const;
  if (step.cancelledAt) return { ok: false, reason: "step_cancelled" } as const;
  const mailboxes = await stepMailboxes(tx, campaignId, stepKey);
  if (!mailboxes.length) return { ok: false, reason: "mailbox_required" } as const;
  if (!step.template) return { ok: false, reason: "no_template" } as const;
  return { ok: true, campaign, step, mailboxes, template: step.template as TemplateBody } as const;
}

export function makeDrafting(d: Deps) {
  /** Who would get a draft and who wouldn't, written once so a preview can't disagree with making them. */
  async function decide(workspaceId: string, campaignId: string, stepKey: string) {
    const read = await inWorkspace(workspaceId, async (tx) => {
      const ready = await readyStep(tx, campaignId, stepKey);
      if (!ready.ok) return ready;
      // A step waiting on another's output makes nothing until that output exists.
      const links = await stepUrls(tx, { workspaceId, campaignId, step: ready.step, at: d.now() });
      if (!links.ok) return links;
      return { ...ready, urls: links.urls, used: links.used, people: await allPeople(tx, campaignId), existing: await activeActions(tx, campaignId, stepKey), waiting: await stillWaiting(tx, campaignId) };
    });
    if (!read.ok) return read;
    if (read.template.needsDecision.length) return { ok: false, reason: "needs_decision" } as const;
    const plan = await d.plans.plan(workspaceId, read.campaign.planId);
    const on = plan?.current ? datedSteps(plan.current, read.campaign.anchorOn).find((s) => s.key === stepKey)?.on : undefined;
    if (!on) return { ok: false, reason: "step_not_in_plan" } as const;
    const senderName = await d.outreach().senderName(workspaceId);
    if (!senderName) return { ok: false, reason: "sender_identity_missing" } as const;

    const blocked = await d.outreach().whyNot(workspaceId, read.people.map((p) => p.personId), read.step.touchClass!);
    const made = new Map(read.existing.map((x) => [x.personId, x.itemId]));
    const results: DraftResult[] = [];
    const going: { person: (typeof read.people)[number]; subject: string; text: string }[] = [];
    for (const person of read.people) {
      const base = { personId: person.personId, email: person.email };
      const itemId = made.get(person.personId);
      if (itemId) {
        results.push({ ...base, ok: true, itemId, already: true });
        continue;
      }
      const values = { firstName: person.firstName, company: person.company, senderName };
      const why = blocked.get(person.personId);
      const out = leftOut(
        {
          status: (read.waiting.has(person.personId) ? "conflict" : person.status) as PersonStatus,
          replied: person.status === "replied",
          mergeFieldsMissing: missingFields(`${read.template.subject}\n${read.template.text}`, values, read.urls),
          eligibilityMissing: why ? [why] : [],
        },
        { audience: read.step.audience as AudienceStep["audience"] },
      );
      const subject = merge(read.template.subject, values, read.urls);
      const text = merge(read.template.text, values, read.urls);
      if (out || !subject.ok || !text.ok) results.push({ ...base, ok: false, leftOut: out ?? { reason: "missing_merge_field", fields: [] } });
      else going.push({ person, subject: subject.text, text: text.text });
    }
    return { ok: true, read, on, title: plan?.title, results, going } as const;
  }

  return {
    /** What Make drafts would do, changing nothing. The sample is one real Person's email. */
    async previewDrafts(workspaceId: string, campaignId: string, stepKey: string) {
      const decided = await decide(workspaceId, campaignId, stepKey);
      if (!decided.ok) return decided;
      const sample = decided.going[0];
      return {
        ok: true,
        willMake: decided.going.length,
        already: decided.results.filter((r) => r.already).length,
        leftOut: decided.results.filter((r) => r.leftOut).map((r) => ({ email: r.email, leftOut: r.leftOut! })),
        sample: sample ? { email: sample.person.email, subject: sample.subject, text: sample.text } : null,
      } as const;
    },

    async makeDrafts(workspaceId: string, campaignId: string, stepKey: string, a: { timeZone: string; userId: string }) {
      const decided = await decide(workspaceId, campaignId, stepKey);
      if (!decided.ok) return decided;
      const { read, on, title, results, going } = decided;
      const senders = await plannedSenders(workspaceId, campaignId, stepKey, going.map((g) => g.person.personId), { on, now: d.now() });
      for (const { person, subject, text } of going) {
        const sender = senders.get(person.personId);
        const base = { personId: person.personId, email: person.email };
        const placed = await placeDraft(
          d,
          { workspaceId, campaignId, stepKey, personId: person.personId, userId: a.userId },
          {
            // With no time left in the horizon, the email still names a Mailbox and waits unplaced.
            credentialId: sender?.credentialId ?? read.mailboxes[0]!,
            touchClass: touch(read.step.touchClass),
            subject,
            text,
            plannedAt: sender?.at,
            groupLabel: title,
            warnings: read.template.warnings,
            snapshot: [...templateEntries(campaignId, stepKey, read.step.templateRevision, read.template.citations), ...outputEntries(campaignId, `${read.template.subject}\n${read.template.text}`, read.used)],
            submit: true,
            // A working day before it goes.
            decideBy: sender && decideBy({ firstSlot: sender.at, draftingDays: 0, timeZone: a.timeZone }),
          },
        );
        if (!placed.ok) {
          results.push({ ...base, ok: false, reason: placed.reason });
          continue;
        }
        results.push({ ...base, ok: true, itemId: placed.item.id, already: false });
      }
      return { ok: true, results } as const;
    },

    /** A person's text, checked like a run's. With drafts already made, each unsent one takes the new text. */
    async saveTemplate(workspaceId: string, campaignId: string, stepKey: string, a: { revision: number; subject: string; text: string; userId: string }) {
      const before = await inWorkspace(workspaceId, async (tx) => {
        const step = (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey);
        if (!step) return null;
        const links = await stepUrls(tx, { workspaceId, campaignId, step, at: d.now() });
        return { step, urls: links.ok ? links.urls : {}, used: links.ok ? links.used : null, links: await activeActions(tx, campaignId, stepKey), people: await allPeople(tx, campaignId) };
      });
      // Only the step this one waits on may be named; its URL may not exist yet.
      const allowedSteps = before?.step.dependsOnStepKey ? [before.step.dependsOnStepKey] : [];
      if (unknownFields(`${a.subject}\n${a.text}`, allowedSteps).length) return { ok: false, reason: "unknown_merge_field" } as const;
      if (!before) return { ok: false, reason: "not_found" } as const;
      const citations = (before.step.template as TemplateBody | null)?.citations ?? [];
      const body = await reviewTemplate(workspaceId, d.facts, { schemaVersion: 1, subject: a.subject, text: a.text, citations });
      // Drafts already exist, so saving would leave them saying something else. It waits until this is settled.
      if (body.needsDecision.length && before.links.length) return { ok: false, reason: "needs_decision" } as const;

      const saved = await inWorkspace(workspaceId, async (tx) => {
        const step = await lockStep(tx, campaignId, stepKey);
        if (step?.templateRevision !== a.revision) return null;
        await fillTemplate(tx, { campaignId, stepKey, template: body, revision: a.revision + 1, runId: null, now: d.now() });
        return step;
      });
      if (!saved) return { ok: false, reason: "target_changed" } as const;

      const senderName = before.links.length ? await d.outreach().senderName(workspaceId) : null;
      let revised = 0;
      const failed: { personId: string; reason: string }[] = [];
      // Each draft keeps the Mailbox it was written with; the step's list may have changed since.
      for (const link of before.links) {
        if (!link.credentialId) continue;
        const person = before.people.find((p) => p.personId === link.personId);
        const values = { firstName: person?.firstName ?? null, company: person?.company ?? null, senderName };
        const subject = merge(a.subject, values, before.urls);
        const text = merge(a.text, values, before.urls);
        if (!subject.ok || !text.ok) {
          failed.push({ personId: link.personId, reason: "missing_merge_field" });
          continue;
        }
        const r = await reviseDraft(
          d,
          { workspaceId, campaignId, stepKey, personId: link.personId, userId: a.userId, itemId: link.itemId },
          { credentialId: link.credentialId, touchClass: touch(saved.touchClass), subject: subject.text, text: text.text, plannedAt: link.plannedAt ?? undefined, warnings: body.warnings, snapshot: [...templateEntries(campaignId, stepKey, a.revision + 1, body.citations), ...outputEntries(campaignId, `${a.subject}\n${a.text}`, before.used)], submit: false },
        );
        if (r.ok) revised++;
        else failed.push({ personId: link.personId, reason: r.reason });
      }
      await d.onTemplateSaved?.(workspaceId, { campaignId, stepKey, revision: a.revision + 1, userId: a.userId }).catch((e) => console.error("campaigns: onTemplateSaved failed", campaignId, stepKey, e));
      return { ok: true, revision: a.revision + 1, revised, failed } as const;
    },
  };
}
