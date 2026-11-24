// SPDX-License-Identifier: AGPL-3.0-only
import { withSystem, withWorkspace, type WorkspaceTx } from "@direx/db";
import { actionEvents, actions, credentials, items, personKeys } from "@direx/db/schema";
import { agentRuns } from "@direx/db/schema-agents";
import { campaignActions, campaignDms, campaignOutcomes, campaignPeople, campaignPlanChanges, campaigns, campaignSettlements, campaignStepMailboxes, campaignStepOutputs, campaignSteps, campaignWriteUps, clipStepRuns } from "@direx/db/schema-campaigns";
import { replySignals } from "@direx/db/schema-outreach";
import { marketingPlans } from "@direx/db/schema-plans";
import { socialPosts } from "@direx/db/schema-social";
import { trackedLinks, trackedLinkUses, trackingDomains } from "@direx/db/schema-tracking";
import type { VisibleState } from "../../items";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, notInArray, or, sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

/** Marks these records replied in every campaign they're still active in, whichever channel the reply came on. */
export function markRepliedEverywhere(tx: CampaignsTx, personIds: readonly string[], status: "replied" | "removed" = "replied") {
  return tx
    .update(campaignPeople)
    .set({ status })
    .where(and(inArray(campaignPeople.personId, [...personIds]), eq(campaignPeople.status, "active")))
    .returning({ campaignId: campaignPeople.campaignId, personId: campaignPeople.personId });
}

export const inWorkspace = withWorkspace;
export type CampaignsTx = WorkspaceTx;
export type CampaignRow = typeof campaigns.$inferSelect;
export type StepRow = typeof campaignSteps.$inferSelect;
export type StepSetup = Pick<StepRow, "type" | "touchClass" | "mailboxCredentialId" | "audience"> & {
  dmChannel?: StepRow["dmChannel"];
  dependsOnStepKey?: StepRow["dependsOnStepKey"];
  outputConnection?: StepRow["outputConnection"];
  outputNetworkId?: StepRow["outputNetworkId"];
  utm?: StepRow["utm"];
};

/** A later version of the same plan finds its campaign already there. */
export async function ensureCampaign(tx: CampaignsTx, a: { workspaceId: string; planId: string; ownerUserId: string; now: Date }) {
  await tx
    .insert(campaigns)
    .values({ workspaceId: a.workspaceId, planId: a.planId, ownerUserId: a.ownerUserId, createdAt: a.now, updatedAt: a.now })
    .onConflictDoNothing({ target: [campaigns.workspaceId, campaigns.planId] });
}

export const listCampaigns = (tx: CampaignsTx): Promise<CampaignRow[]> => tx.select().from(campaigns).orderBy(desc(campaigns.createdAt));

export const readCampaign = async (tx: CampaignsTx, id: string): Promise<CampaignRow | undefined> => (await tx.select().from(campaigns).where(eq(campaigns.id, id)))[0];

export const campaignOfPlan = async (tx: CampaignsTx, planId: string): Promise<CampaignRow | undefined> => (await tx.select().from(campaigns).where(eq(campaigns.planId, planId)))[0];

/**
 * ADR 0023 rule 002: a Campaign whose plan has no approved version is a Draft, and takes no People, DMs,
 * emails, step setup or settings. Every such write path starts here. A plan's approval is never undone,
 * so a yes here stays true for the rest of the transaction.
 */
export async function requireApproved(tx: CampaignsTx, campaignId: string, { lockCampaign = false } = {}) {
  const query = tx.select({ campaign: campaigns, approved: marketingPlans.currentVersion }).from(campaigns).innerJoin(marketingPlans, eq(marketingPlans.id, campaigns.planId)).where(eq(campaigns.id, campaignId));
  const [row] = await (lockCampaign ? query.for("no key update", { of: campaigns }) : query);
  if (!row) return { ok: false, reason: "not_found" } as const;
  if (row.approved === null) return { ok: false, reason: "plan_not_approved" } as const;
  return { ok: true, campaign: row.campaign } as const;
}

const DELETE_REFUSALS: Record<string, "not_found" | "plan_approved" | "drafter_running" | "draft_in_use"> = { DX404: "not_found", DXAPR: "plan_approved", DXRUN: "drafter_running", DXREF: "draft_in_use" };

/**
 * ADR 0023 rule 005: deletes a never-approved plan, its versions and its Campaign through the one database
 * function allowed to (migration 0123). It locks and checks inside, so its refusals come back as values here.
 */
export async function deleteDraftRows(workspaceId: string, planId: string) {
  try {
    await withWorkspace(workspaceId, (tx) => tx.execute(sql`select system.delete_draft_campaign(${workspaceId}::uuid, ${planId}::uuid)`));
    return { ok: true } as const;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    const reason = DELETE_REFUSALS[err.code ?? err.cause?.code ?? ""];
    if (!reason) throw e;
    return { ok: false, reason } as const;
  }
}

export type PlanChangeRow = typeof campaignPlanChanges.$inferSelect;
export const planChangesOf = (tx: CampaignsTx, campaignId: string): Promise<PlanChangeRow[]> => tx.select().from(campaignPlanChanges).where(eq(campaignPlanChanges.campaignId, campaignId));

/** A step's change from the version it settled on, replacing any earlier one for the step, decided or not. */
export async function putPlanChange(tx: CampaignsTx, a: Omit<PlanChangeRow, "decided" | "decidedBy" | "decidedAt">) {
  const undecided = { fromVersion: a.fromVersion, toVersion: a.toVersion, kinds: a.kinds, suggestedTemplate: a.suggestedTemplate, itemId: a.itemId, decided: null, decidedBy: null, decidedAt: null };
  await tx
    .insert(campaignPlanChanges)
    .values(a)
    .onConflictDoUpdate({ target: [campaignPlanChanges.workspaceId, campaignPlanChanges.campaignId, campaignPlanChanges.stepKey], set: undecided });
}

export async function decidePlanChange(tx: CampaignsTx, campaignId: string, stepKey: string, a: { decided: "keep" | "use_new_text" | "cancel"; userId: string; at: Date }) {
  await tx
    .update(campaignPlanChanges)
    .set({ decided: a.decided, decidedBy: a.userId, decidedAt: a.at })
    .where(and(eq(campaignPlanChanges.campaignId, campaignId), eq(campaignPlanChanges.stepKey, stepKey), isNull(campaignPlanChanges.decided)));
}

export const stepsOf = (tx: CampaignsTx, campaignId: string): Promise<StepRow[]> => tx.select().from(campaignSteps).where(eq(campaignSteps.campaignId, campaignId));

/** Adding someone already here updates their details. Only a person who was removed comes back. */
export async function joinCampaign(tx: CampaignsTx, a: typeof campaignPeople.$inferInsert) {
  const { firstName, company, website, at } = a;
  await tx
    .insert(campaignPeople)
    .values(a)
    .onConflictDoUpdate({
      target: [campaignPeople.workspaceId, campaignPeople.campaignId, campaignPeople.personId],
      set: { firstName, company, website, at, status: sql`case when ${campaignPeople.status} = 'removed' then 'active' else ${campaignPeople.status} end` },
    });
}

