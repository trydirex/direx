// SPDX-License-Identifier: AGPL-3.0-only
// Draft placement: one Person's email for one Campaign step, made or revised whole. The email, its link
// to the Campaign, its triage and its submission commit together, so no email exists for a Campaign
// without belonging to it. Only the standing-rule announcement runs after: by then the link exists,
// and a failure there leaves the email waiting for a person.
import type { Items } from "../../items";
import type { Compose, Outreach } from "../../outreach";
import { planMailbox } from "../../schedule";
import { activeActions, inWorkspace, linkAction, lockPersonStatus, requireApproved, setProposedText, stepMailboxes } from "../adapters/repo";
import { assignSenders, type Sender } from "../domain/senders";

export const groupKeyOf = (campaignId: string, stepKey: string) => `campaign:${campaignId}:step:${stepKey}`;
const keyOf = (campaignId: string, stepKey: string, personId: string) => `${groupKeyOf(campaignId, stepKey)}:person:${personId}`;

type Deps = { items: () => Pick<Items, "setTriageIn" | "submitItemIn" | "announceSubmitted">; outreach: () => Pick<Outreach, "prepare" | "composeIn" | "reviseIn"> };
export type Placement = { workspaceId: string; campaignId: string; stepKey: string; personId: string; userId: string };
/** The email itself. Its keys come from the placement, so every path names the same email the same way. */
export type PlacedEmail = Omit<Compose, "personId" | "idempotencyKey" | "groupKey" | "submit"> & { submit: boolean };

const composeInput = (p: Placement, e: PlacedEmail): Compose => {
  const { submit: _, ...email } = e;
  return { ...email, personId: p.personId, idempotencyKey: keyOf(p.campaignId, p.stepKey, p.personId), groupKey: groupKeyOf(p.campaignId, p.stepKey) };
};

/**
 * The Mailbox and send time for each of these People's new email in a step, from day `on`: shared
 * across the step's Mailboxes, each Person keeping the sender their earlier email in the Campaign had.
 * The planner's read isn't locked; each draft reserves its day when it is placed.
 */
export async function plannedSenders(workspaceId: string, campaignId: string, stepKey: string, personIds: readonly string[], a: { on: string; now: Date }): Promise<Map<string, Sender>> {
  const { mailboxes, earlier } = await inWorkspace(workspaceId, async (tx) => ({ mailboxes: await stepMailboxes(tx, campaignId, stepKey), earlier: await activeActions(tx, campaignId, null) }));
  const keep = new Map<string, string>();
  // A sender that has left the step can't be kept, so it mustn't hide a later one that is still on it.
  for (const x of earlier) if (x.stepKey !== stepKey && x.credentialId && mailboxes.includes(x.credentialId) && !keep.has(x.personId)) keep.set(x.personId, x.credentialId);
  const free = new Map<string, Date[]>();
  for (const m of mailboxes) free.set(m, await planMailbox(workspaceId, m, { on: a.on, count: personIds.length, notBefore: a.now, now: a.now }));
  return assignSenders(personIds, free, keep);
}

/** A new email in its step. The same Person and step again returns the first one. */
/** `proposedText` is a writer's words before anyone edits them, kept so a person's edits can be measured. */
export async function placeDraft(d: Deps, p: Placement, e: PlacedEmail & { decideBy?: Date | undefined; producer?: unknown; checks?: unknown; proposedText?: string }) {
  const prepared = await d.outreach().prepare(p.workspaceId, composeInput(p, e));
  if (!prepared.ok) return prepared;
  const actor = { userId: p.userId };
  const r = await inWorkspace(p.workspaceId, async (tx) => {
    // Every email path, a writer's included, lands here, so this is where a Draft Campaign refuses one.
    const approved = await requireApproved(tx, p.campaignId);
    if (!approved.ok) return approved;
    // Removed while their email was prepared: nothing is made. A removal after this waits, then cancels it.
    if ((await lockPersonStatus(tx, p.campaignId, p.personId)) === "removed") return { ok: false, reason: "person_removed" } as const;
    const { item } = await d.outreach().composeIn(tx, p.workspaceId, prepared, actor);
    await linkAction(tx, { workspaceId: p.workspaceId, campaignId: p.campaignId, stepKey: p.stepKey, personId: p.personId, itemId: item.id, producer: e.producer, checks: e.checks, ...(e.proposedText !== undefined && { proposedText: e.proposedText }) });
    // Needs you sorts by what would make the launch slip first.
    if (e.decideBy) await d.items().setTriageIn(tx, item.id, { decideBy: e.decideBy });
    if (!e.submit) return { ok: true, item, announce: false } as const;
    const submitted = await d.items().submitItemIn(tx, p.workspaceId, item.id, actor);
    return submitted.ok ? submitted : ({ ok: true, item, announce: false } as const);
  });
  if (!r.ok) return r;
  if (r.announce) await d.items().announceSubmitted(p.workspaceId, r.item.id);
  return { ok: true, item: r.item } as const;
}

/** New words for an email already placed, under the same Action. Its snapshot is replaced, so pass the whole one. */
export async function reviseDraft(d: Deps, p: Placement & { itemId: string }, e: PlacedEmail & { proposedText?: string }) {
  const { proposedText, ...email } = e;
  const prepared = await d.outreach().prepare(p.workspaceId, composeInput(p, email));
  if (!prepared.ok) return prepared;
  const actor = { userId: p.userId };
  const r = await inWorkspace(p.workspaceId, async (tx) => {
    const approved = await requireApproved(tx, p.campaignId);
    if (!approved.ok) return { ...approved, announce: false };
    const revised = await d.outreach().reviseIn(tx, p.workspaceId, p.itemId, prepared, actor);
    if (revised.ok && proposedText !== undefined) await setProposedText(tx, p.itemId, proposedText);
    if (!revised.ok || !e.submit) return { ...revised, announce: false };
    const submitted = await d.items().submitItemIn(tx, p.workspaceId, p.itemId, actor);
    return submitted.ok ? submitted : { ...revised, announce: false };
  });
  if (r.ok && r.announce) await d.items().announceSubmitted(p.workspaceId, p.itemId);
  return r;
}
