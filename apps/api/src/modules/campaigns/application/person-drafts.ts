// SPDX-License-Identifier: AGPL-3.0-only
// One email per address, in two runs per Person. A reader with no tools gets the Person's home and about
// pages and quotes them; Direx keeps only quotes the page really holds. A writer then gets those quotes,
// a cleaned name and company and the Facts, and never a page, the Strategy or the plan. Everything about
// the recipient is untrusted, so every draft carries a warning and is approved on its own.
import { storedSpec, touchField } from "@direx/plugin-sdk/host";
import { draftingPreview, type Caps } from "../domain/timing";
import { datedSteps, decideBy } from "../domain/anchor";
import type { DraftInput, Producer, Sink } from "../../agents";
import { warn, type Items, type RecipientNotes, type Warning, type WarningCode } from "../../items";
import type { Outreach } from "../../outreach";
import { sharedMailDomain } from "../../people";
import type { Plans } from "../../plans";
import type { PersonOutput, ReaderOutput } from "../definitions/drafter";
import { activeActions, allPeople, inWorkspace, linkOfItem, proposalOfItem, readCampaign, setWriterNotes as setWriterNotesRow, stepMailboxes, stepsOf, stillWaiting } from "../adapters/repo";
import { leftOut, type AudienceStep, type LeftOut, type PersonStatus } from "../domain/audience";
import { foreignLinks } from "../domain/links";
import { replyPrefix } from "../domain/subject";
import { REJECT_REASONS, type RejectReason } from "../domain/rewrite";
import { cleanListValues } from "../domain/list-values";
import { fieldsIn } from "../domain/merge";
import { carriesAddress, keptDetails } from "../domain/quotes";
import { editDistance, editPhrases, skeletonOf, spansAgainst } from "../domain/skeleton";
import { websiteFor } from "../domain/website";
import { checkRecord, checkWarnings, modelChecks, type Generate } from "./draft-checks";
import { briefFor, reviewTemplate, type FactReads, type StartDraft, type StepDraftInput } from "./drafting";
import { placeDraft, plannedSenders, reviseDraft } from "./place-draft";
import { factEntries, stepOutputEntries } from "./snapshot";
import { stepUrls } from "./step-links";

// The run cost cap and the daily cap a new agent starts with, so the screen can state the worst case.
export const RUN_CAP_CENTS = 100;
const RUNS_PER_DAY = 100;

export const UNTRUSTED_WARNING = "Written from this person's details and website, which Direx can't vouch for. Read it before approving.";
const NOT_BASED = { no_website: "there's no website to read for this address", nothing_checked: "nothing on their website could be checked word for word" };
const READ_REQUEST = "Report what these pages say about the company.";
/** Warnings that describe the words themselves, so an edit makes them stale. */
const ABOUT_THE_WORDS: ReadonlySet<WarningCode> = new Set([
  "uncited_number", "banned_claim", "price_conflict", "foreign_link", "reply_prefix",
  "unsupported_claim", "unsupported_promise", "possible_injection", "check_unavailable",
]);
const needsDecision = (w: Warning): Warning => ({ ...w, text: `Needs a decision: ${w.text}` });
// The run's record drops the quotes when it ends, so a later edit reads them back from these labels.
const detailWarning = (x: WriterDetail): Warning => warn("recipient_detail", `Says about them: "${x.quote}" (from ${x.url})`);
const quoteOf = (w: Warning): string[] => (w.code === "recipient_detail" ? (/^Says about them: "([\s\S]*)" \(from .*\)$/.exec(w.text)?.slice(1) ?? []) : []);
/** A checked quote back from its label, with its page, for a rewrite of the email it was written into. */
const detailOf = (w: Warning): WriterDetail[] => {
  const m = w.code === "recipient_detail" ? /^Says about them: "([\s\S]*)" \(from (.*)\)$/.exec(w.text) : null;
  return m ? [{ kind: "detail", quote: m[1]!, url: m[2]! }] : [];
};
/** Only these brief parts reach the writer: no Strategy and no plan. */
const WRITER_BRIEF: ReadonlySet<string> = new Set(["date", "citable_facts"]);