export function peoplePage(tx: CampaignsTx, campaignId: string, after: string | undefined, limit: number) {
  return tx
    .select({
      personId: campaignPeople.personId,
      status: campaignPeople.status,
      firstName: campaignPeople.firstName,
      company: campaignPeople.company,
      website: campaignPeople.website,
      conflictItemId: campaignPeople.conflictItemId,
      email: personKeys.value,
    })
    .from(campaignPeople)
    .leftJoin(personKeys, and(eq(personKeys.personId, campaignPeople.personId), eq(personKeys.kind, "email")))
    .where(and(eq(campaignPeople.campaignId, campaignId), after ? gt(campaignPeople.personId, after) : undefined))
    .orderBy(campaignPeople.personId)
    .limit(limit);
}

/** When this Campaign last sent each of these people an email: the newest sent Action's dispatch time. */
export async function lastSentAt(tx: CampaignsTx, campaignId: string, personIds: readonly string[]): Promise<Map<string, Date>> {
  if (!personIds.length) return new Map();
  const rows = await tx
    .select({ personId: campaignActions.personId, at: sql<Date>`max(${actions.firstDispatchedAt})` })
    .from(campaignActions)
    .innerJoin(actions, eq(actions.id, campaignActions.actionId))
    .where(and(eq(campaignActions.campaignId, campaignId), inArray(campaignActions.personId, [...personIds]), eq(actions.state, "sent"), isNotNull(actions.firstDispatchedAt)))
    .groupBy(campaignActions.personId);
  return new Map(rows.map((r) => [r.personId, new Date(r.at)]));
}

/** A Person's status in a Campaign, holding the row so a removal waits for this transaction, or null. */
export async function lockPersonStatus(tx: CampaignsTx, campaignId: string, personId: string): Promise<string | null> {
  const [row] = await tx
    .select({ status: campaignPeople.status })
    .from(campaignPeople)
    .where(and(eq(campaignPeople.campaignId, campaignId), eq(campaignPeople.personId, personId)))
    .for("share");
  return row?.status ?? null;
}

export async function setPersonStatus(tx: CampaignsTx, campaignId: string, personId: string, status: "removed"): Promise<boolean> {
  const rows = await tx
    .update(campaignPeople)
    .set({ status })
    .where(and(eq(campaignPeople.campaignId, campaignId), eq(campaignPeople.personId, personId)))
    .returning({ personId: campaignPeople.personId });
  return rows.length > 0;
}

export function allPeople(tx: CampaignsTx, campaignId: string) {
  return tx
    .select({ personId: campaignPeople.personId, status: campaignPeople.status, firstName: campaignPeople.firstName, company: campaignPeople.company, website: campaignPeople.website, afterCampaignId: campaignPeople.afterCampaignId, email: personKeys.value })
    .from(campaignPeople)
    .leftJoin(personKeys, and(eq(personKeys.personId, campaignPeople.personId), eq(personKeys.kind, "email")))
    .where(eq(campaignPeople.campaignId, campaignId))
    .orderBy(campaignPeople.personId);
}

/** A step's Actions and their Items. A step key of null means every step of the campaign. */
export function activeActions(tx: CampaignsTx, campaignId: string, stepKey: string | null, personId?: string) {
  return tx
    .select({ personId: campaignActions.personId, stepKey: campaignActions.stepKey, actionId: campaignActions.actionId, itemId: items.id, plannedAt: items.plannedAt, spec: actions.spec, credentialId: actions.credentialId })
    .from(campaignActions)
    .innerJoin(items, eq(items.actionId, campaignActions.actionId))
    .innerJoin(actions, eq(actions.id, campaignActions.actionId))
    .where(and(eq(campaignActions.campaignId, campaignId), stepKey ? eq(campaignActions.stepKey, stepKey) : undefined, personId ? eq(campaignActions.personId, personId) : undefined));
}

/** Which Campaign, step and Person an email Item belongs to, or nothing for one that isn't a Campaign's. */
export async function linkOfItem(tx: CampaignsTx, itemId: string) {
  const [row] = await tx
    .select({ campaignId: campaignActions.campaignId, stepKey: campaignActions.stepKey, personId: campaignActions.personId })
    .from(campaignActions)
    .innerJoin(items, eq(items.actionId, campaignActions.actionId))
    .where(eq(items.id, itemId));
  return row;
}

/** The writer's words for an Item's per-Person draft as it proposed them, and where the draft sits. */
export async function proposalOfItem(tx: CampaignsTx, itemId: string) {
  const [row] = await tx
    .select({ campaignId: campaignActions.campaignId, stepKey: campaignActions.stepKey, proposedText: campaignActions.proposedText })
    .from(campaignActions)
    .innerJoin(items, eq(items.actionId, campaignActions.actionId))
    .where(eq(items.id, itemId));
  return row;
}

/** A person's notes for a step's writer, saved only over the revision they read. False when it moved. */
export async function setWriterNotes(tx: CampaignsTx, a: { campaignId: string; stepKey: string; notes: string | null; revision: number; now: Date }): Promise<boolean> {
  const rows = await tx
    .update(campaignSteps)
    .set({ writerNotes: a.notes, writerNotesRevision: a.revision + 1, updatedAt: a.now })
    .where(and(eq(campaignSteps.campaignId, a.campaignId), eq(campaignSteps.stepKey, a.stepKey), eq(campaignSteps.writerNotesRevision, a.revision)))
    .returning({ stepKey: campaignSteps.stepKey });
  return rows.length === 1;
}

/** A person's notes on the Campaign, saved only over the revision they read. False when it moved or there is no such Campaign. */
export async function setCampaignNotes(tx: CampaignsTx, a: { campaignId: string; notes: string; revision: number; userId: string; now: Date }): Promise<boolean> {
  const rows = await tx
    .update(campaigns)
    .set({ notes: a.notes, notesRevision: a.revision + 1, notesUpdatedBy: a.userId, notesUpdatedAt: a.now, updatedAt: a.now })
    .where(and(eq(campaigns.id, a.campaignId), eq(campaigns.notesRevision, a.revision)))
    .returning({ id: campaigns.id });
  return rows.length === 1;
}

/** A rewrite is a new proposal, so edits after it are measured against its words. */
export async function setProposedText(tx: CampaignsTx, itemId: string, text: string) {
  const [item] = await tx.select({ actionId: items.actionId }).from(items).where(eq(items.id, itemId));
  if (item?.actionId) await tx.update(campaignActions).set({ proposedText: text }).where(eq(campaignActions.actionId, item.actionId));
}

export async function linkAction(tx: CampaignsTx, a: { workspaceId: string; campaignId: string; stepKey: string; personId: string; itemId: string; producer?: unknown; checks?: unknown; proposedText?: string }) {
  const [item] = await tx.select({ actionId: items.actionId }).from(items).where(eq(items.id, a.itemId));
  const { itemId: _, ...link } = a;
  await tx.insert(campaignActions).values({ ...link, actionId: item!.actionId! }).onConflictDoNothing();
}


export async function isConnectedMailbox(tx: CampaignsTx, id: string): Promise<boolean> {
  const [row] = await tx.select({ connection: credentials.connection }).from(credentials).where(eq(credentials.id, id));
  return !!row?.connection;
}

export const lockStep = async (tx: CampaignsTx, campaignId: string, stepKey: string): Promise<StepRow | undefined> =>
  (await tx.select().from(campaignSteps).where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.stepKey, stepKey))).for("update"))[0];

export async function fillTemplate(tx: CampaignsTx, a: { campaignId: string; stepKey: string; template: unknown; revision: number; runId: string | null; now: Date }) {
  await tx
    .update(campaignSteps)
    .set({ template: a.template, templateRevision: a.revision, draftRunId: a.runId, updatedAt: a.now })
    .where(and(eq(campaignSteps.campaignId, a.campaignId), eq(campaignSteps.stepKey, a.stepKey)));
}

