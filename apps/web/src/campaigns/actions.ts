// SPDX-License-Identifier: AGPL-3.0-only
// The campaign calls. Each change returns the API's error code, or null when it worked.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { messageForCode } from "../api/messages";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";
import { holdHook, mailboxes } from "../outreach/actions";

type S = components["schemas"];
export type Summary = S["CampaignSummary"];
/** A campaign as the list shows it: its summary, dates and counts. */
export type Listed = S["ListedCampaign"];
export type Loaded = S["Campaign"];
export type Step = S["CampaignStep"];
export type Person = S["CampaignPerson"];
export type RowResult = S["CampaignRowResult"];
export type StepSetup = {
  type: "email" | "manual" | "post" | "dm" | "clips" | "seo_brief";
  touchClass: "cold" | "consented_marketing" | null;
  /** The Mailboxes the step's emails are shared across, in the order picked. */
  mailboxCredentialIds: string[];
  audience: "everyone" | "no_reply_yet";
  dmChannel?: "linkedin" | "x" | null;
  dependsOnStepKey?: string | null;
  utm?: boolean;
};

const inW = (workspaceId: string) => ({ params: { path: { workspaceId } } });
const inC = (workspaceId: string, id: string) => ({ params: { path: { workspaceId, id } } });
const code = (r: { error?: { error?: string } }) => (r.error ? (r.error.error ?? "failed") : null);

