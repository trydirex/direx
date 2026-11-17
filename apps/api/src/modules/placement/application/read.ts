// SPDX-License-Identifier: AGPL-3.0-only
// Reading the Placement checks other Circle members send this Mailbox, by labels and Message-ID only.
// Each morning the Mailbox records the checks it expects that day: a plain and a content check from
// each member the day's seed pairs it with. Two hours after a check's expected time it is found by
// the provider's search, by its sender, subject text and window, and its verdict is recorded; a
// content check found in the inbox is then archived by its own Action. The reply poll leaves expected
// checks unfetched, and inbound routing claims any that reach it anyway.
// A content check is read only within the receiver's caps: at most 2 found from one sender a week,
// none from a member listed under 4 weeks unless the founder controls it. One over them is ordinary mail.
import type { QueryOutput, SkipMail } from "@direx/plugin-sdk";
import { credentialSettings } from "../../credentials/index";
import type { Ledger, SnapshotEntry } from "../../ledger/index";
import type { Deployment } from "../../models/index";
import type { QueryId, QueryOf } from "../../plugins/index";
import { contentFound, dueReads, expectedChecks, inWorkspace, insertProbe, markNotSent, probeById, probeRow, recordArchive, recordVerdict, type PlacementTx, type ProbeRow } from "../adapters/repo";
import { LIBRARY_APPROVED } from "../domain/library";
import type { Placement } from "./grant";
import type { JoinFor } from "./join";
import { trustList } from "./list";
import { probeIdentity, seed, sendersTo, WINDOW_AFTER_MINUTES, WINDOW_BEFORE_MINUTES } from "./pairing";
import type { MatchInbound } from "./route";
import { approvePlacement, CONTENT_PER_WEEK, daysFrom, NEW_MEMBER_DAYS, weekOf, type NotToday } from "./send";

/** A check is read this long after its expected time [DEFAULT]. */
export const READ_AFTER_MS = 2 * 3_600_000;
const MIN = 60_000;
const DAY_MS = 86_400_000;

export type Verdict = "primary" | "other_tab" | "spam" | "missing" | "query_failure";
/** What the provider says of one expected check, as the host parsed it. */
export type CheckRead = QueryOutput<"placement.read">;

/** Spam first, then the inbox by tab; anywhere else, or not found, is missing. */
export function verdictOf(r: CheckRead): Verdict {
  if (!r.found) return "missing";
  if (r.spam) return "spam";
  if (r.inbox) return r.otherTab ? "other_tab" : "primary";
  return "missing";
}

const norm = (a: string) => a.trim().toLowerCase();
const addressOf = (from: string) => norm(/<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from)?.[1] ?? from);

/** How an expected check is found: a plain check leaves out that day's content tag from the same sender. */
async function searchOf(tx: PlacementTx, row: ProbeRow): Promise<SkipMail | null> {
  if (!row.subject) return null;
  const content = row.kind === "plain" ? await probeRow(tx, { credentialId: row.credentialId, direction: "receive", day: row.day, peer: row.peer, kind: "content" }) : undefined;
  const at = row.expectedAt.getTime();
  return { from: row.peer, subject: row.subject, ...(content?.subject && { notSubject: content.subject }), after: at - WINDOW_BEFORE_MINUTES * MIN, before: at + WINDOW_AFTER_MINUTES * MIN };
}

/** Whether this Mailbox reads an expected check: a content check only while under the week's cap. */
async function readable(tx: PlacementTx, row: ProbeRow): Promise<boolean> {
  if (row.kind === "plain" || row.verdict !== null) return true;
  return (await contentFound(tx, row.credentialId, row.peer, weekOf(row.day))) < CONTENT_PER_WEEK;
}

/** How far back a poll is told what to skip: a full read and a search for one sender look back 7 days. */
const SKIP_DAYS = 8;