/** Adds a warning to each template these runs wrote that no person has saved over since. */
export async function warnTemplatesOfRuns(tx: CampaignsTx, runIds: readonly string[], warning: unknown) {
  if (!runIds.length) return;
  await tx
    .update(campaignSteps)
    .set({ template: sql`jsonb_set(${campaignSteps.template}, '{warnings}', coalesce(${campaignSteps.template}->'warnings', '[]'::jsonb) || ${JSON.stringify([warning])}::jsonb)` })
    .where(and(inArray(campaignSteps.draftRunId, [...runIds]), isNotNull(campaignSteps.template)));
}

/** Whether anything has been written for this campaign, by a template or for a Person. */
export async function anyDrafts(tx: CampaignsTx, campaignId: string): Promise<boolean> {
  const templates = await tx.select({ key: campaignSteps.stepKey }).from(campaignSteps).where(and(eq(campaignSteps.campaignId, campaignId), isNotNull(campaignSteps.template))).limit(1);
  if (templates.length) return true;
  return (await tx.select({ id: campaignActions.actionId }).from(campaignActions).where(eq(campaignActions.campaignId, campaignId)).limit(1)).length > 0;
}

export async function setDraftingMode(tx: CampaignsTx, campaignId: string, mode: "template" | "per_person", now: Date) {
  await tx.update(campaigns).set({ draftingMode: mode, updatedAt: now }).where(eq(campaigns.id, campaignId));
}

/** Whether anything has been written for one step: its template, or a draft for a Person. */
export async function stepHasDraft(tx: CampaignsTx, campaignId: string, stepKey: string): Promise<boolean> {
  const [step] = await tx.select({ template: campaignSteps.template }).from(campaignSteps).where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.stepKey, stepKey)));
  if (step?.template) return true;
  return (await stepActionIds(tx, campaignId, stepKey)).length > 0;
}

export async function setStepMode(tx: CampaignsTx, campaignId: string, stepKey: string, mode: "template" | "per_person", now: Date) {
  await tx.update(campaignSteps).set({ draftingMode: mode, updatedAt: now }).where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.stepKey, stepKey)));
}

/** A tracking domain's state in this Workspace, or undefined when it has none by that id. */
export async function trackingDomainState(tx: CampaignsTx, domainId: string): Promise<string | undefined> {
  const [row] = await tx.select({ state: trackingDomains.state }).from(trackingDomains).where(eq(trackingDomains.id, domainId));
  return row?.state;
}

/** Link tracking on a domain, or off; off turns per-Person off too. Who changed it is kept either way (ADR 0035 rule 016). */
export async function setTracking(tx: CampaignsTx, campaignId: string, a: { domainId: string; wordingVersion: number } | null, userId: string, now: Date) {
  const who = { trackingSetBy: userId, trackingSetAt: now, updatedAt: now };
  await tx
    .update(campaigns)
    .set(a ? { ...who, trackingOn: true, trackingDomainId: a.domainId, trackingWordingVersion: a.wordingVersion } : { ...who, trackingOn: false, perPersonOn: false, perPersonSetBy: userId, perPersonSetAt: now })
    .where(eq(campaigns.id, campaignId));
}

/** Per-Person counting on (with the wording shown) or off. */
export async function setPerPerson(tx: CampaignsTx, campaignId: string, wordingVersion: number | null, userId: string, now: Date) {
  await tx
    .update(campaigns)
    .set({ perPersonOn: wordingVersion !== null, perPersonSetBy: userId, perPersonSetAt: now, updatedAt: now, ...(wordingVersion !== null && { perPersonWordingVersion: wordingVersion }) })
    .where(eq(campaigns.id, campaignId));
}

export async function setOutsideContent(tx: CampaignsTx, campaignId: string, allowed: boolean, userId: string, now: Date) {
  await tx.update(campaigns).set({ outsideContentAllowed: allowed, outsideContentSetBy: userId, outsideContentSetAt: now, updatedAt: now }).where(eq(campaigns.id, campaignId));
}

export async function setAdvance(tx: CampaignsTx, campaignId: string, a: { advance: "offer" | "run"; timeZone: string | null; userId: string }, now: Date) {
  await tx.update(campaigns).set({ advance: a.advance, advanceSetBy: a.userId, advanceSetAt: now, advanceTimeZone: a.timeZone, updatedAt: now }).where(eq(campaigns.id, campaignId));
}

/** Whether a plan version changed this step and nobody has chosen what to do yet. */
const planChangeUndecided = (campaignId: SQLWrapper, stepKey: SQLWrapper) =>
  sql<boolean>`exists (select 1 from ${campaignPlanChanges} where ${campaignPlanChanges.campaignId} = ${campaignId} and ${campaignPlanChanges.stepKey} = ${stepKey} and ${campaignPlanChanges.decided} is null)`;

/** The campaign and Person an Action belongs to, for the checks that run before it goes. */
/** A post's Action and its campaign. A post has no Person, so it can be paused or held by a plan change. */
async function campaignOfPost(tx: CampaignsTx, actionId: string) {
  const [row] = await tx
    .select({ pausedAt: campaigns.pausedAt, planChanged: planChangeUndecided(socialPosts.campaignId, socialPosts.stepKey) })
    .from(socialPosts).innerJoin(campaigns, eq(campaigns.id, socialPosts.campaignId)).where(eq(socialPosts.actionId, actionId));
  return row ? { ...row, status: "active" } : null;
}

/** The Items of a campaign's posts, ones Direx publishes and ones copied by hand, so cancelling a step reaches both. */
export const activePosts = (tx: CampaignsTx, campaignId: string) =>
  tx.select({ itemId: socialPosts.itemId, stepKey: socialPosts.stepKey }).from(socialPosts).where(eq(socialPosts.campaignId, campaignId));

/** How each step's posts stand, published or by hand. */
export function postCounts(tx: CampaignsTx, campaignId: string) {
  const state = sql<string>`coalesce(${actions.state}, ${items.state})`;
  return tx
    .select({ stepKey: socialPosts.stepKey, state, n: sql<number>`count(*)::int` })
    .from(socialPosts)
    .innerJoin(items, eq(items.id, socialPosts.itemId))
    .leftJoin(actions, eq(actions.id, socialPosts.actionId))
    .where(eq(socialPosts.campaignId, campaignId))
    .groupBy(socialPosts.stepKey, state);
}

export async function campaignOfAction(tx: CampaignsTx, actionId: string) {
  const [row] = await tx
    .select({ campaignId: campaignActions.campaignId, personId: campaignActions.personId, pausedAt: campaigns.pausedAt, status: campaignPeople.status, planChanged: planChangeUndecided(campaignActions.campaignId, campaignActions.stepKey) })
    .from(campaignActions)
    .innerJoin(campaigns, eq(campaigns.id, campaignActions.campaignId))
    .innerJoin(campaignPeople, and(eq(campaignPeople.campaignId, campaignActions.campaignId), eq(campaignPeople.personId, campaignActions.personId)))
    .where(eq(campaignActions.actionId, actionId));
  return row ?? campaignOfPost(tx, actionId);
}