/** `redraft` is the email a rewrite revises; without it the writer makes a new one. */
type PersonTarget = StepDraftInput["target"] & { personId: string; on: string; timeZone: string; userId: string; redraft?: string };
// A signal goes to the writer as one more checked detail, with the page it came from.
type WriterDetail = { kind: string; quote: string; url: string };
type Next = { request: string; brief: DraftInput["brief"]; factVersions: { id: string; version: number }[]; signals: WriterDetail[] };
/** Signals from the companies a Person was handed over from, as given by the composition root. */
export type SignalsFor = (workspaceId: string, personId: string) => Promise<RecipientNotes["signals"]>;
export type AddressLabelsFor = (workspaceId: string, personId: string) => Promise<Pick<RecipientNotes, "roleAddress" | "guessedAddress">>;
// Values, quotes and the writer's brief sit under `person`, which a run's record drops when it ends.
export type ReaderInput = StepDraftInput & { url: string; person: { id: string; text: string; next: Next }; target: PersonTarget };
/** `site` is the address Direx tried to read, if there was one; it isn't `url`, so the writer is never told to read it. */
export type WriterInput = StepDraftInput & { person: { id: string; text: string; details: WriterDetail[] }; target: PersonTarget; site?: string; reader: Producer | null; factVersions: Next["factVersions"] };

function writerInput(base: { person: { id: string; text: string; next: Next }; target: PersonTarget }, site: string | undefined, quoted: WriterDetail[], reader: Producer | null): WriterInput {
  const { next } = base.person;
  const details = [...quoted, ...next.signals];
  const lines = details.map((x, i) => `${i + 1}. (${x.kind}) "${x.quote}"`);
  const text = `${base.person.text}\n${details.length ? `Details checked against their website:\n${lines.join("\n")}` : "No details from their website."}`;
  return { request: next.request, brief: next.brief, person: { id: base.person.id, text, details }, target: base.target, ...(site ? { site } : {}), reader, factVersions: next.factVersions };
}

/** Who gets a run. Anyone who already has a draft is counted, not written again. */
async function decide(workspaceId: string, campaignId: string, stepKey: string, d: { plans: Plans; outreach: () => Outreach; now: () => Date }) {
  const read = await inWorkspace(workspaceId, async (tx) => {
    const campaign = await readCampaign(tx, campaignId);
    if (!campaign) return null;
    return { campaign, step: (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey), mailboxes: await stepMailboxes(tx, campaignId, stepKey), people: await allPeople(tx, campaignId), existing: await activeActions(tx, campaignId, stepKey), waiting: await stillWaiting(tx, campaignId) };
  });
  if (!read) return { ok: false, reason: "not_found" } as const;
  const step = read.step;
  if (step?.type === "email" && step.draftingMode !== "per_person") return { ok: false, reason: "wrong_mode" } as const;
  if (step?.type !== "email") return { ok: false, reason: "not_an_email_step" } as const;
  if (step.cancelledAt) return { ok: false, reason: "step_cancelled" } as const;
  if (!read.mailboxes.length) return { ok: false, reason: "mailbox_required" } as const;
  // A step waiting on another's output starts no run until that output exists.
  const links = await inWorkspace(workspaceId, (tx) => stepUrls(tx, { workspaceId, campaignId, step, at: d.now() }));
  if (!links.ok) return links;
  const plan = await d.plans.plan(workspaceId, read.campaign.planId);
  const planned = plan?.current ? datedSteps(plan.current, read.campaign.anchorOn).find((s) => s.key === stepKey) : undefined;
  if (!plan?.current || !planned) return { ok: false, reason: "step_not_in_plan" } as const;
  const senderName = await d.outreach().senderName(workspaceId);
  if (!senderName) return { ok: false, reason: "sender_identity_missing" } as const;

  const blocked = await d.outreach().whyNot(workspaceId, read.people.map((p) => p.personId), step.touchClass!);
  const made = new Set(read.existing.map((x) => x.personId));
  const out: { email: string | null; leftOut: LeftOut }[] = [];
  const going: (typeof read.people)[number][] = [];
  for (const person of read.people) {
    if (made.has(person.personId)) continue;
    const why = blocked.get(person.personId);
    const left = leftOut(
      { status: (read.waiting.has(person.personId) ? "conflict" : person.status) as PersonStatus, replied: person.status === "replied", mergeFieldsMissing: [], eligibilityMissing: why ? [why] : [] },
      { audience: step.audience as AudienceStep["audience"] },
    );
    if (left) out.push({ email: person.email, leftOut: left });
    else going.push(person);
  }
  return { ok: true, planId: read.campaign.planId, plan, current: plan.current, planned, out, going, already: made.size, skeleton: skeletonOf(step.template, senderName), notes: step.writerNotes } as const;
}