/** The expected checks one Mailbox's polls must not fetch, over every day a poll or search reads. */
export async function checksToSkip(tx: PlacementTx, credentialId: string, at: Date): Promise<SkipMail[]> {
  const out: SkipMail[] = [];
  for (const row of await expectedChecks(tx, credentialId, new Date(at.getTime() - SKIP_DAYS * DAY_MS), new Date(at.getTime() + DAY_MS))) {
    const search = (await readable(tx, row)) ? await searchOf(tx, row) : null;
    if (search) out.push(search);
  }
  return out;
}

/** The same, in its own transaction, for the host's poll. */
export const skipFor = (workspaceId: string, credentialId: string, at: Date) => inWorkspace(workspaceId, (tx) => checksToSkip(tx, credentialId, at));

/**
 * Inbound mail that is an expected check this Mailbox reads, by what the event already carries: its
 * sender, subject and Date inside the check's window. A content check over the caps is not one.
 */
export const matchExpected: MatchInbound = async (tx, e) => {
  if (!e.credentialId) return false;
  const { headers } = e.data;
  const sent = Date.parse(headers.date);
  if (Number.isNaN(sent)) return false;
  const from = addressOf(headers.from);
  const subject = headers.subject.toLowerCase();
  for (const row of await expectedChecks(tx, e.credentialId, new Date(sent - WINDOW_AFTER_MINUTES * MIN), new Date(sent + WINDOW_BEFORE_MINUTES * MIN))) {
    if (norm(row.peer) !== from) continue;
    const search = await searchOf(tx, row);
    if (!search || !subject.includes(search.subject.toLowerCase()) || (search.notSubject && subject.includes(search.notSubject.toLowerCase()))) continue;
    if (await readable(tx, row)) return true;
  }
  return false;
};

export type ArchiveRefusal = "not_found" | "not_content" | "no_verdict" | "in_spam" | "not_in_inbox" | "not_granted" | "provider_cannot_archive";