/** Tracked link uses made for this Action. The caller matches them against the fixed text. */
export function actionTrackingUses(tx: CampaignsTx, actionId: string) {
  return tx.select({ linkId: trackedLinkUses.linkId, tokenHash: trackedLinkUses.tokenHash, hostname: trackingDomains.hostname, inputsHash: trackedLinkUses.inputsHash })
    .from(trackedLinkUses)
    .innerJoin(trackedLinks, eq(trackedLinks.id, trackedLinkUses.linkId))
    .innerJoin(trackingDomains, eq(trackingDomains.id, trackedLinks.domainId))
    .innerJoin(items, eq(items.actionId, trackedLinkUses.actionId))
    .where(and(eq(trackedLinkUses.actionId, actionId), sql`(
      ${trackedLinkUses.tokenHash} is not null
      or ${items.payload} -> 'fixedTokenlessLinks' ->> ${trackedLinkUses.linkId} is null
      or ${items.payload} -> 'fixedTokenlessLinks' ->> ${trackedLinkUses.linkId} = ${trackedLinkUses.inputsHash}
    )`));
}

/** Keep the current inputs for regenerated tokenless URLs, which can repeat across revisions.
 * The use rows stay immutable; links carried forward without regeneration keep their last inputs.
 */
export async function noteFixedTokenlessUses(tx: CampaignsTx, itemId: string, linkIds: string[], inputsHash: string) {
  const fixed = Object.fromEntries(linkIds.map((id) => [id, inputsHash]));
  await tx.update(items).set({ payload: sql`jsonb_set(coalesce(${items.payload}, '{}'::jsonb), '{fixedTokenlessLinks}',
    coalesce(${items.payload} -> 'fixedTokenlessLinks', '{}'::jsonb) || ${JSON.stringify(fixed)}::jsonb)` })
    .where(eq(items.id, itemId));
}

/** The step and joining time behind an Action, for standing rules. */
export async function linkOfAction(tx: CampaignsTx, actionId: string) {
  const [row] = await tx
    .select({ campaignId: campaignActions.campaignId, stepKey: campaignActions.stepKey, joinedAt: campaignPeople.at })
    .from(campaignActions)
    .innerJoin(campaignPeople, and(eq(campaignPeople.campaignId, campaignActions.campaignId), eq(campaignPeople.personId, campaignActions.personId)))
    .where(eq(campaignActions.actionId, actionId));
  return row ?? null;
}

/** What an agent-written rule reads about one draft: who wrote it, what checked it, and the campaign's answer now. */
export async function draftRecordOf(tx: CampaignsTx, actionId: string) {
  const [row] = await tx
    .select({ producer: campaignActions.producer, checks: campaignActions.checks, outsideContent: campaigns.outsideContentAllowed, spec: actions.spec })
    .from(campaignActions)
    .innerJoin(campaigns, and(eq(campaigns.workspaceId, campaignActions.workspaceId), eq(campaigns.id, campaignActions.campaignId)))
    .innerJoin(actions, and(eq(actions.workspaceId, campaignActions.workspaceId), eq(actions.id, campaignActions.actionId)))
    .where(eq(campaignActions.actionId, actionId));
  return row ?? null;
}

export async function campaignStepForRule(tx: CampaignsTx, campaignId: string, stepKey: string) {
  const [row] = await tx
    .select({ step: campaignSteps, tainted: agentRuns.tainted, agent: agentRuns.agent, draftingMode: campaignSteps.draftingMode, outsideContent: campaigns.outsideContentAllowed })
    .from(campaignSteps)
    .innerJoin(campaigns, and(eq(campaigns.workspaceId, campaignSteps.workspaceId), eq(campaigns.id, campaignSteps.campaignId)))
    .leftJoin(agentRuns, eq(agentRuns.id, campaignSteps.draftRunId))
    .where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.stepKey, stepKey)));
  return row ?? null;
}

/** Sent or unfinished emails keep their step's kind; blocked and cancelled Actions cannot send. */
export async function stepHasEmailWork(tx: CampaignsTx, campaignId: string, stepKey: string): Promise<boolean> {
  const rows = await tx.select({ id: actions.id }).from(campaignActions)
    .innerJoin(actions, eq(actions.id, campaignActions.actionId))
    .where(and(eq(campaignActions.campaignId, campaignId), eq(campaignActions.stepKey, stepKey), notInArray(actions.state, ["blocked", "cancelled"])))
    .limit(1);
  return rows.length > 0;
}

export const stepActionIds = async (tx: CampaignsTx, campaignId: string, stepKey: string) =>
  (await tx.select({ id: campaignActions.actionId }).from(campaignActions).where(and(eq(campaignActions.campaignId, campaignId), eq(campaignActions.stepKey, stepKey)))).map((r) => r.id);

export const peopleCount = async (tx: CampaignsTx, campaignId: string) =>
  (await tx.select({ n: sql<number>`count(*)::int` }).from(campaignPeople).where(and(eq(campaignPeople.campaignId, campaignId), eq(campaignPeople.status, "active"))))[0]!.n;

export async function setPaused(tx: CampaignsTx, campaignId: string, userId: string | null, now: Date): Promise<boolean> {
  const rows = await tx.update(campaigns).set({ pausedAt: userId ? now : null, pausedBy: userId, updatedAt: now }).where(eq(campaigns.id, campaignId)).returning({ id: campaigns.id });
  return rows.length > 0;
}

/** Marks this Person replied in each campaign that has actually emailed them, and says which. */
export async function markReplied(tx: CampaignsTx, personId: string) {
  const emailed = await tx
    .selectDistinct({ campaignId: campaignActions.campaignId })
    .from(campaignActions)
    .innerJoin(actions, eq(actions.id, campaignActions.actionId))
    .innerJoin(campaignPeople, and(eq(campaignPeople.campaignId, campaignActions.campaignId), eq(campaignPeople.personId, campaignActions.personId)))
    .where(and(eq(campaignActions.personId, personId), eq(actions.state, "sent"), eq(campaignPeople.status, "active")));
  for (const { campaignId } of emailed) {
    await tx.update(campaignPeople).set({ status: "replied" }).where(and(eq(campaignPeople.campaignId, campaignId), eq(campaignPeople.personId, personId)));
  }
  return emailed;
}

/** Another campaign still working on this Person: they're active there and it hasn't finished with them. A Draft's People never count (ADR 0023). */
export async function liveElsewhere(tx: CampaignsTx, campaignId: string, personId: string): Promise<string | null> {
  const others = await tx
    .select({ id: campaignPeople.campaignId })
    .from(campaignPeople)
    .innerJoin(campaigns, eq(campaigns.id, campaignPeople.campaignId))
    .innerJoin(marketingPlans, eq(marketingPlans.id, campaigns.planId))
    .where(and(eq(campaignPeople.personId, personId), eq(campaignPeople.status, "active"), ne(campaignPeople.campaignId, campaignId), isNull(marketingPlans.archivedAt), isNotNull(marketingPlans.currentVersion)));
  for (const { id } of others) {
    const states = await tx
      .select({ state: actions.state })
      .from(campaignActions)
      .innerJoin(actions, eq(actions.id, campaignActions.actionId))
      .where(and(eq(campaignActions.campaignId, id), eq(campaignActions.personId, personId)));
    if (!states.length || states.some((s) => !["sent", "blocked", "cancelled"].includes(s.state))) return id;
  }
  return null;
}