const EDITABLE: ReadonlySet<string> = new Set(["draft", "needs_approval", "scheduled"]);
/** Drafts a redraft may rewrite: none a person has approved. */
const UNAPPROVED: ReadonlySet<string> = new Set(["draft", "needs_approval"]);
const REPEATED_EDIT = 3;
const FOOTER = "\n\n--\n";
export const withoutFooter = (text: string) => (text.includes(FOOTER) ? text.slice(0, text.lastIndexOf(FOOTER)) : text);

/** What an agent and its Workspace may still start today and per day, read from the agents module through the composition root. */
export type RunCaps = (workspaceId: string, agent: string) => Promise<Caps>;

/** A campaign post's rewrite, or null when the Item is no post, from the step drafting that writes posts. */
export type RedraftPost = (workspaceId: string, itemId: string, a: { instruction: string; userId: string; tainted?: boolean | undefined }) => Promise<{ ok: true; runId: string } | { ok: false; reason: string } | null>;

export function personDrafting(d: { plans: Plans; facts: FactReads; items: () => Items; outreach: () => Outreach; startDraft: () => StartDraft; now: () => Date; signalsFor: SignalsFor; addressLabelsFor: AddressLabelsFor; runCaps?: RunCaps | undefined; redraftPost?: RedraftPost | undefined }) {
  /** What a per-Person step's drafts are compared with: its email, the sender and its links. Null for a template step. */
  async function stepToCompare(workspaceId: string, campaignId: string, stepKey: string) {
    const read = await inWorkspace(workspaceId, async (tx) => {
      const step = (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey);
      const urls = step ? await stepUrls(tx, { workspaceId, campaignId, step, at: d.now() }) : null;
      return step?.draftingMode === "per_person" ? { template: step.template, urls: urls?.ok ? urls.urls : {} } : null;
    });
    return read && { ...read, senderName: await d.outreach().senderName(workspaceId) };
  }
  const spansFor = (step: Awaited<ReturnType<typeof stepToCompare>>, person: { firstName?: string | null; company?: string | null } | undefined, text: string) =>
    step && person ? spansAgainst(step.template, { ...cleanListValues(person), senderName: step.senderName }, step.urls, withoutFooter(text)) : null;

  const api = {
    /** For the approval of an email: its recipient's signals, how their address was found, and which words differ from its step's email. Nothing here reaches a template run. */
    async recipientNotes(workspaceId: string, spec: unknown, itemId?: string): Promise<RecipientNotes | null> {
      const personId = touchField(spec, "personId");
      if (personId === undefined) return null;
      const { text } = storedSpec("email.send", spec);
      const link = itemId ? await inWorkspace(workspaceId, (tx) => linkOfItem(tx, itemId)) : null;
      const step = link ? await stepToCompare(workspaceId, link.campaignId, link.stepKey) : null;
      const person = link && step ? (await inWorkspace(workspaceId, (tx) => allPeople(tx, link.campaignId))).find((p) => p.personId === personId) : undefined;
      const spans = text !== undefined ? spansFor(step, person, text) : null;
      return { signals: await d.signalsFor(workspaceId, personId), ...(await d.addressLabelsFor(workspaceId, personId)), ...(spans && { spans }) };
    },

    /**
     * How far the words a person decided on moved from what the writer proposed, for their review record.
     * Phrases are `-removed` or `+added`. Null for anything but a per-Person draft. A draft written before the
     * proposed words were kept still names its step, so a reason given on it counts, with no distance.
     */
    async editOf(workspaceId: string, itemId: string, decidedText: string) {
      const row = await inWorkspace(workspaceId, (tx) => proposalOfItem(tx, itemId));
      if (!row) return null;
      if (row.proposedText === null) return { campaignId: row.campaignId, stepKey: row.stepKey, editDistance: null, editPhrases: [] };
      const final = withoutFooter(decidedText);
      const phrases = editPhrases(row.proposedText, final);
      return { campaignId: row.campaignId, stepKey: row.stepKey, editDistance: editDistance(row.proposedText, final), editPhrases: [...phrases.removed.map((p) => `-${p}`), ...phrases.added.map((p) => `+${p}`)] };
    },

    async personPreview(workspaceId: string, campaignId: string, stepKey: string) {
      const r = await decide(workspaceId, campaignId, stepKey, d);
      if (!r.ok) return r;
      const generic = r.going.filter((p) => !websiteFor(p.email ?? "", p.website, sharedMailDomain)).length;
      // A Person with a site costs a reader run and a writer run.
      const runs = 2 * r.going.length - generic;
      // The live caps say how many days it takes; without them, the fixed daily figure does.
      let days: number | null = Math.ceil(runs / RUNS_PER_DAY);
      if (d.runCaps) {
        const [reader, writer] = await Promise.all([d.runCaps(workspaceId, "recipient_reader"), d.runCaps(workspaceId, "recipient_writer")]);
        const caps = { agentLeftToday: Math.min(reader.agentLeftToday, writer.agentLeftToday), agentPerDay: Math.min(reader.agentPerDay, writer.agentPerDay), workspaceLeftToday: writer.workspaceLeftToday, workspacePerDay: writer.workspacePerDay };
        days = draftingPreview({ ready: r.going.length, mode: "per_person", costCapCents: RUN_CAP_CENTS, caps, today: d.now().toISOString().slice(0, 10) }).days;
      }
      return {
        ok: true,
        willWrite: r.going.length,
        generic,
        already: r.already,
        leftOut: r.out,
        runs,
        worstCaseCents: runs * RUN_CAP_CENTS,
        days,
      } as const;
    },

    /** Each Person's draft: the words a person wrote or read, without the footer Direx adds. */
    async personDrafts(workspaceId: string, campaignId: string, stepKey: string) {
      const read = await inWorkspace(workspaceId, async (tx) => ({ links: await activeActions(tx, campaignId, stepKey), people: await allPeople(tx, campaignId) }));
      const step = await stepToCompare(workspaceId, campaignId, stepKey);
      const drafts = [];
      for (const link of read.links) {
        const view = await d.items().view(workspaceId, link.itemId);
        if (!view) continue;
        const spec = storedSpec("email.send", link.spec);
        drafts.push({
          personId: link.personId,
          itemId: link.itemId,
          email: read.people.find((p) => p.personId === link.personId)?.email ?? null,
          state: view.state,
          editable: EDITABLE.has(view.state),
          warnings: view.warnings,
          subject: spec.subject ?? "",
          text: withoutFooter(spec.text ?? ""),
          spans: spansFor(step, read.people.find((p) => p.personId === link.personId), spec.text ?? ""),
        });
      }
      return drafts;
    },

    /** A person's edit, checked like a run's. Fixing what needed a decision sends the draft for approval. */
    async editPersonDraft(workspaceId: string, campaignId: string, stepKey: string, personId: string, a: { subject: string; text: string; userId: string }) {
      const read = await inWorkspace(workspaceId, async (tx) => {
        const campaign = await readCampaign(tx, campaignId);
        if (!campaign) return null;
        const step = (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey);
        const [link] = await activeActions(tx, campaignId, stepKey, personId);
        // The page this step waits on is Direx's own line, not a link from nowhere.
        const urls = step ? await stepUrls(tx, { workspaceId, campaignId, step, at: d.now() }) : null;
        const own = urls?.ok ? Object.values(urls.urls) : [];
        // An edit keeps the Mailbox the draft was written with.
        return step && link?.credentialId ? { campaign, step, mailbox: link.credentialId, link, own, used: urls?.ok ? urls.used : null } : null;
      });
      if (!read) return { ok: false, reason: "not_found" } as const;
      if (fieldsIn(`${a.subject}\n${a.text}`).length) return { ok: false, reason: "unknown_merge_field" } as const;
      const view = await d.items().view(workspaceId, read.link.itemId);
      if (!view || !EDITABLE.has(view.state)) return { ok: false, reason: "already_going" } as const;

      // Where the text came from still holds, so those warnings stay; anything about the old words goes.
      const kept = view.warnings.filter((w) => !ABOUT_THE_WORDS.has(w.code));
      // A quote Direx checked against their page still sources its numbers, as it did for the writer.
      const reviewed = await reviewTemplate(workspaceId, d.facts, { schemaVersion: 1, subject: a.subject, text: a.text, citations: [] }, kept.flatMap(quoteOf));
      // Only a Fact vouches for a link, as for the writer's own draft.
      const vouched = (await d.facts.usableFacts(workspaceId)).map((f) => f.value).join("\n");
      const links = foreignLinks(`${a.subject}\n${a.text}`, vouched, read.own);
      if (links.length) return { ok: false, reason: "link_not_vouched" } as const;
      if (reviewed.needsDecision.length || replyPrefix(a.subject)) return { ok: false, reason: "needs_decision" } as const;

      // The person's own words cite no Fact; what they still rest on is the step's page, if they kept its line.
      const keepsPage = read.own.some((u) => `${a.subject}\n${a.text}`.includes(u));
      const revised = await reviseDraft(
        d,
        { workspaceId, campaignId, stepKey, personId, userId: a.userId, itemId: read.link.itemId },
        {
          credentialId: read.mailbox,
          touchClass: read.step.touchClass as "cold" | "consented_marketing",
          subject: a.subject,
          text: a.text,
          plannedAt: read.link.plannedAt ?? undefined,
          warnings: [...kept, ...reviewed.warnings],
          snapshot: stepOutputEntries(campaignId, keepsPage ? read.used : null),
          submit: true,
        },
      );
      if (!revised.ok) return { ok: false, reason: revised.reason } as const;
      return { ok: true } as const;
    },

    /**
     * Rewrites one Person's email as a person asked: the same writer, given the current email as data and
     * the quotes it was written from. The new words revise the same Action, so any approval is voided and
     * the email waits for one again. Only a per-Person email has a writer; a template's is edited there.
     */
    async redraftPerson(workspaceId: string, itemId: string, a: { instruction: string; userId: string; timeZone: string; tainted?: boolean | undefined }) {
      const view = await d.items().view(workspaceId, itemId);
      const read = await inWorkspace(workspaceId, async (tx) => {
        const link = await linkOfItem(tx, itemId);
        if (!link) return null;
        const campaign = await readCampaign(tx, link.campaignId);
        const step = (await stepsOf(tx, link.campaignId)).find((s) => s.stepKey === link.stepKey);
        const person = (await allPeople(tx, link.campaignId)).find((p) => p.personId === link.personId);
        const [current] = await activeActions(tx, link.campaignId, link.stepKey, link.personId);
        return campaign && step && person && current ? { link, campaign, step, person, current } : null;
      });
      if (!view || !read) return { ok: false, reason: "not_a_campaign_email" } as const;
      if (!EDITABLE.has(view.state)) return { ok: false, reason: "already_going" } as const;
      if (read.step.draftingMode !== "per_person") return { ok: false, reason: "from_template" } as const;
      const plan = await d.plans.plan(workspaceId, read.campaign.planId);
      const planned = plan?.current ? datedSteps(plan.current, read.campaign.anchorOn).find((s) => s.key === read.link.stepKey) : undefined;
      if (!plan?.current || !planned) return { ok: false, reason: "step_not_in_plan" } as const;
      const brief = (await briefFor(workspaceId, d, read.campaign.planId, plan.current, plan.currentVersion, plan.strategyVersion)).filter((b) => WRITER_BRIEF.has(b.kind));
      const factVersions = (await d.facts.usableFacts(workspaceId)).map((f) => ({ id: f.id, version: f.version }));
      const values = cleanListValues(read.person);
      const spec = storedSpec("email.send", read.current.spec);
      const base = {
        person: {
          id: read.person.personId,
          // The current words may be a model's, so they ride with the recipient's details as data, never in the request.
          text: `First name: ${values.firstName ?? "unknown"}\nCompany: ${values.company ?? "unknown"}\nThe current email, to rewrite:\nSubject: ${spec.subject ?? ""}\n${withoutFooter(spec.text ?? "")}`,
          next: { request: `Rewrite the email for the step "${planned.title}", planned for ${planned.on}, to the recipient below, as the person asked: ${a.instruction}`, brief, factVersions, signals: view.warnings.flatMap(detailOf) },
        },
        target: { id: read.link.campaignId, draftRevision: view.revision, stepKey: read.link.stepKey, personId: read.person.personId, on: planned.on, timeZone: a.timeZone, userId: a.userId, redraft: itemId },
      };
      const run = await d.startDraft()(workspaceId, { agent: "recipient_writer", input: writerInput(base, undefined, [], null), startedBy: a.userId, ...(a.tainted && { tainted: true }) });
      return run.ok ? ({ ok: true, runId: run.run.id } as const) : ({ ok: false, reason: run.reason } as const);
    },

    /** A rewrite of an email or a post; with a reason, it is recorded against the Item's step once it starts. */
    async rewrite(workspaceId: string, itemId: string, a: { instruction: string; userId: string; timeZone: string; tainted?: boolean | undefined; reason?: RejectReason | undefined; note?: string | undefined; openedAt?: Date | undefined }) {
      const r = (await d.redraftPost?.(workspaceId, itemId, a)) ?? (await api.redraftPerson(workspaceId, itemId, a));
      if (r.ok && a.reason) await d.items().recordRewrite(workspaceId, itemId, a.userId, { reason: a.reason, note: a.note }, a.openedAt);
      return r;
    },

    /**
     * Reasons given on this step's drafts three times or more [DEFAULT], with their counts and the words a writer
     * note would hold. Wrong facts is left out: a wrong fact is fixed on Brand, never in the writer's notes.
     */
    async repeatedReasons(workspaceId: string, campaignId: string, stepKey: string) {
      const counts = new Map<RejectReason, number>();
      for (const r of await d.items().stepReasons(workspaceId, campaignId, stepKey)) if (r in REJECT_REASONS && r !== "facts") counts.set(r as RejectReason, (counts.get(r as RejectReason) ?? 0) + 1);
      return [...counts].filter(([, n]) => n >= REPEATED_EDIT).map(([reason, count]) => ({ reason, count, words: REJECT_REASONS[reason] }));
    },

    /** Edits a person made on this step's drafts three times or more [DEFAULT], each as `-removed` or `+added`, with their counts. */
    async repeatedEdits(workspaceId: string, campaignId: string, stepKey: string) {
      const counts = new Map<string, number>();
      for (const phrases of await d.items().stepEditPhrases(workspaceId, campaignId, stepKey)) for (const p of new Set(phrases)) counts.set(p, (counts.get(p) ?? 0) + 1);
      return [...counts].filter(([, n]) => n >= REPEATED_EDIT).map(([phrase, count]) => ({ phrase, count }));
    },

    /** A person's notes for this step's writer. Empty clears them. Refused if someone saved since `revision`. */
    async setWriterNotes(workspaceId: string, campaignId: string, stepKey: string, a: { notes: string; revision: number }) {
      const notes = a.notes.trim() || null;
      const saved = await inWorkspace(workspaceId, async (tx) => {
        const step = (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey);
        if (step?.type !== "email" || step.draftingMode !== "per_person") return "not_found" as const;
        return (await setWriterNotesRow(tx, { campaignId, stepKey, notes, revision: a.revision, now: d.now() })) ? null : ("revision_moved" as const);
      });
      return saved ? ({ ok: false, reason: saved } as const) : ({ ok: true, revision: a.revision + 1 } as const);
    },

    /**
     * Rewrites this step's drafts nobody has approved yet, following its writer notes. Without `confirm` it
     * only says how many runs that is and what it could cost. Each rewrite waits for approval again.
     */
    async redraftStep(workspaceId: string, campaignId: string, stepKey: string, a: { confirm: boolean; userId: string; timeZone: string }) {
      const read = await inWorkspace(workspaceId, async (tx) => ({ step: (await stepsOf(tx, campaignId)).find((s) => s.stepKey === stepKey), links: await activeActions(tx, campaignId, stepKey) }));
      if (read.step?.draftingMode !== "per_person") return { ok: false, reason: "not_found" } as const;
      if (!read.step.writerNotes) return { ok: false, reason: "no_writer_notes" } as const;
      const open: string[] = [];
      for (const link of read.links) if (UNAPPROVED.has((await d.items().view(workspaceId, link.itemId))?.state ?? "")) open.push(link.itemId);
      if (!a.confirm) return { ok: true, runs: open.length, worstCaseCents: open.length * RUN_CAP_CENTS, started: 0, runIds: [] as string[] } as const;
      const runIds: string[] = [];
      for (const itemId of open) {
        const r = await api.redraftPerson(workspaceId, itemId, { instruction: `Follow these notes for the step: ${read.step.writerNotes}`, userId: a.userId, timeZone: a.timeZone });
        if (r.ok) runIds.push(r.runId);
      }
      return { ok: true, runs: open.length, worstCaseCents: open.length * RUN_CAP_CENTS, started: runIds.length, runIds } as const;
    },

    /** Starts a run per Person. The caps pace them; pressing again starts nothing a live run already covers. */
    async writePerPerson(workspaceId: string, campaignId: string, stepKey: string, a: { timeZone: string; userId: string }) {
      const r = await decide(workspaceId, campaignId, stepKey, d);
      if (!r.ok) return r;
      const brief = (await briefFor(workspaceId, d, r.planId, r.current, r.plan.currentVersion, r.plan.strategyVersion)).filter((b) => WRITER_BRIEF.has(b.kind));
      const factVersions = (await d.facts.usableFacts(workspaceId)).map((f) => ({ id: f.id, version: f.version }));
      const runIds: string[] = [];
      const failed: { personId: string; reason: string }[] = [];
      // The step's own email, which a person approved with the plan or wrote, so it rides in the request.
      // A person wrote the notes, so they ride in the request too.
      const request = `Write the email for the step "${r.planned.title}", planned for ${r.planned.on}, to the recipient below.${r.skeleton ? `\nThe step's email to start from:\nSubject: ${r.skeleton.subject}\n${r.skeleton.text}` : ""}${r.notes ? `\nThe person's notes for this step: ${r.notes}` : ""}`;
      for (const person of r.going) {
        const site = websiteFor(person.email ?? "", person.website, sharedMailDomain);
        const values = cleanListValues(person);
        // A quote that carries an address stays off the writer's input, as with the reader's quotes.
        const signals = (await d.signalsFor(workspaceId, person.personId)).filter((x) => !carriesAddress(x.quote)).map((x) => ({ kind: x.type, quote: x.quote, url: x.pageUrl }));
        const base = {
          person: {
            id: person.personId,
            text: `First name: ${values.firstName ?? "unknown"}\nCompany: ${values.company ?? "unknown"}`,
            next: { request, brief, factVersions, signals },
          },
          target: { id: campaignId, draftRevision: 0, stepKey, personId: person.personId, on: r.planned.on, timeZone: a.timeZone, userId: a.userId },
        };
        // No site: nothing to read, so the writer starts straight away.
        const run = site
          ? await d.startDraft()(workspaceId, { agent: "recipient_reader", input: { request: READ_REQUEST, brief: [], url: site, ...base } satisfies ReaderInput, startedBy: a.userId })
          : await d.startDraft()(workspaceId, { agent: "recipient_writer", input: writerInput(base, undefined, [], null), startedBy: a.userId });
        if (run.ok) runIds.push(run.run.id);
        else failed.push({ personId: person.personId, reason: run.reason });
      }
      return { ok: true, started: runIds.length, runIds, failed } as const;
    },
  };
  return api;
}

