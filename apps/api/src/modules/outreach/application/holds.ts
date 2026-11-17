// SPDX-License-Identifier: AGPL-3.0-only
// Relationship holds: no cold mail to someone the Workspace is already talking to. A certain hold
// stops the Person's campaigns; a guess only holds, and a person can let it go.
import type { TriggerData } from "@direx/plugin-sdk";
import { createHmac, randomBytes } from "node:crypto";
import { isPlacementMessage, sentByCorrelation, type CheckResult, type Ledger } from "../../ledger";
import { emailsOfGroup, lockGroup, sharedMailDomain } from "../../people";
import { emailHashKey, endHold, holdsAtDomains, holdsOn, insertHolds, insertRelease, lastWrittenTo, latestReleases, recordCorrespondents, type HoldRow, type NewHold } from "../adapters/holds-repo";
import { inWorkspace, readSettings, type OutreachTx } from "../adapters/repo";
import { isHandWritten } from "../domain/hand-written";
import { companyOf, holdFor, INFERRED_FOR_DAYS, type CertainHold, type HoldState } from "../domain/holds";
import type { ReplyStop } from "./outside-touches";

export const IN_CONVERSATION = "in_conversation";
export const MAY_BE_TALKING = "may_be_talking";
/** [DEFAULT] A manual hold lasts this long unless someone renews it. */
export const MANUAL_HOLD_DAYS = 30;
const DAY = 86_400_000;

export type Hash = (email: string) => string;

/** Hashes addresses with the Workspace's own key, made on first use. */
export async function hasherFor(tx: OutreachTx, workspaceId: string, now: Date): Promise<Hash> {
  // Read first: every send's check calls this, and writing the settings row each time would queue them all on its lock.
  const key = (await readSettings(tx))?.emailHashKey ?? (await emailHashKey(tx, workspaceId, randomBytes(32).toString("hex"), now));
  return (email) => createHmac("sha256", key).update(email.trim().toLowerCase()).digest("hex");
}

const certain = (h: HoldRow): CertainHold => ({ reason: h.reason, startedAt: h.startedAt, expiresAt: h.expiresAt, endedAt: h.endedAt });

// ponytail: releases are read for the Person the Touch names, not their whole group; read the group's if merged records get released separately.
export async function holdOf(tx: OutreachTx, workspaceId: string, personId: string, now: Date): Promise<HoldState> {
  const emails = await emailsOfGroup(tx, personId);
  const hash = await hasherFor(tx, workspaceId, now);
  const hashes = emails.map(hash);
  const domains = [...new Set(emails.map((e) => companyOf(e, sharedMailDomain)).filter((d): d is string => d !== null))];
  const colleagues = await holdsAtDomains(tx, domains, hashes, now);
  return holdFor({
    now,
    own: (await holdsOn(tx, hashes)).map(certain),
    company: colleagues.map((h) => ({ ...certain(h), domain: h.domain! })),
    lastWritten: await lastWrittenTo(tx, hashes),
    released: await latestReleases(tx, [personId]),
  });
}

/**
 * What a hold means for one Touch. A certain one stops cold and consented marketing; a guess holds
 * cold only. Sales follow-ups, replies and service mail are the relationship, so nothing here stops them.
 */
export function holdResult(state: HoldState, touchClass: string): Exclude<CheckResult, { kind: "ok" }> | null {
  if (state.kind === "certain" && (touchClass === "cold" || touchClass === "consented_marketing")) return { kind: "block", reason: IN_CONVERSATION, detail: state.reason };
  if (touchClass !== "cold") return null;
  if (state.kind === "inferred") return { kind: "hold", reason: MAY_BE_TALKING, detail: "sent_mail" };
  if (state.kind === "company") return { kind: "hold", reason: MAY_BE_TALKING, detail: `company:${state.domain}` };
  return null;
}

/**
 * A hold as a screen shows it: the reason code and detail a cold email would get, which guess Release lets
 * go, and, once a certain hold has ended, the day the 90-day wait after it ends.
 */
export function holdView(state: HoldState): { reason: string; detail: string | null; release: "inferred" | "company" | null; waitUntil: string | null } | null {
  const r = holdResult(state, "cold");
  if (!r) return null;
  return {
    reason: r.reason,
    detail: r.detail ?? null,
    release: state.kind === "inferred" || state.kind === "company" ? state.kind : null,
    waitUntil: state.kind === "certain" && !state.running ? state.until.toISOString() : null,
  };
}

/**
 * One message from the founder's Sent mail, in the transaction that records the event: headers
 * only, parsed by the plugin host through the catalogue's mail.sent entry. Hand-written mail from
 * the last 90 days makes each recipient a correspondent; anything else changes nothing.
 */