/** Who was added to follow another campaign that hasn't finished with them yet. */
export async function stillWaiting(tx: CampaignsTx, campaignId: string): Promise<Set<string>> {
  const rows = await tx.select({ personId: campaignPeople.personId, after: campaignPeople.afterCampaignId }).from(campaignPeople).where(and(eq(campaignPeople.campaignId, campaignId), isNotNull(campaignPeople.afterCampaignId)));
  const waiting = new Set<string>();
  for (const r of rows) {
    if (await liveElsewhere(tx, campaignId, r.personId)) waiting.add(r.personId);
  }
  return waiting;
}

export const personRow = async (tx: CampaignsTx, campaignId: string, personId: string) =>
  (await tx.select().from(campaignPeople).where(and(eq(campaignPeople.campaignId, campaignId), eq(campaignPeople.personId, personId))))[0];

export type OutcomeRow = typeof campaignOutcomes.$inferSelect;
// The table's check holds kind to these two.
export type OutcomeKind = "meeting" | "deal";

/** A mark or an undo. An undo of a mark already undone adds nothing and returns undefined. */
export const insertOutcome = async (tx: CampaignsTx, row: typeof campaignOutcomes.$inferInsert): Promise<OutcomeRow | undefined> =>
  (await tx.insert(campaignOutcomes).values(row).onConflictDoNothing({ target: campaignOutcomes.voids }).returning())[0];

export const readOutcome = async (tx: CampaignsTx, campaignId: string, id: string): Promise<OutcomeRow | undefined> =>
  (await tx.select().from(campaignOutcomes).where(and(eq(campaignOutcomes.campaignId, campaignId), eq(campaignOutcomes.id, id))))[0];

const undo = alias(campaignOutcomes, "undo");
/** Each Person's live marks, oldest first: marks no undo row voids. */
export async function liveOutcomes(tx: CampaignsTx, campaignId: string, personIds: readonly string[]): Promise<Map<string, { id: string; kind: OutcomeKind; on: string }[]>> {
  const live = new Map<string, { id: string; kind: OutcomeKind; on: string }[]>();
  if (!personIds.length) return live;
  const rows = await tx
    .select({ id: campaignOutcomes.id, personId: campaignOutcomes.personId, kind: campaignOutcomes.kind, on: campaignOutcomes.occurredOn })
    .from(campaignOutcomes)
    .leftJoin(undo, eq(undo.voids, campaignOutcomes.id))
    .where(and(eq(campaignOutcomes.campaignId, campaignId), inArray(campaignOutcomes.personId, [...personIds]), isNull(campaignOutcomes.voids), isNull(undo.id)))
    .orderBy(campaignOutcomes.occurredOn, campaignOutcomes.at);
  for (const r of rows) live.set(r.personId, [...(live.get(r.personId) ?? []), { id: r.id, kind: r.kind as OutcomeKind, on: r.on! }]);
  return live;
}

/** Per kind ever marked on the Campaign, the People with a live mark of it. A kind whose marks were all undone stays, at 0. */
export const outcomeCounts = (tx: CampaignsTx, campaignId: string) =>
  tx
    .select({ kind: campaignOutcomes.kind, people: sql<number>`count(distinct ${campaignOutcomes.personId}) filter (where ${campaignOutcomes.voids} is null and ${undo.id} is null)::int` })
    .from(campaignOutcomes)
    .leftJoin(undo, eq(undo.voids, campaignOutcomes.id))
    .where(eq(campaignOutcomes.campaignId, campaignId))
    .groupBy(campaignOutcomes.kind);

export async function markConflict(tx: CampaignsTx, campaignId: string, personId: string, itemId: string) {
  await tx.update(campaignPeople).set({ status: "conflict", conflictItemId: itemId }).where(and(eq(campaignPeople.campaignId, campaignId), eq(campaignPeople.personId, personId)));
}

export async function settleConflict(tx: CampaignsTx, p: { campaignId: string; personId: string; otherCampaignId: string }, choice: "skip" | "add_after", now: Date) {
  await tx
    .update(campaignPeople)
    .set(choice === "skip" ? { status: "removed", conflictItemId: null, at: now } : { status: "active", conflictItemId: null, afterCampaignId: p.otherCampaignId, at: now })
    .where(and(eq(campaignPeople.campaignId, p.campaignId), eq(campaignPeople.personId, p.personId)));
}

/** How many People in a campaign replied. */
export async function repliedCount(tx: CampaignsTx, campaignId: string) {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(campaignPeople)
    .where(and(eq(campaignPeople.campaignId, campaignId), eq(campaignPeople.status, "replied")));
  return r!.n;
}

/** Everything of this campaign waiting for a person: emails, posts and DMs alike, found by their group. */
export async function waitingCount(tx: CampaignsTx, campaignId: string) {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(items)
    .leftJoin(actions, eq(actions.id, items.actionId))
    .where(
      and(
        or(eq(items.groupKey, `campaign:${campaignId}`), sql`${items.groupKey} like ${`campaign:${campaignId}:%`}`),
        sql`coalesce(${actions.state}, ${items.state}) = 'needs_approval'`,
      ),
    );
  return r!.n;
}

/** The steps of this campaign that have at least one Item not cancelled: emails, posts and DMs alike, by their group. */
export async function draftedSteps(tx: CampaignsTx, campaignId: string): Promise<Set<string>> {
  const prefix = `campaign:${campaignId}:step:`;
  const rows = await tx
    .selectDistinct({ groupKey: items.groupKey })
    .from(items)
    .leftJoin(actions, eq(actions.id, items.actionId))
    .where(and(sql`${items.groupKey} like ${`${prefix}%`}`, sql`coalesce(${actions.state}, ${items.state}) <> 'cancelled'`));
  // A group key goes on after the step (`…:step:<key>:clip:<id>`), so the key ends at the next colon.
  return new Set(rows.map((r) => r.groupKey!.slice(prefix.length).split(":")[0]!));
}

/**
 * Each step's Items by the state a person sees, dated or not: emails, posts and DMs alike, by their group.
 * Claimed and dispatching show as scheduled, as everywhere else.
 */
export async function stepStateCounts(tx: CampaignsTx, campaignId: string) {
  const prefix = `campaign:${campaignId}:step:`;
  const state = sql<VisibleState>`case when coalesce(${actions.state}, ${items.state}) in ('claimed', 'dispatching') then 'scheduled' else coalesce(${actions.state}, ${items.state}) end`;
  const rows = await tx
    .select({ groupKey: items.groupKey, state, n: sql<number>`count(*)::int` })
    .from(items)
    .leftJoin(actions, eq(actions.id, items.actionId))
    .where(sql`${items.groupKey} like ${`${prefix}%`}`)
    .groupBy(items.groupKey, state);
  // A group key goes on after the step (`…:step:<key>:clip:<id>`), so the key ends at the next colon.
  const counts = new Map<string, { stepKey: string; state: VisibleState; n: number }>();
  for (const r of rows) {
    const stepKey = r.groupKey!.slice(prefix.length).split(":")[0]!;
    const key = `${stepKey}:${r.state}`;
    const c = counts.get(key);
    if (c) c.n += r.n;
    else counts.set(key, { stepKey, state: r.state, n: r.n });
  }
  return [...counts.values()];
}

/**
 * What this campaign has sent, by kind and channel, and what came back on its email: bounces and
 * opt-outs read from replies, both tied to the Action they answered. Copy-and-paste posts are left
 * out: one marked posted without a link can't be told from one never posted.
 */