export function createReading(deps: {
  placement: Pick<Placement, "binding">;
  ledger: () => Pick<Ledger, "createActionIn" | "submitForApproval" | "approve" | "getAction">;
  /** The Mailbox provider's placement.read query, if it has one. */
  readFor: (workspaceId: string, credentialId: string) => Promise<QueryId<"placement.read"> | undefined>;
  archiveFor: JoinFor;
  query: QueryOf<"placement.read">;
  deployment: () => Deployment;
  trust?: (workspaceId: string) => ReturnType<typeof trustList>;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  const trust = deps.trust ?? ((workspaceId: string) => trustList(workspaceId));

  const api = {
    /** Records the checks this Mailbox expects today; a second run the same day adds nothing. */
    async plan(workspaceId: string, credentialId: string): Promise<{ ok: true; planned: number } | { ok: false; reason: NotToday }> {
      const at = now();
      const off = (reason: NotToday) => ({ ok: false as const, reason });
      if (deps.deployment() === "cloud") return off("not_available");
      if (!(await deps.placement.binding(workspaceId, credentialId))) return off("not_granted");
      // A provider that can't read checks by labels alone expects none, so its poll skips nothing.
      if (!(await deps.readFor(workspaceId, credentialId))) return off("provider_cannot_send");
      const list = await trust(workspaceId);
      if (!list.ok) return off("no_list");
      const settings = await inWorkspace(workspaceId, (tx) => credentialSettings(tx, credentialId));
      const address = norm(String(settings?.meta.username ?? settings?.key ?? ""));
      const members = list.trusted.list.members;
      const me = members.find((m) => m.address === address);
      if (!me) return off("not_listed");

      const s = seed(at, list.trusted.contentHash);
      let planned = 0;
      for (const from of sendersTo(s, address, members)) {
        const sender = members.find((m) => m.address === from)!;
        for (const kind of ["plain", "content"] as const) {
          if (kind === "plain" && !LIBRARY_APPROVED) continue;
          const id = probeIdentity(s, sender, me, kind);
          const isNew = kind === "content" && !sender.founder_controlled && daysFrom(sender.listed_at, s.day) < NEW_MEMBER_DAYS;
          const key = { credentialId, direction: "receive", day: s.day, peer: sender.address, kind };
          const made = await inWorkspace(workspaceId, async (tx) => {
            if (await probeRow(tx, key)) return false;
            await insertProbe(tx, { workspaceId, ...key, listVersion: list.trusted.version, seq: kind === "plain" ? 0 : 1, expectedAt: id.expectedAt, subject: id.subject, skipReason: isNew ? "new_member" : null, createdAt: at });
            return true;
          });
          if (made) planned++;
        }
      }
      return { ok: true, planned };
    },

    /** Reads every expected check of this Workspace now due, records its verdict, and archives a content check found in the inbox. */
    async readDue(workspaceId: string): Promise<number> {
      if (deps.deployment() === "cloud") return 0;
      const at = now();
      let read = 0;
      for (const row of await inWorkspace(workspaceId, (tx) => dueReads(tx, new Date(at.getTime() - READ_AFTER_MS)))) {
        if (!(await deps.placement.binding(workspaceId, row.credentialId))) continue;
        const capability = await deps.readFor(workspaceId, row.credentialId);
        if (!capability) continue;
        const search = await inWorkspace(workspaceId, async (tx) => {
          if (await readable(tx, row)) return searchOf(tx, row);
          // Over the week's cap: never read, and not a result.
          await markNotSent(tx, row.id, "content_week_cap");
          return null;
        });
        if (!search) continue;
        let r: CheckRead | null = null;
        try {
          r = await deps.query(workspaceId, capability, search, row.credentialId);
        } catch {
          // A failed read is never taken for a check that went missing.
        }
        const verdict = r ? verdictOf(r) : "query_failure";
        const saved = await inWorkspace(workspaceId, (tx) => recordVerdict(tx, row.id, { verdict, readAt: at, messageId: r?.found ? r.messageId : null }));
        if (!saved) continue;
        read++;
        if (saved.kind === "content" && (verdict === "primary" || verdict === "other_tab") && saved.messageId) await api.archive(workspaceId, saved.id);
      }
      return read;
    },

    /** One placement.archive Action for a content check received here, read and in the inbox; the same check again gives the same Action. */
    async archive(workspaceId: string, probeId: string): Promise<{ ok: true; actionId: string } | { ok: false; reason: ArchiveRefusal }> {
      const row = await inWorkspace(workspaceId, (tx) => probeById(tx, probeId));
      const refuse = (reason: ArchiveRefusal) => ({ ok: false as const, reason });
      if (!row || row.direction !== "receive") return refuse("not_found");
      if (row.kind !== "content") return refuse("not_content");
      if (!row.verdict) return refuse("no_verdict");
      if (row.verdict === "spam") return refuse("in_spam");
      if ((row.verdict !== "primary" && row.verdict !== "other_tab") || !row.messageId) return refuse("not_in_inbox");
      const grant = await deps.placement.binding(workspaceId, row.credentialId);
      if (!grant) return refuse("not_granted");
      const effect = await deps.archiveFor(workspaceId, row.credentialId);
      if (!effect) return refuse("provider_cannot_archive");
      const { spec } = await effect.prepare(workspaceId, { messageId: row.messageId });
      const actionId = await inWorkspace(workspaceId, async (tx) => {
        const { action } = await deps.ledger().createActionIn(tx, workspaceId, { idempotencyKey: `placement_archive:${row.id}`, capability: effect.id, dedupe: effect.dedupe, spec, credentialId: row.credentialId, actor: { system: "placement" } });
        await recordArchive(tx, row.id, action.id);
        return action.id;
      });
      const snapshot: SnapshotEntry[] = [...grant.snapshot, ...(effect.version ? [{ kind: "capability", id: effect.id, version: effect.version }] : [])];
      await approvePlacement(deps.ledger(), workspaceId, actionId, grant.approverId, snapshot);
      return { ok: true, actionId };
    },
  };
  return api;
}
export type Reading = ReturnType<typeof createReading>;