export const listCampaigns = async (workspaceId: string) => (await api.GET("/api/w/{workspaceId}/campaigns", inW(workspaceId))).data?.campaigns ?? [];
export const getCampaign = async (workspaceId: string, id: string) => (await api.GET("/api/w/{workspaceId}/campaigns/{id}", inC(workspaceId, id))).data;
/** ADR 0023: the Campaign a plan belongs to, or undefined when it has none or can't be read. */
export const campaignOfPlan = async (workspaceId: string, planId: string) => (await api.GET("/api/w/{workspaceId}/plans/{id}/campaign", inC(workspaceId, planId))).data?.campaignId;
export const campaignQuery = (workspaceId: string, id: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "campaigns", id), queryFn: () => call(api.GET("/api/w/{workspaceId}/campaigns/{id}", inC(workspaceId, id))) });
export const peopleQuery = (workspaceId: string, id: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "campaigns", id, "people"), queryFn: () => call(api.GET("/api/w/{workspaceId}/campaigns/{id}/people", { params: { path: { workspaceId, id }, query: {} } })) });
/** What Direx did for one Campaign, newest first. */
export const activityQuery = (workspaceId: string, id: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "campaigns", id, "activity"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/campaigns/{id}/activity", inC(workspaceId, id)))).events });
const progressRead = (workspaceId: string, id: string) => ({ queryKey: inWorkspace(workspaceId, "campaigns", id, "progress"), queryFn: () => call(api.GET("/api/w/{workspaceId}/campaigns/{id}/progress", inC(workspaceId, id))) });
export const progressQuery = (workspaceId: string, id: string) => queryOptions({ ...progressRead(workspaceId, id), select: (r) => r.steps });
export type StepCounts = Partial<Record<S["CampaignProgress"]["counts"][number]["state"], number>>;
/** Each step's Items by state, dated or not, from the same read as the progress. */
export const stepCountsQuery = (workspaceId: string, id: string) =>
  queryOptions({
    ...progressRead(workspaceId, id),
    select: (r) => {
      const counts: Record<string, StepCounts> = {};
      for (const c of r.counts) (counts[c.stepKey] ??= {})[c.state] = c.n;
      return counts;
    },
  });
// ponytail: the Outreach reads say nothing when they fail, as before; a Mailbox list that can't load reads as none.
export const mailboxesQuery = (workspaceId: string) => queryOptions({ queryKey: inWorkspace(workspaceId, "mailboxes"), queryFn: async () => (await mailboxes(workspaceId)).map((c) => ({ id: c.id, name: c.name })) });
export const holdHookQuery = (workspaceId: string) => queryOptions({ queryKey: inWorkspace(workspaceId, "hold-hook"), queryFn: () => holdHook(workspaceId) });
export type Impact = S["CampaignPlanImpact"];
/** What approving the plan's saved draft would do to this Campaign. */
export const planImpact = async (workspaceId: string, id: string) => (await api.GET("/api/w/{workspaceId}/campaigns/{id}/plan-impact", inC(workspaceId, id))).data;
export const peoplePage = async (workspaceId: string, id: string, cursor?: string) =>
  (await api.GET("/api/w/{workspaceId}/campaigns/{id}/people", { params: { path: { workspaceId, id }, query: { cursor } } })).data;
export async function addPeople(workspaceId: string, id: string, csv: string): Promise<{ results: RowResult[] } | { error: string }> {
  const r = await api.POST("/api/w/{workspaceId}/campaigns/{id}/people", { ...inC(workspaceId, id), body: { csv } });
  return r.data ?? { error: code(r) ?? "failed" };
}
export const removePerson = async (workspaceId: string, id: string, personId: string) =>
  code(await api.DELETE("/api/w/{workspaceId}/campaigns/{id}/people/{personId}", { params: { path: { workspaceId, id, personId } } }));
export const saveStep = async (workspaceId: string, id: string, key: string, body: StepSetup) =>
  code(await api.PUT("/api/w/{workspaceId}/campaigns/{id}/steps/{key}", { params: { path: { workspaceId, id, key } }, body }));
/** A manual step's URL, such as the page other steps link to. Each change is a new version. */
export const recordOutput = async (workspaceId: string, id: string, key: string, url: string) =>
  code(await api.POST("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/output", { params: { path: { workspaceId, id, key } }, body: { url } }));

export type DraftsPreview = S["CampaignDraftsPreview"];
const inStep = (workspaceId: string, id: string, key: string) => ({ params: { path: { workspaceId, id, key } } });

// DM steps: drafted by Direx, sent by a person by hand, so they never wait for approval.
export type Dm = S["CampaignDm"];
export type DmResult = { personId: string; email: string | null; ok: boolean; reason?: string; leftOut?: { reason: string; fields?: string[] } };
export async function saveDmText(workspaceId: string, id: string, key: string, body: { revision: number; text: string }): Promise<{ revision: number; warnings: string[] } | { error: string }> {
  const r = await api.PUT("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/dm-text", { ...inStep(workspaceId, id, key), body });
  return r.data ?? { error: code(r) ?? "failed" };
}
export async function makeDms(workspaceId: string, id: string, key: string): Promise<{ results: DmResult[] } | { error: string }> {
  const r = await api.POST("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/dms", inStep(workspaceId, id, key));
  return r.data ?? { error: code(r) ?? "failed" };
}
export const listDms = async (workspaceId: string, id: string, key: string) => (await api.GET("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/dms", inStep(workspaceId, id, key))).data?.dms ?? [];
const onDm = (workspaceId: string, dmId: string) => ({ params: { path: { workspaceId, dmId } } });
/** Records the copy; true when Direx emailed them, or will, within 3 days. */
export async function copyDm(workspaceId: string, dmId: string): Promise<{ direxTouchNear: boolean } | { error: string }> {
  const r = await api.POST("/api/w/{workspaceId}/campaigns/dms/{dmId}/copied", onDm(workspaceId, dmId));
  return r.data ?? { error: code(r) ?? "failed" };
}
export const markDmSent = async (workspaceId: string, dmId: string) => code(await api.POST("/api/w/{workspaceId}/campaigns/dms/{dmId}/mark-sent", onDm(workspaceId, dmId)));
export const setDraftingMode = async (workspaceId: string, id: string, mode: "template" | "per_person") =>
  code(await api.PUT("/api/w/{workspaceId}/campaigns/{id}/drafting-mode", { ...inC(workspaceId, id), body: { mode } }));
export async function draftsPreview(workspaceId: string, id: string, key: string): Promise<DraftsPreview | { error: string }> {
  const r = await api.GET("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/drafts-preview", inStep(workspaceId, id, key));
  return r.data ?? { error: code(r) ?? "failed" };
}
export async function startStepDraft(workspaceId: string, id: string, key: string): Promise<{ runId: string } | { error: string }> {
  const r = await api.POST("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/draft-run", inStep(workspaceId, id, key));
  return r.data ?? { error: code(r) ?? "failed" };
}
export async function saveTemplate(workspaceId: string, id: string, key: string, body: { revision: number; subject: string; text: string }) {
  const r = await api.PUT("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/template", { ...inStep(workspaceId, id, key), body });
  return r.data ?? { error: code(r) ?? "failed" };
}
export async function makeDrafts(workspaceId: string, id: string, key: string, timeZone: string) {
  const r = await api.POST("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/make-drafts", { ...inStep(workspaceId, id, key), body: { timeZone } });
  return r.data ?? { error: code(r) ?? "failed" };
}

export type PersonPreview = S["CampaignPersonPreview"];
export type PersonDraft = S["CampaignPersonDraft"];
export async function personPreview(workspaceId: string, id: string, key: string): Promise<PersonPreview | { error: string }> {
  const r = await api.GET("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/person-preview", inStep(workspaceId, id, key));
  return r.data ?? { error: code(r) ?? "failed" };
}
export const personDrafts = async (workspaceId: string, id: string, key: string) => (await api.GET("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/person-drafts", inStep(workspaceId, id, key))).data?.drafts ?? [];
export async function writePerPerson(workspaceId: string, id: string, key: string, timeZone: string) {
  const r = await api.POST("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/write-per-person", { ...inStep(workspaceId, id, key), body: { timeZone } });
  return r.data ?? { error: code(r) ?? "failed" };
}
/** Edits a person keeps making on a step's drafts: `-` for words they cut, `+` for words they added. */
export async function repeatedEdits(workspaceId: string, id: string, key: string) {
  const r = await api.GET("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/repeated-edits", inStep(workspaceId, id, key));
  return r.data?.edits ?? [];
}
/** Reasons a person keeps giving on a step's drafts ("Too salesy"), with the words a writer note would hold. */
export async function repeatedReasons(workspaceId: string, id: string, key: string) {
  const r = await api.GET("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/repeated-reasons", inStep(workspaceId, id, key));
  return r.data?.reasons ?? [];
}
/** A person's notes on the Campaign, over the revision they read. */
export async function saveCampaignNotes(workspaceId: string, id: string, body: { notes: string; revision: number }) {
  const r = await api.PUT("/api/w/{workspaceId}/campaigns/{id}/notes", { params: { path: { workspaceId, id } }, body });
  return r.data ?? { error: code(r) ?? "failed" };
}
export async function saveWriterNotes(workspaceId: string, id: string, key: string, body: { notes: string; revision: number }) {
  const r = await api.PUT("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/writer-notes", { ...inStep(workspaceId, id, key), body });
  return r.data ?? { error: code(r) ?? "failed" };
}
/** Without `confirm`, only how many drafts a rewrite takes and what it could cost. */
export async function redraftStep(workspaceId: string, id: string, key: string, confirm: boolean) {
  const r = await api.POST("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/redraft", { ...inStep(workspaceId, id, key), body: { confirm, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
  return r.data ?? { error: code(r) ?? "failed" };
}
/** A writer note from a repeated edit, for the person to change before saving. */
export const noteFor = (phrase: string) => (phrase.startsWith("-") ? `Don't write "${phrase.slice(1)}".` : `Include "${phrase.slice(1)}".`);

export const editPersonDraft = async (workspaceId: string, id: string, key: string, personId: string, body: { subject: string; text: string }) =>
  code(await api.PUT("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/people/{personId}/draft", { params: { path: { workspaceId, id, key, personId } }, body }));

export const setCampaignPaused = async (workspaceId: string, id: string, paused: boolean) =>
  code(await (paused ? api.POST("/api/w/{workspaceId}/campaigns/{id}/pause", inC(workspaceId, id)) : api.POST("/api/w/{workspaceId}/campaigns/{id}/resume", inC(workspaceId, id))));
/** Deletes a Draft Campaign for good, with its plan. Null when it went, else the API's refusal. */
export const deleteDraft = async (workspaceId: string, id: string) => code(await api.DELETE("/api/w/{workspaceId}/campaigns/{id}/draft", inC(workspaceId, id)));
/** Whether drafts shaped by a recipient's website or list values may go out under an auto-approve rule no one reads. */
export const setOutsideContent = async (workspaceId: string, id: string, allowed: boolean) =>
  code(await api.POST("/api/w/{workspaceId}/campaigns/{id}/outside-content", { ...inC(workspaceId, id), body: { allowed } }));
/** Under run, Next steps start on their own as this person, with drafts timed in this browser's zone. */
export const setAdvance = async (workspaceId: string, id: string, run: boolean) =>
  code(await api.POST("/api/w/{workspaceId}/campaigns/{id}/advance", { ...inC(workspaceId, id), body: run ? { advance: "run", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : { advance: "offer" } }));
export const settleConflict = async (workspaceId: string, conflict: { itemId: string; revision: number }, choice: "skip" | "add_after") =>
  code(await api.POST("/api/w/{workspaceId}/items/{id}/approve", { params: { path: { workspaceId, id: conflict.itemId } }, body: { revision: conflict.revision, choice } }));

const LEFT_OUT: Record<string, string> = {
  replied: "they replied",
  removed: "removed from this campaign",
  conflict: "in another campaign",
  not_eligible: "can't be emailed",
  missing_merge_field: "missing",
};
// A relationship hold comes through as not_eligible with the hold's reason as its field.
const TALKING: Record<string, string> = { in_conversation: "you're already talking to them", may_be_talking: "you may already be talking to them" };
const talking = (x: { reason: string; fields?: string[] }) => (x.reason === "not_eligible" ? x.fields?.find((f) => TALKING[f]) : undefined);
export const sayLeftOut = (x: { reason: string; fields?: string[] }) => {
  const held = talking(x);
  if (held) return TALKING[held]!;
  return `${LEFT_OUT[x.reason] ?? x.reason}${x.fields?.length ? ` (${x.fields.join(", ")})` : ""}`;
};
/** "You're already talking to 7 of these 200; they won't be drafted.", or null when nobody is held. */
export function talkingLine(leftOut: { leftOut: { reason: string; fields?: string[] } }[], total: number): string | null {
  const n = leftOut.filter((x) => talking(x.leftOut)).length;
  return n ? `You're already talking to ${n} of these ${total}; they won't be drafted.` : null;
}

export const CAMPAIGN_MESSAGES: Record<string, string> = {
  drafting_mode_required: "Choose how this campaign is written first.",
  drafting_mode_locked: "This step already has writing in it, so how it's written can't change.",
  no_email_step: "This campaign has no email step to draft yet.",
  step_cancelled: "This step was cancelled.",
  step_has_email_work: "This step has email work that can still send, so its type cannot change.",
  step_has_dms: "This step already has DM drafts, so its type and DM channel cannot change.",
  step_has_results: "This step has already sent work, so its type and DM channel cannot change.",
  date_in_past: "Pick a launch date from today on.",
  same_anchor: "That's already the launch date.",
  not_output_step: "Only a manual step, or a post step that names the account whose post counts, can set the launch.",
  go_ahead_not_possible: "An email links to this step's page, so it can only wait or be cancelled.",
  wrong_mode: "This campaign writes one email per address, so it has no template.",
  not_an_email_step: "Save this step as an email first.",
  drafts_already_made: "Drafts already exist for this step. Edit the email here instead.",
  mailbox_required: "Choose an email account for this step first.",
  no_template: "Write the email first.",
  link_not_vouched: "That link isn't in your brand facts or plan. Take it out, or add it there first.",
  already_going: "This email has already gone, or is going now, so it can't change.",
  needs_decision: "A price here doesn't match your brand facts. Change it first.",
  unknown_merge_field: "Only {{firstName}}, {{company}}, {{senderName}} and the link of the step this one waits for can be filled in.",
  waiting_on_step: "This step waits for another step's link. Add that link first.",
  dependency_self: "A step can't wait for itself.",
  dependency_not_found: "That step isn't in this campaign.",
  dependency_depth: "A step can wait for one step, and a step others wait for can't wait for another.",
  no_output: "Only a manual step or a social post has a link to wait for.",
  has_dependants: "Other steps wait for this step's link, so it has to stay a manual step or a social post.",
  output_account_not_on_step: "That account has no post on this step.",
  bad_url: "Use a full web address starting with https://.",
  same_url: "That's already this step's link.",
  not_manual: "Only a manual step's link is added by hand.",
  target_changed: "Someone changed this while you were editing. Reload the page.",
  sender_identity_missing: "Save a sender name and postal address under Outreach first.",
  no_route: "No AI model is set up for this. Write the email yourself, or add a key under AI models.",
  no_email_column: "The first row needs a column called email.",
  bad_quote: "A quote mark in this list isn't closed. Check the list and paste it again.",
  too_many_rows: "That's more than 1,000 rows. Paste them in smaller lists.",
  step_not_in_plan: "That step is no longer in the plan.",
  plan_not_approved: "This campaign's plan isn't approved yet. People, steps and settings wait until it is.",
  plan_approved: "A version of this plan was approved, so it can't be deleted.",
  drafter_running: "Direx is still writing this plan. Delete it once that finishes.",
  draft_in_use: "Something else already uses this draft, so it can't be deleted.",
  mailbox_not_found: "That email account is gone.",
  not_a_mailbox: "That isn't a connected mail account.",
  revision_moved: "Someone saved these notes while you were editing. Reload the page.",
  no_writer_notes: "Save writer notes for this step first.",
};
export const say = (error: string) => messageForCode(error, CAMPAIGN_MESSAGES);

const ROW_WORDS: Record<string, string> = {
  no_email: "no email",
  bad_email: "not an email address",
  bad_website: "the website isn't a web address",
  bad_country: "the country needs a two-letter code",
  bad_basis: "the basis must be consent, implied, legitimate_interest or published_address",
  bad_entity_type: "the entity type must be corporate, sole_trader, partnership or unknown",
  bad_expiry: "the expiry must be a date written as YYYY-MM-DD",
  too_long: "a value is too long",
  wrong_column_count: "wrong number of columns",
};
export const sayRow = (r: RowResult) => {
  if (!r.ok) return `Row ${r.row}: not added, ${ROW_WORDS[r.reason ?? ""] ?? "something was wrong"}.`;
  return r.missing?.length ? `Row ${r.row}: added, but gets no draft until these are recorded: ${r.missing.join(", ")}.` : `Row ${r.row}: added.`;
};

// A clips step: recordings in, one after another, their clips out as posts. The view is typed here, since
// the API describes it loosely.
export type ClipAccount = { connection: string; credentialId: string | null; networkId: string | null };
export type ClipRunState = "queued" | "transcribing" | "picking" | "cutting" | "done" | "failed";
export type StepClip = { id: string; mediaId: string; startMs: number; endMs: number; title: string; caption: string; citations: string[]; measureKey: string | null; why: string };
export type ClipRecording = {
  setup: { sourceMediaId: string; accounts: ClipAccount[]; firstAt: string };
  run: { id: string; state: ClipRunState; failure: string | null; dropped: { moment: { startMs: number; endMs: number; title: string }; reason: string }[] } | null;
  clips: StepClip[];
  unposted: string[];
  idle: ClipAccount[];
};
export type ClipStepView = { recordings: ClipRecording[]; lastAccounts: ClipAccount[] };
export const clipStep = async (workspaceId: string, id: string, key: string) => (await api.GET("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/clips", inStep(workspaceId, id, key))).data as ClipStepView | undefined;
export async function makeClips(workspaceId: string, id: string, key: string, body: { sourceMediaId: string; accounts: ClipAccount[]; firstAt: string }): Promise<string | null> {
  return code(await api.PUT("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/clips", { ...inStep(workspaceId, id, key), body }));
}
export async function editClipCaption(workspaceId: string, id: string, key: string, clipId: string, text: string): Promise<string | null> {
  return code(await api.PUT("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/clips/{clipId}/caption", { params: { path: { workspaceId, id, key, clipId } }, body: { text } }));
}
const CLIP_ERRORS: Record<string, string> = {
  in_progress: "Another recording on this step is still being clipped. Try again when it is done.",
  not_found: "That recording isn't here any more. Recordings are kept for a week; upload it again.",
  not_available: "Clipping needs a self-hosted Direx server for now.",
  not_a_clips_step: "Save this step as video clips first.",
};
export const sayClips = (error: string) => CLIP_ERRORS[error] ?? "That didn't go through. Try again.";

// An SEO brief step: one page and one search, a Brief written by Direx and approved by a person, then
// the draft the person made from it as the step's output.
export type BriefStepView = S["BriefStep"];
export type BriefState = S["StepBriefState"];
export const briefStep = async (workspaceId: string, id: string, key: string) => (await api.GET("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/brief", inStep(workspaceId, id, key))).data;
export const makeBrief = async (workspaceId: string, id: string, key: string, body: { page: string | null; query: string }) =>
  code(await api.PUT("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/brief", { ...inStep(workspaceId, id, key), body }));
const BRIEF_WORDS: Record<string, string> = {
  bad_url: "Give the page as a full https:// address.",
  bad_query: "Give the search in 2 to 200 characters.",
  page_and_dependency: "This step briefs the page from the step it waits for, so leave the page empty.",
  waiting_on_step: "The step this one waits for has no link yet.",
  brief_running: "Direx is still writing the Brief.",
  brief_waiting: "The Brief for this page and search is waiting on Home. Approve or dismiss it first.",
  brief_approved: "This step's Brief is approved already.",
  cloud_unavailable: "Briefs need a self-hosted Direx server for now.",
  not_a_brief_step: "Save this step as an SEO brief first.",
  robots_disallowed: "The site's robots.txt doesn't let Direx read that page.",
  not_html: "That address isn't a web page.",
  too_big: "That page is too large to read.",
  no_gaps: "Direx found nothing to change on this page for this search.",
  no_route: "No model is set up for Briefs. Sign in to Claude Code or Codex on the AI models page.",
  model_refusal: "The model's answer didn't come back as a Brief. Make brief again.",
};
/** What a refusal or a run that made no Brief means, in words. A quote check refusal starts with its code. */
export const sayBrief = (reason: string) => BRIEF_WORDS[reason] ?? (reason.startsWith("brief_refused") ? "The Brief quoted words that aren't on the page, so Direx didn't show it. Try again." : messageForCode(reason));

// Drafting on import, each step's mode, and how far drafting has got.
export type DraftingPreview = S["CampaignDraftingPreview"];
export type Progress = S["CampaignProgress"]["steps"][number];
export const setStepDraftingMode = async (workspaceId: string, id: string, key: string, mode: "template" | "per_person") =>
  code(await api.PUT("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/drafting-mode", { ...inStep(workspaceId, id, key), body: { mode } }));
export async function draftingPreview(workspaceId: string, id: string): Promise<DraftingPreview | { error: string }> {
  const r = await api.GET("/api/w/{workspaceId}/campaigns/{id}/drafting-preview", inC(workspaceId, id));
  return r.data ?? { error: code(r) ?? "failed" };
}
export async function confirmDrafting(workspaceId: string, id: string, timeZone: string) {
  const r = await api.POST("/api/w/{workspaceId}/campaigns/{id}/drafting-confirm", { ...inC(workspaceId, id), body: { timeZone } });
  return r.data ?? { error: code(r) ?? "failed" };
}
export const progress = async (workspaceId: string, id: string) => (await api.GET("/api/w/{workspaceId}/campaigns/{id}/progress", inC(workspaceId, id))).data?.steps ?? [];

// The launch every step keeps its distance from.
export type AnchorMove = S["CampaignAnchorMove"];
/** What moving the launch does, in a sentence, from its preview. */
export const moveEffect = (m: AnchorMove) =>
  (m.moved === 0 ? "Nothing is drafted yet, so only the steps' dates change." : `${m.moved} not yet sent ${m.moved === 1 ? "moves" : "move"} with it.`) +
  (m.kept > 0 ? ` ${m.kept} approved ${m.kept === 1 ? "goes" : "go"} later as approved.` : "") +
  (m.backToApproval > 0 ? ` ${m.backToApproval} approved ${m.backToApproval === 1 ? "needs" : "need"} approving again, because ${m.backToApproval === 1 ? "it goes" : "they go"} earlier.` : "");
export async function moveLaunch(workspaceId: string, id: string, on: string, preview: boolean): Promise<AnchorMove | { error: string }> {
  const r = await api.PUT("/api/w/{workspaceId}/campaigns/{id}/anchor", { ...inC(workspaceId, id), body: { on, preview } });
  return r.data ?? { error: code(r) ?? "failed" };
}
export const followStep = async (workspaceId: string, id: string, stepKey: string | null) =>
  code(await api.PUT("/api/w/{workspaceId}/campaigns/{id}/anchor", { ...inC(workspaceId, id), body: { stepKey } }));
export const resolveStall = async (workspaceId: string, id: string, key: string, choice: "wait" | "go_ahead" | "cancel") =>
  code(await api.POST("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/stall", { ...inStep(workspaceId, id, key), body: { choice } }));
export const launches = async (workspaceId: string, from: string, to: string) =>
  (await api.GET("/api/w/{workspaceId}/campaign-launches", { params: { path: { workspaceId }, query: { from, to } } })).data?.launches ?? [];
/** A date as the page shows it, such as "Tue 10 Nov". */
export const dayWords = (day: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day}T00:00:00Z`));
/** A moment as the page shows it, in the viewer's time zone, such as "Wed 11 Nov, 23:17". */
export const momentWords = (iso: string) => new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
/** One email step's progress in a line: "42 of 200 written · ready Thu 12 Nov · 3 waiting on the landing page". */
export function progressLine(p: Progress | undefined): string {
  // Nothing to write and nothing waiting, such as a step with no People yet, says nothing.
  if (!p || (p.written + p.toWrite === 0 && p.waiting.length === 0)) return "";
  const parts = [`${p.written} of ${p.written + p.toWrite} written`];
  if (p.readyOn) parts.push(`ready ${dayWords(p.readyOn)}`);
  for (const w of p.waiting) parts.push(`${w.count} waiting on ${w.label}`);
  return parts.join(" · ");
}

export type Results = S["CampaignResults"];
/** What is known of how one Campaign went: sends by channel, what came back on email, measures against targets. */
export const resultsQuery = (workspaceId: string, id: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "campaigns", id, "results"), queryFn: () => call(api.GET("/api/w/{workspaceId}/campaigns/{id}/results", inC(workspaceId, id))) });

const NETWORKS: Record<string, string> = { linkedin: "LinkedIn", x: "X", bluesky: "Bluesky", threads: "Threads", mastodon: "Mastodon", facebook: "Facebook", instagram: "Instagram" };
/** A network's name as people write it, such as "LinkedIn". An unknown one reads as it is stored. */
export const networkWords = (channel: string) => NETWORKS[channel] ?? channel;
/** A step type in a word or two, for a Campaign's channel list. */
export const CHANNEL_WORDS: Record<string, string> = { email: "Email", post: "Social posts", dm: "DMs", clips: "Video clips", seo_brief: "SEO brief", manual: "Manual" };

/** Campaigns with an approved plan. */
export const campaignsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "campaigns"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/campaigns", { params: { path: { workspaceId } } }))).campaigns });