export async function resultCounts(tx: CampaignsTx, campaignId: string) {
  const ours = tx.select({ id: campaignActions.actionId }).from(campaignActions).where(eq(campaignActions.campaignId, campaignId));
  const posts = await tx
    .select({ channel: socialPosts.connection, n: sql<number>`count(*)::int` })
    .from(socialPosts)
    .innerJoin(actions, eq(actions.id, socialPosts.actionId))
    .where(and(eq(socialPosts.campaignId, campaignId), eq(actions.state, "sent")))
    .groupBy(socialPosts.connection);
  const dms = await tx
    .select({ stepKey: campaignDms.stepKey, channel: campaignDms.channel, n: sql<number>`count(*)::int` })
    .from(campaignDms)
    .where(and(eq(campaignDms.campaignId, campaignId), isNotNull(campaignDms.sentAt)))
    .groupBy(campaignDms.stepKey, campaignDms.channel);
  const [back] = await tx
    .select({
      bounced: sql<number>`count(*) filter (where ${replySignals.kind} = 'bounce')::int`,
      optedOut: sql<number>`count(*) filter (where ${replySignals.kind} = 'reply' and ${replySignals.status} = 'opted_out')::int`,
    })
    .from(replySignals)
    .where(inArray(replySignals.actionId, ours));
  return { posts, dms, bounced: back!.bounced, optedOut: back!.optedOut };
}

/** People who replied to each step's email, opt-outs included. A reply with no Action belongs to no Campaign. */
export const repliedPeople = (tx: CampaignsTx, campaignId: string) =>
  tx
    .selectDistinct({ stepKey: campaignActions.stepKey, personId: campaignActions.personId })
    .from(replySignals)
    .innerJoin(campaignActions, eq(campaignActions.actionId, replySignals.actionId))
    .where(and(eq(campaignActions.campaignId, campaignId), eq(replySignals.kind, "reply")));

/**
 * People whose reply to each step's email was ever labelled interested. A replaced reply Item is cancelled
 * but keeps its payload, so any state counts. The kind is the outreach reply desk's.
 */
// ponytail: reads reply Items' payload unindexed; an expression index on payload->>'actionId' if pilot volume makes it slow.
export const interestedPeople = (tx: CampaignsTx, campaignId: string) =>
  tx
    .selectDistinct({ stepKey: campaignActions.stepKey, personId: campaignActions.personId })
    .from(items)
    // Compared as text: another kind's payload may hold an actionId that isn't a uuid.
    .innerJoin(campaignActions, sql`${campaignActions.actionId}::text = ${items.payload}->>'actionId'`)
    .where(and(eq(campaignActions.campaignId, campaignId), eq(items.kind, "reply"), sql`${items.payload}->>'label' = 'interested'`));

export function stepCounts(tx: CampaignsTx, campaignId: string) {
  return tx
    .select({ stepKey: campaignActions.stepKey, state: actions.state, n: sql<number>`count(*)::int` })
    .from(campaignActions)
    .innerJoin(actions, eq(actions.id, campaignActions.actionId))
    .where(eq(campaignActions.campaignId, campaignId))
    .groupBy(campaignActions.stepKey, actions.state);
}

export async function saveStep(tx: CampaignsTx, a: { workspaceId: string; campaignId: string; stepKey: string; setup: StepSetup; now: Date }) {
  // A step that stops being an SEO brief step drops its page, search and Brief run.
  const set = { ...a.setup, ...(a.setup.type !== "seo_brief" && { seoSetup: null, briefRunId: null }), updatedAt: a.now };
  await tx
    .insert(campaignSteps)
    .values({ workspaceId: a.workspaceId, campaignId: a.campaignId, stepKey: a.stepKey, ...set })
    .onConflictDoUpdate({ target: [campaignSteps.workspaceId, campaignSteps.campaignId, campaignSteps.stepKey], set });
}

/** The Mailboxes a step's emails are shared across, in the order they were added. */
export async function stepMailboxes(tx: CampaignsTx, campaignId: string, stepKey: string): Promise<string[]> {
  const rows = await tx
    .select({ id: campaignStepMailboxes.credentialId })
    .from(campaignStepMailboxes)
    .where(and(eq(campaignStepMailboxes.campaignId, campaignId), eq(campaignStepMailboxes.stepKey, stepKey)))
    .orderBy(asc(campaignStepMailboxes.addedAt), asc(campaignStepMailboxes.credentialId));
  return rows.map((r) => r.id);
}

/** Every step's Mailboxes in a Campaign, each list in the order they were added. */
export async function campaignMailboxes(tx: CampaignsTx, campaignId: string): Promise<Map<string, string[]>> {
  const rows = await tx
    .select({ stepKey: campaignStepMailboxes.stepKey, id: campaignStepMailboxes.credentialId })
    .from(campaignStepMailboxes)
    .where(eq(campaignStepMailboxes.campaignId, campaignId))
    .orderBy(asc(campaignStepMailboxes.addedAt), asc(campaignStepMailboxes.credentialId));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.stepKey, [...(out.get(r.stepKey) ?? []), r.id]);
  return out;
}

/** Sets a step's Mailboxes in the order given; one already on the step keeps its place. */
export async function saveStepMailboxes(tx: CampaignsTx, a: { workspaceId: string; campaignId: string; stepKey: string; ids: readonly string[]; now: Date }) {
  const mine = and(eq(campaignStepMailboxes.campaignId, a.campaignId), eq(campaignStepMailboxes.stepKey, a.stepKey));
  await tx.delete(campaignStepMailboxes).where(a.ids.length ? and(mine, notInArray(campaignStepMailboxes.credentialId, [...a.ids])) : mine);
  const retained = await tx.select({ addedAt: campaignStepMailboxes.addedAt }).from(campaignStepMailboxes).where(mine);
  // Append after retained rows even when saves share a clock tick or the clock moves backwards.
  const start = Math.max(a.now.getTime(), ...retained.map((r) => r.addedAt.getTime() + 1));
  if (a.ids.length) await tx.insert(campaignStepMailboxes).values(a.ids.map((credentialId, i) => ({ workspaceId: a.workspaceId, campaignId: a.campaignId, stepKey: a.stepKey, credentialId, addedAt: new Date(start + i) }))).onConflictDoNothing();
}

/** An SEO brief step's page and search, and the Brief run Make brief just started. */
export async function saveBriefRun(tx: CampaignsTx, a: { campaignId: string; stepKey: string; setup: { page: string | null; query: string }; runId: string; now: Date }) {
  await tx
    .update(campaignSteps)
    .set({ seoSetup: a.setup, briefRunId: a.runId, updatedAt: a.now })
    .where(and(eq(campaignSteps.campaignId, a.campaignId), eq(campaignSteps.stepKey, a.stepKey)));
}

/** A plan step nobody has set up yet is a manual step; give it its row so another step can point at it. */
export async function ensureStep(tx: CampaignsTx, a: { workspaceId: string; campaignId: string; stepKey: string; now: Date }) {
  await tx.insert(campaignSteps).values({ workspaceId: a.workspaceId, campaignId: a.campaignId, stepKey: a.stepKey, type: "manual", updatedAt: a.now }).onConflictDoNothing();
}

export type OutputRow = typeof campaignStepOutputs.$inferSelect;

/** The current output of a step: its latest version, or null. */
export async function latestOutput(tx: CampaignsTx, campaignId: string, stepKey: string): Promise<OutputRow | null> {
  const [row] = await tx
    .select()
    .from(campaignStepOutputs)
    .where(and(eq(campaignStepOutputs.campaignId, campaignId), eq(campaignStepOutputs.stepKey, stepKey)))
    .orderBy(desc(campaignStepOutputs.version))
    .limit(1);
  return row ?? null;
}