/**
 * Where a reader's quotes land: the ones the pages really hold go to a writer run. Safe to call twice,
 * since the same writer input on the same day is the same run.
 */
export async function readerSink(workspaceId: string, proposal: Parameters<Sink>[1], context: Parameters<Sink>[2], d: { startDraft?: (() => StartDraft) | undefined }): ReturnType<Sink> {
  if (!d.startDraft) return { ok: false, code: "no_start_draft" };
  const input = context.input as ReaderInput;
  const { kept } = keptDetails((proposal.body as ReaderOutput).details, context.pages);
  const details = kept.map((x) => ({ ...x, url: context.pages.find((p) => p.label === x.page)!.url }));
  const run = await d.startDraft()(workspaceId, { agent: "recipient_writer", input: writerInput(input, input.url, details, context.producer), startedBy: input.target.userId });
  return run.ok ? { ok: true, itemId: null } : { ok: false, code: run.reason };
}

/** Where a writer's email lands: an Action Item for that Person, unless they've left since. */
export async function writerSink(workspaceId: string, proposal: Parameters<Sink>[1], context: Parameters<Sink>[2], d: { facts: FactReads; now: () => Date; outreach?: (() => Outreach) | undefined; generate?: (() => Generate) | undefined; items?: (() => Items) | undefined }): ReturnType<Sink> {
  if (!d.outreach) return { ok: false, code: "no_outreach" };
  if (!d.items) return { ok: false, code: "no_items" };
  const input = context.input as WriterInput;
  const { target } = input;
  const output = proposal.body as PersonOutput;
  if (fieldsIn(`${output.subject}\n${output.text}`).length) return { ok: false, code: "unknown_merge_field" };
  const { details } = input.person;
  if (output.usedDetails.some((n) => n > details.length)) return { ok: false, code: "unknown_detail" };
  // Labelled from the quotes Direx checked, never from what the model says it used beyond their numbers.
  const used = output.usedDetails.map((n) => details[n - 1]!);

  const read = await inWorkspace(workspaceId, async (tx) => {
    const step = (await stepsOf(tx, target.id!)).find((s) => s.stepKey === target.stepKey);
    const person = (await allPeople(tx, target.id!)).find((p) => p.personId === target.personId);
    const existing = await activeActions(tx, target.id!, target.stepKey, target.personId);
    const mailboxes = await stepMailboxes(tx, target.id!, target.stepKey);
    const links = step ? await stepUrls(tx, { workspaceId, campaignId: target.id!, step, at: d.now() }) : null;
    return { step, person, existing, mailboxes, links };
  });
  if (target.redraft) {
    // A rewrite lands only on the email it was asked for, as it stood: a person's edit since wins.
    const now = await d.items().view(workspaceId, target.redraft);
    if (read.existing[0]?.itemId !== target.redraft || now?.revision !== target.draftRevision) return { ok: false, code: "changed_since" };
  } else if (read.existing[0]) return { ok: true, itemId: read.existing[0].itemId };
  if (!read.step || !read.mailboxes.length) return { ok: false, code: "mailbox_required" };
  if (read.person?.status !== "active") return { ok: false, code: "person_left" };
  if (read.links && !read.links.ok) return { ok: false, code: "waiting_on_step" };
  // The page this step waits on goes on its own line, added here, after every check of the writer's words.
  const urlLine = Object.values(read.links?.ok ? read.links.urls : {})[0];
  const text = urlLine ? `${output.text}\n\n${urlLine}` : output.text;

  // A number from a detail the writer used is sourced: Direx checked that quote against the recipient's page.
  const reviewed = await reviewTemplate(workspaceId, d.facts, { schemaVersion: 1, subject: output.subject, text: output.text, citations: output.citations }, used.map((u) => u.quote));
  const vouched = input.brief.map((b) => b.text).join("\n");
  const links = foreignLinks(`${output.subject}\n${output.text}`, vouched);
  const subjectRefused = replyPrefix(output.subject);
  const usable = await d.facts.usableFacts(workspaceId);
  const checks = await modelChecks(d.generate?.(), workspaceId, {
    key: context.runId,
    userId: target.userId,
    subject: output.subject,
    text: output.text,
    facts: usable.map((f) => ({ id: f.id, text: `${f.field}${f.subject ? ` (${f.subject})` : ""}: ${f.value}` })),
    details: details.map((x) => x.quote),
  });
  const found = checkWarnings(checks, subjectRefused);
  const decisions = [...reviewed.needsDecision, ...links.map((l) => warn("foreign_link", `A link no Fact holds: "${l}"`)), ...found.decisions];
  const warnings = [
    warn("untrusted_source", UNTRUSTED_WARNING),
    ...(details.length
      ? used.map(detailWarning)
      : [warn("not_based_on_site", `Not based on their website: ${input.site ? NOT_BASED.nothing_checked : NOT_BASED.no_website}.`)]),
    ...reviewed.warnings,
    ...found.warnings,
    ...decisions.map(needsDecision),
  ];

  if (target.redraft) {
    const revised = await reviseDraft(
      { items: d.items, outreach: d.outreach },
      { workspaceId, campaignId: target.id!, stepKey: target.stepKey, personId: target.personId, userId: target.userId, itemId: target.redraft },
      {
        // A rewrite keeps the Mailbox the draft was written with.
        credentialId: read.existing[0]!.credentialId ?? read.mailboxes[0]!,
        touchClass: read.step.touchClass as "cold" | "consented_marketing",
        subject: output.subject,
        text,
        plannedAt: read.existing[0]!.plannedAt ?? undefined,
        warnings,
        snapshot: [...factEntries(reviewed.citations), ...stepOutputEntries(target.id!, urlLine && read.links?.ok ? read.links.used : null)],
        submit: decisions.length === 0,
        proposedText: text,
      },
    );
    return revised.ok ? { ok: true, itemId: target.redraft } : { ok: false, code: revised.reason };
  }
  const sender = (await plannedSenders(workspaceId, target.id!, target.stepKey, [target.personId], { on: target.on, now: d.now() })).get(target.personId);
  const at = sender?.at;
  const placed = await placeDraft(
    { items: d.items, outreach: d.outreach },
    { workspaceId, campaignId: target.id!, stepKey: target.stepKey, personId: target.personId, userId: target.userId },
    {
      credentialId: sender?.credentialId ?? read.mailboxes[0]!,
      touchClass: read.step.touchClass as "cold" | "consented_marketing",
      subject: output.subject,
      text,
      plannedAt: at,
      warnings,
      snapshot: [...factEntries(reviewed.citations), ...stepOutputEntries(target.id!, urlLine && read.links?.ok ? read.links.used : null)],
      // Beside the Action, not in its snapshot: a person's approval never depends on them. A rule reads them once it's submitted.
      producer: { reader: input.reader, writer: context.producer, factVersions: input.factVersions, campaignId: target.id!, stepKey: target.stepKey },
      checks: checkRecord(checks, { subject: output.subject, text: output.text, linksFound: links.length > 0, subjectRefused }),
      // A working day before it goes.
      decideBy: at ? decideBy({ firstSlot: at, draftingDays: 0, timeZone: target.timeZone }) : undefined,
      // Anything that needs a decision stays a draft until a person edits it.
      submit: decisions.length === 0,
      proposedText: text,
    },
  );
  if (!placed.ok) return { ok: false, code: placed.reason };
  return { ok: true, itemId: placed.item.id };
}