export async function recordSentMail(tx: OutreachTx, e: { workspaceId: string; credentialId: string | null; data: TriggerData<"mail.sent"> }, now: Date): Promise<void> {
  const m = e.data;
  if (!e.credentialId) return;
  // A date in the future would hold someone for longer than 90 days.
  const at = new Date(Math.min(m.sentAt, now.getTime()));
  if (now.getTime() - at.getTime() > INFERRED_FOR_DAYS * DAY) return;
  // A Placement check carries no Direx header, so without this it would read as hand-written.
  if (m.messageId && (await isPlacementMessage(tx, [m.messageId]))) return;
  const ours = m.messageId && (await sentByCorrelation(tx, [m.messageId])) ? new Set([m.messageId]) : new Set<string>();
  if (!isHandWritten(m, ours)) return;
  const hash = await hasherFor(tx, e.workspaceId, now);
  await recordCorrespondents(tx, e.workspaceId, e.credentialId, m.recipients.map((r) => ({ emailHash: hash(r), at })));
}

export function createHolds(deps: { replies: () => ReplyStop; ledger: () => Pick<Ledger, "resumeHeldBy">; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());

  return {
    /** A person says "we're talking": the Person group's campaigns stop, and a new hold starts. */
    async addManual(workspaceId: string, personId: string, a: { reason: string; userId: string; days?: number }) {
      const at = now();
      const done = await inWorkspace(workspaceId, async (tx) => {
        // A Person this Workspace can't see has no emails here, so it's not found rather than an error.
        if (!(await emailsOfGroup(tx, personId)).length) return null;
        const { members } = await lockGroup(tx, personId);
        const emails = await emailsOfGroup(tx, personId);
        const hash = await hasherFor(tx, workspaceId, at);
        const expiresAt = new Date(at.getTime() + (a.days ?? MANUAL_HOLD_DAYS) * DAY);
        const rows: NewHold[] = emails.map((email) => ({
          workspaceId,
          emailHash: hash(email),
          domain: companyOf(email, sharedMailDomain),
          personId,
          source: "manual",
          sourceRef: null,
          reason: a.reason,
          startedAt: at,
          expiresAt,
          createdBy: a.userId,
        }));
        await insertHolds(tx, rows);
        return deps.replies().mark(tx, members, "removed");
      });
      if (!done) return { ok: false, reason: "no_email" } as const;
      if (done.length) await deps.replies().cancel(workspaceId, done);
      return { ok: true } as const;
    },

    /** Ending a hold early still leaves the 90-day wait after it. */
    async end(workspaceId: string, holdId: string, userId: string) {
      const row = await inWorkspace(workspaceId, (tx) => endHold(tx, holdId, userId, now()));
      return row ? ({ ok: true } as const) : ({ ok: false, reason: "not_found" } as const);
    },

    /** Lets a guess go; the held emails pass every check again before they send. */
    async release(workspaceId: string, personId: string, kind: "inferred" | "company", userId: string) {
      const found = await inWorkspace(workspaceId, async (tx) => {
        if (!(await emailsOfGroup(tx, personId)).length) return false;
        await insertRelease(tx, { workspaceId, personId, kind, releasedAt: now(), releasedBy: userId });
        return true;
      });
      if (!found) return { ok: false, reason: "not_found" } as const;
      const resumed = await deps.ledger().resumeHeldBy(workspaceId, MAY_BE_TALKING, { userId }, async (_tx, held) => held.personId === personId);
      return { ok: true, resumed } as const;
    },

    /** Records the recipients of hand-written mail, by hash. */
    recordWritten: (workspaceId: string, credentialId: string, rows: readonly { email: string; at: Date }[]) =>
      inWorkspace(workspaceId, async (tx) => {
        const hash = await hasherFor(tx, workspaceId, now());
        await recordCorrespondents(tx, workspaceId, credentialId, rows.map((r) => ({ emailHash: hash(r.email), at: r.at })));
      }),

    holdOf: (workspaceId: string, personId: string) => inWorkspace(workspaceId, (tx) => holdOf(tx, workspaceId, personId, now())),

    /** What holds a Person's cold email, which guess can be let go, and the running holds a person can end. */
    ofPerson: (workspaceId: string, personId: string) =>
      inWorkspace(workspaceId, async (tx) => {
        const at = now();
        const state = await holdOf(tx, workspaceId, personId, at);
        const hash = await hasherFor(tx, workspaceId, at);
        const rows = await holdsOn(tx, (await emailsOfGroup(tx, personId)).map(hash));
        return {
          hold: holdView(state),
          holds: rows.filter((r) => !r.endedAt && r.expiresAt > at).map((r) => ({ id: r.id, source: r.source, reason: r.reason, expiresAt: r.expiresAt.toISOString() })),
        };
      }),
  };
}

export type Holds = ReturnType<typeof createHolds>;