export const insertOutput = (tx: CampaignsTx, row: typeof campaignStepOutputs.$inferInsert) => tx.insert(campaignStepOutputs).values(row);

/** The public link of a post step's post on one account: what the network reported, or what a person pasted. */
export async function postUrlOf(tx: CampaignsTx, a: { campaignId: string; stepKey: string; connection: string; networkId: string }): Promise<string | null> {
  const [row] = await tx
    .select({ result: actions.result, postedUrl: socialPosts.postedUrl })
    .from(socialPosts)
    .leftJoin(actions, eq(actions.id, socialPosts.actionId))
    .where(and(eq(socialPosts.campaignId, a.campaignId), eq(socialPosts.stepKey, a.stepKey), eq(socialPosts.connection, a.connection), eq(socialPosts.networkId, a.networkId)))
    .limit(1);
  if (!row) return null;
  const reported = (row.result as { url?: unknown } | null)?.url;
  return typeof reported === "string" ? reported : row.postedUrl;
}

/** The accounts a post step has posts for, named as social_posts names them. */
export const postAccountsOf = (tx: CampaignsTx, campaignId: string, stepKey: string) =>
  tx
    .select({ connection: socialPosts.connection, networkId: socialPosts.networkId })
    .from(socialPosts)
    .where(and(eq(socialPosts.campaignId, campaignId), eq(socialPosts.stepKey, stepKey)));

export type ClipStepRunRow = typeof clipStepRuns.$inferSelect;

/** One more recording on a clips step: its setup and the run making its clips. */
export const insertClipStepRun = (tx: CampaignsTx, row: typeof clipStepRuns.$inferInsert) => tx.insert(clipStepRuns).values(row);

/** A clips step's recordings, newest first. */
export const clipStepRunsOf = (tx: CampaignsTx, campaignId: string, stepKey: string): Promise<ClipStepRunRow[]> =>
  tx
    .select()
    .from(clipStepRuns)
    .where(and(eq(clipStepRuns.campaignId, campaignId), eq(clipStepRuns.stepKey, stepKey)))
    .orderBy(desc(clipStepRuns.createdAt), desc(clipStepRuns.runId));

/** The recording a run is making clips for, if it is one. */
export async function clipStepRunOf(tx: CampaignsTx, runId: string): Promise<ClipStepRunRow | undefined> {
  const [row] = await tx.select().from(clipStepRuns).where(eq(clipStepRuns.runId, runId));
  return row;
}

/** Email steps written per Person in Campaigns that aren't paused, across Workspaces. Ids only. */
export async function perPersonSteps(): Promise<{ workspaceId: string; campaignId: string; stepKey: string }[]> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id, campaign_id, step_key from system.per_person_steps()`));
  return rows.map((r) => ({ workspaceId: r.workspace_id as string, campaignId: r.campaign_id as string, stepKey: r.step_key as string }));
}

/**
 * A Campaign's Items that could still move with its launch: its emails and posts whose Action hasn't
 * started going out or finished, and own Items not yet decided. Each with its planned time and state.
 */
export async function movableItems(tx: CampaignsTx, campaignId: string) {
  const state = sql<string>`coalesce(${actions.state}, ${items.state})`;
  const open = notInArray(state, ["claimed", "dispatching", "sent", "blocked", "cancelled", "applied"]);
  const emails = await tx
    .select({ itemId: items.id, plannedAt: items.plannedAt, state, stepKey: campaignActions.stepKey })
    .from(campaignActions)
    .innerJoin(items, eq(items.actionId, campaignActions.actionId))
    .innerJoin(actions, eq(actions.id, campaignActions.actionId))
    .where(and(eq(campaignActions.campaignId, campaignId), open, isNotNull(items.plannedAt)));
  const posts = await tx
    .select({ itemId: items.id, plannedAt: items.plannedAt, state, stepKey: socialPosts.stepKey })
    .from(socialPosts)
    .innerJoin(items, eq(items.id, socialPosts.itemId))
    .leftJoin(actions, eq(actions.id, socialPosts.actionId))
    .where(and(eq(socialPosts.campaignId, campaignId), open, isNotNull(items.plannedAt)));
  return [...emails, ...posts].map((r) => ({ itemId: r.itemId, plannedAt: r.plannedAt!, state: r.state, stepKey: r.stepKey }));
}

export async function setAnchor(tx: CampaignsTx, campaignId: string, a: { on: string; userId: string }, now: Date) {
  await tx.update(campaigns).set({ anchorOn: a.on, anchorMovedBy: a.userId, anchorMovedAt: now, updatedAt: now }).where(eq(campaigns.id, campaignId));
}

/** Steps others wait on, in Campaigns that aren't paused, across Workspaces. Ids only. */
export async function dependedOnSteps(): Promise<{ workspaceId: string; campaignId: string; stepKey: string }[]> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id, campaign_id, step_key from system.depended_on_steps()`));
  return rows.map((r) => ({ workspaceId: r.workspace_id as string, campaignId: r.campaign_id as string, stepKey: r.step_key as string }));
}

export async function setStallWaitFrom(tx: CampaignsTx, campaignId: string, stepKey: string, now: Date) {
  await tx.update(campaignSteps).set({ stallWaitFrom: now, updatedAt: now }).where(and(eq(campaignSteps.campaignId, campaignId), eq(campaignSteps.stepKey, stepKey)));
}

export async function waiveDependency(tx: CampaignsTx, campaignId: string, stepKeys: readonly string[], userId: string, now: Date) {
  if (!stepKeys.length) return;
  await tx.update(campaignSteps).set({ dependencyWaivedAt: now, dependencyWaivedBy: userId, updatedAt: now }).where(and(eq(campaignSteps.campaignId, campaignId), inArray(campaignSteps.stepKey, [...stepKeys])));
}

export async function cancelSteps(tx: CampaignsTx, campaignId: string, stepKeys: readonly string[], userId: string, now: Date) {
  if (!stepKeys.length) return;
  await tx.update(campaignSteps).set({ cancelledAt: now, cancelledBy: userId, updatedAt: now }).where(and(eq(campaignSteps.campaignId, campaignId), inArray(campaignSteps.stepKey, [...stepKeys])));
}

/** A step's first output, the moment it first existed. */
export async function firstOutput(tx: CampaignsTx, campaignId: string, stepKey: string): Promise<OutputRow | null> {
  const [row] = await tx.select().from(campaignStepOutputs).where(and(eq(campaignStepOutputs.campaignId, campaignId), eq(campaignStepOutputs.stepKey, stepKey))).orderBy(campaignStepOutputs.version).limit(1);
  return row ?? null;
}

export async function setAnchorStep(tx: CampaignsTx, campaignId: string, stepKey: string | null, now: Date) {
  await tx.update(campaigns).set({ anchorStepKey: stepKey, updatedAt: now }).where(eq(campaigns.id, campaignId));
}

/** Campaigns whose launch follows a step, that aren't paused, across Workspaces. Ids only. */
export async function anchoredCampaigns(): Promise<{ workspaceId: string; campaignId: string }[]> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id, campaign_id from system.anchored_campaigns()`));
  return rows.map((r) => ({ workspaceId: r.workspace_id as string, campaignId: r.campaign_id as string }));
}

/** Plan change work owed after a commit, written in the approval's transaction. The same key twice is one row. */
export async function putSettlement(tx: CampaignsTx, a: { workspaceId: string; campaignId: string; key: string; work: unknown; now: Date }) {
  await tx.insert(campaignSettlements).values({ workspaceId: a.workspaceId, campaignId: a.campaignId, key: a.key, work: a.work, createdAt: a.now }).onConflictDoNothing();
}

/** Takes the Campaign's unsettled rows no run holds, holding them until `until`, oldest first. */
export async function claimSettlements(tx: CampaignsTx, campaignId: string, now: Date, until: Date) {
  const rows = await tx
    .update(campaignSettlements)
    .set({ claimedUntil: until })
    .where(and(eq(campaignSettlements.campaignId, campaignId), isNull(campaignSettlements.settledAt), or(isNull(campaignSettlements.claimedUntil), lt(campaignSettlements.claimedUntil, now))))
    .returning();
  return rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export async function finishSettlement(tx: CampaignsTx, campaignId: string, key: string, now: Date) {
  await tx.update(campaignSettlements).set({ settledAt: now, claimedUntil: null }).where(and(eq(campaignSettlements.campaignId, campaignId), eq(campaignSettlements.key, key)));
}

export async function failSettlement(tx: CampaignsTx, campaignId: string, key: string, error: string) {
  await tx
    .update(campaignSettlements)
    .set({ attempts: sql`${campaignSettlements.attempts} + 1`, lastError: error, claimedUntil: null })
    .where(and(eq(campaignSettlements.campaignId, campaignId), eq(campaignSettlements.key, key)));
}

/** Unsettled rows that failed at least `attempts` times, oldest first. */
export function stuckSettlements(tx: CampaignsTx, campaignId: string, attempts: number) {
  return tx
    .select()
    .from(campaignSettlements)
    .where(and(eq(campaignSettlements.campaignId, campaignId), isNull(campaignSettlements.settledAt), gte(campaignSettlements.attempts, attempts)))
    .orderBy(asc(campaignSettlements.createdAt));
}

/** A person asked to try again: the count starts over. */
export async function retrySettlements(tx: CampaignsTx, campaignId: string) {
  await tx.update(campaignSettlements).set({ attempts: 0 }).where(and(eq(campaignSettlements.campaignId, campaignId), isNull(campaignSettlements.settledAt)));
}

/** Campaigns with owed plan change work no run holds, across Workspaces, for the sweep. Ids only. */
export async function unsettledCampaigns(): Promise<{ workspaceId: string; campaignId: string }[]> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id, campaign_id from system.unsettled_campaigns()`));
  return rows.map((r) => ({ workspaceId: r.workspace_id as string, campaignId: r.campaign_id as string }));
}

/** Campaigns whose plan has an approved version that ended at most 30 days ago, across Workspaces, for the readings sweep. */
export async function campaignsToCount(): Promise<{ workspaceId: string; campaignId: string; planId: string }[]> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select workspace_id, campaign_id, plan_id from system.campaigns_to_count()`));
  return rows.map((r) => ({ workspaceId: r.workspace_id as string, campaignId: r.campaign_id as string, planId: r.plan_id as string }));
}

/** What a Campaign's activity is made of, newest first: its draft Actions' state changes grouped by step,
    change and hour; its notices (Items with no Action whose group names it); its unfinished agent runs. */
export async function activityRows(tx: CampaignsTx, campaignId: string, limit: number) {
  const hour = sql<Date>`date_trunc('hour', ${actionEvents.at})`;
  const changes = await tx
    .select({
      stepKey: campaignActions.stepKey,
      fromState: actionEvents.fromState,
      toState: actionEvents.toState,
      reason: actionEvents.reason,
      n: sql<number>`count(distinct ${actionEvents.actionId})::int`,
      at: sql<Date>`max(${actionEvents.at})`.mapWith((v: string | Date) => new Date(v)),
      byPerson: sql<boolean>`bool_or(${actionEvents.actorUserId} is not null)`,
    })
    .from(actionEvents)
    .innerJoin(campaignActions, eq(campaignActions.actionId, actionEvents.actionId))
    .where(and(eq(campaignActions.campaignId, campaignId), notInArray(actionEvents.toState, ["claimed", "dispatching", "draft"])))
    .groupBy(campaignActions.stepKey, actionEvents.fromState, actionEvents.toState, actionEvents.reason, hour)
    .orderBy(desc(sql`max(${actionEvents.at})`))
    .limit(limit);
  // Every notice's group names the Campaign by its id: "campaign:<id>", "<kind>:<id>" or "<kind>:<id>:<step>".
  const notices = await tx
    .select({ title: items.title, at: items.createdAt, kind: items.kind, payload: items.payload, state: items.state })
    .from(items)
    .where(and(isNull(items.actionId), or(sql`${items.groupKey} like ${`%:${campaignId}`}`, sql`${items.groupKey} like ${`%:${campaignId}:%`}`)))
    .orderBy(desc(items.createdAt))
    .limit(limit);
  // ponytail: reads the run's input JSON with no index; add a campaign column to agent_runs if runs grow large.
  const running = await tx
    .select({ stepKey: sql<string | null>`${agentRuns.input}->'target'->>'stepKey'`, at: agentRuns.createdAt })
    .from(agentRuns)
    .where(and(isNull(agentRuns.endedAt), sql`${agentRuns.input}->'target'->>'id' = ${campaignId}`))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
  return { changes, notices, running };
}

/** Claims the Campaign's one write-up as `writing`. False when it already has one. */
export async function claimWriteUp(tx: CampaignsTx, a: { workspaceId: string; campaignId: string; now: Date }): Promise<boolean> {
  const rows = await tx
    .insert(campaignWriteUps)
    .values({ workspaceId: a.workspaceId, campaignId: a.campaignId, status: "writing", createdAt: a.now })
    .onConflictDoNothing({ target: [campaignWriteUps.workspaceId, campaignWriteUps.campaignId] })
    .returning({ id: campaignWriteUps.id });
  return rows.length > 0;
}

export const readWriteUp = async (tx: CampaignsTx, campaignId: string) => (await tx.select().from(campaignWriteUps).where(eq(campaignWriteUps.campaignId, campaignId)))[0];

/** Sets a written or failed write-up back to writing, keeping its paragraph. False when it is already being written, or there is none. */
export async function rewriteWriteUp(tx: CampaignsTx, campaignId: string): Promise<boolean> {
  const rows = await tx
    .update(campaignWriteUps)
    .set({ status: "writing", failure: null })
    .where(and(eq(campaignWriteUps.campaignId, campaignId), ne(campaignWriteUps.status, "writing")))
    .returning({ id: campaignWriteUps.id });
  return rows.length > 0;
}

/** False when the Campaign has no write-up row. */
export async function setWriteUp(tx: CampaignsTx, campaignId: string, set: Partial<Omit<typeof campaignWriteUps.$inferInsert, "workspaceId" | "campaignId">>, fromRun?: string): Promise<boolean> {
  // A run's output lands only while the row still waits on that run (or on none yet), so a late
  // answer from an older run can't overwrite a newer write-up.
  const current = fromRun ? or(eq(campaignWriteUps.runId, fromRun), isNull(campaignWriteUps.runId)) : undefined;
  const rows = await tx.update(campaignWriteUps).set(set).where(and(eq(campaignWriteUps.campaignId, campaignId), current)).returning({ id: campaignWriteUps.id });
  return rows.length > 0;
}
