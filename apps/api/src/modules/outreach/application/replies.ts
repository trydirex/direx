// SPDX-License-Identifier: AGPL-3.0-only
// Inbound mail that might stop mail to someone. What needs no model is settled in the transaction that
// records the event, so an opt-out counts the moment it's read; the rest waits for a job, and sends to
// that Person are held meanwhile. Reply text is untrusted and is never logged.
import type { TriggerData } from "@direx/plugin-sdk";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import { warn, type Items, type ItemKind } from "../../items";
import { failureOf } from "../../plugins/index";
import { isOwnProbe, sendJobInTx, sentByCorrelation, sentTo, type Ledger } from "../../ledger";
import { emailsOfGroup, normaliseKey, personIdWithEmail } from "../../people";
import { inWorkspace, insertSignal, lockSignal, overdueReadBacks, readSignal, settleSignal, suppress, type NewSignal, type OutreachTx, type Signal } from "../adapters/repo";
import { isHardBounce, isPermanentFailure, statusOf } from "../domain/dsn";
import { readOptOut } from "../domain/optout";
import { autoSubject, autoSubmitted, settleByRules } from "../domain/reply-rules";
import { pauseOnBounces } from "./mailboxes";
import { askOptOut, type Generate } from "./optout-model";
import type { ReplyDesk } from "./reply-desk";

export const REPLY_QUEUE = "outreach.reply";
const QUOTE_CHARS = 200;
const HELD_FOR_REPLY = "reply_unread";
const READ_BACK_RETRY_MS = 5 * 60 * 1000;
/** How long a read-back search may keep failing, for a reason other than a Mailbox, before a person is asked. */
const READ_BACK_ASK_AFTER_MS = 86_400_000;

/**
 * A search failure that reconnecting the Mailbox fixes: the plugin SDK refusing the call because its
 * credential is malformed, the plugin finding no usable credential, or the provider refusing it,
 * read from the call's typed reason (ADR 0028 rule 002).
 */
export const mailboxNeedsReconnect = (e: unknown): boolean => ["invalid_params", "not_connected", "credential_rejected"].includes(failureOf(e).reason);

const JobPayload = z.strictObject({ workspaceId: z.uuid(), signalId: z.uuid() });
const ReviewPayload = z.object({ signalId: z.uuid() });

/** Received mail, its data parsed by the plugin host through the catalogue's email.received entry. */
export type InboundEvent = { workspaceId: string; credentialId: string | null; eventId: string; data: TriggerData<"email.received"> };

function senderOf(from: string): string | null {
  const address = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(from)?.[1] ?? from.trim();
  const key = normaliseKey("email", address);
  return key.ok ? key.value : null;
}

/** The Message-IDs named in headers such as In-Reply-To and References. */
export const messageIds = (...headers: string[]) => headers.flatMap((h) => h.match(/<[^<>\s]+>/g) ?? []);

async function suppressAll(tx: OutreachTx, s: Pick<Signal, "workspaceId" | "senderEmail" | "personId">, at: Date) {
  const group = s.personId ? await emailsOfGroup(tx, s.personId) : [];
  for (const email of new Set([s.senderEmail, ...group])) await suppress(tx, s.workspaceId, email, "reply", at);
}

/** The Person behind a message a human wrote: not a bounce or an auto-reply. Null for anyone else. */
export async function humanReply(tx: OutreachTx, e: InboundEvent): Promise<string | null> {
  if (e.data.dsn?.recipients.length) return null;
  const { headers, autoSubmitted: submitted } = e.data;
  if (autoSubmitted(submitted) || autoSubject(headers.subject)) return null;
  const sender = senderOf(headers.from);
  if (!sender) return null;
  const sent = await sentByCorrelation(tx, messageIds(headers.inReplyTo, headers.references));
  return sent?.personId ?? (await personIdWithEmail(tx, sender));
}

export type RepliesDeps = {
  boss: PgBoss;
  items: () => Items;
  ledger: () => Pick<Ledger, "resumeHeldBy">;
  /** The pinned `optout_detect` model; without one, every reply the rules leave goes to a person. */
  generate?: () => Generate | undefined;
  /**
   * Recent mail from one address across this Workspace's Mailboxes. `complete` is false when one of
   * them couldn't be searched, such as one that needs reconnecting.
   */
  searchMailboxes?: (workspaceId: string, email: string) => Promise<{ events: InboundEvent[]; complete: boolean }>;
  /** Whether mail a search found belongs to another consumer, such as a Placement check; claimed mail never reaches intake. */
  claim?: (tx: OutreachTx, e: InboundEvent) => Promise<boolean>;
  /** Opens a reply Item for each human reply that isn't an opt-out. Without it, such a reply is only recorded. */
  desk?: ReplyDesk;
  now?: () => Date;
};

export function createReplies(deps: RepliesDeps) {
  const now = deps.now ?? (() => new Date());

  const record = async (tx: OutreachTx, row: NewSignal) => {
    const signal = await insertSignal(tx, row);
    if (signal) await sendJobInTx(deps.boss, tx, REPLY_QUEUE, JobPayload.parse({ workspaceId: row.workspaceId, signalId: signal.id }), row.receivedAt);
    return signal;
  };

  /** One delivery notice row per failed address we really sent to, so a forged notice stops nobody. */
  async function bounces(tx: OutreachTx, e: InboundEvent, recipients: { email: string; status: string }[], at: Date) {
    let recorded = false;
    for (const { email, status } of recipients) {
      // The notice flow exposes recipients, but no original-send Message-ID. Keep recipient
      // matching within the receiving Mailbox; the notice's own Message-ID is not the send's.
      const sent = await sentTo(tx, email, e.credentialId);
      if (!sent) continue;
      if (await record(tx, { workspaceId: e.workspaceId, credentialId: e.credentialId, eventId: `${e.eventId}:${email}`, senderEmail: email, personId: sent.personId, actionId: sent.actionId, kind: "bounce", status: "recorded", bounceStatus: status, receivedAt: at })) recorded = true;
      if (isHardBounce(status)) await suppress(tx, e.workspaceId, email, "hard_bounce", at);
    }
    // A notice comes back to the Mailbox that sent the email.
    if (recorded && e.credentialId) await pauseOnBounces(tx, e.credentialId, at);
  }

  // Mail from a stranger is dropped unread, so an opt-out sent before someone became a Person is only
  // found by looking again. Until the search has run, the open marker holds their cold sends.
  // It records only after every Mailbox was searched. A Mailbox that needs reconnecting keeps it
  // waiting, since reconnecting fixes the search; any other failure asks a person after a day.
  async function readBack(signal: Signal) {
    const known = await inWorkspace(signal.workspaceId, (tx) => personIdWithEmail(tx, signal.senderEmail));
    if (!known) throw new Error("outreach: the Person for a read-back isn't saved yet");
    let found: { events: InboundEvent[]; complete: boolean };
    try {
      found = (await deps.searchMailboxes?.(signal.workspaceId, signal.senderEmail)) ?? { events: [], complete: true };
    } catch (e) {
      if (now().getTime() - signal.receivedAt.getTime() < READ_BACK_ASK_AFTER_MS) throw e;
      return askPerson(signal, `Direx couldn't search past mail from ${signal.senderEmail}. Did they ask to stop?`);
    }
    if (!found.complete) throw new Error("outreach: a Mailbox needs reconnecting before this read-back can finish");
    await inWorkspace(signal.workspaceId, async (tx) => {
      for (const e of found.events) if (!(await deps.claim?.(tx, e))) await api.intake(tx, e);
      await settleSignal(tx, signal.id, { status: "recorded", decidedAt: now() });
    });
  }

  /** One opt-out question for a person, which no bulk approval can answer. */
  async function askPerson(signal: Signal, title: string) {
    const made = await deps.items().createItem(signal.workspaceId, {
      kind: "opt_out_review",
      payload: { signalId: signal.id },
      actor: { system: "outreach" },
      details: { title, workArea: "outreach", channel: "email", warnings: [warn("opt_out_question", "This needs your answer, so it can't be approved in bulk.")] },
    });
    if (!made.ok) throw new Error(`outreach: ${made.reason}: the item kinds aren't registered`);
    await inWorkspace(signal.workspaceId, (tx) => settleSignal(tx, signal.id, { status: "needs_person" }));
  }

  const api = {
    /** Called before a new address becomes a Person, so no send can slip in ahead of the search. */
    markReadBack(workspaceId: string, email: string) {
      const at = now();
      return inWorkspace(workspaceId, (tx) => record(tx, { workspaceId, eventId: `read_back:${email}`, senderEmail: email, kind: "read_back", status: "pending", receivedAt: at }));
    },

    /** Runs again any search that ran out of retries, such as during a provider outage. */
    async retryReadBacks(workspaceId: string) {
      const ids = await inWorkspace(workspaceId, (tx) => overdueReadBacks(tx, new Date(now().getTime() - READ_BACK_RETRY_MS)));
      // The worker asks once a minute per mailbox, so one job per search in each retry window.
      // ponytail: a search that can never finish is still retried every window; settle it after N tries if that shows up.
      for (const signalId of ids) {
        await deps.boss.send(REPLY_QUEUE, JobPayload.parse({ workspaceId, signalId }), { singletonKey: `read_back:${signalId}`, singletonSeconds: READ_BACK_RETRY_MS / 1000 });
      }
    },

    /** The trigger's consumer. A throw rolls the batch back, so the same mail comes again. */
    async intake(tx: OutreachTx, e: InboundEvent): Promise<void> {
      const { headers, text, dsn, autoSubmitted: submitted } = e.data;
      const at = now();

      const listed = dsn?.recipients ?? [];
      const failed = listed.flatMap((r) => {
        const status = statusOf(r.status, text, listed.length);
        return isPermanentFailure(status) ? [{ email: r.email, status }] : [];
      });
      if (failed.length) return bounces(tx, e, failed, at);

      const sender = senderOf(headers.from);
      if (!sender) return;
      // A Mailbox check is read back by its own query; as intake it would only look like mail from a Person.
      if (e.credentialId && (await isOwnProbe(tx, e.credentialId, headers.subject))) return;
      const sent = await sentByCorrelation(tx, messageIds(headers.inReplyTo, headers.references));
      const known = await personIdWithEmail(tx, sender);
      if (!sent && !known) return;

      const base = { workspaceId: e.workspaceId, credentialId: e.credentialId, eventId: e.eventId, senderEmail: sender, personId: sent?.personId ?? known, actionId: sent?.actionId ?? null, kind: "reply", receivedAt: at } as const;
      const settled = { decidedBy: "rule", decidedAt: at } as const;
      const ruled = settleByRules({ text, subject: headers.subject, autoSubmitted: submitted });
      if (ruled.status === "opted_out") {
        const signal = await record(tx, { ...base, ...settled, status: "opted_out", quote: ruled.quote.slice(0, QUOTE_CHARS) });
        if (signal) await suppressAll(tx, signal, at);
        return;
      }
      if (ruled.status === "not_opt_out") {
        await record(tx, { ...base, ...settled, status: "not_opt_out" });
        return;
      }
      await record(tx, { ...base, status: "pending", text: ruled.words });
    },

    /** Runs a decision that needed time, then wakes whatever this Person's unread reply was holding. */
    async decide(workspaceId: string, signalId: string): Promise<void> {
      const signal = await inWorkspace(workspaceId, (tx) => readSignal(tx, signalId));
      if (!signal) return;
      if (signal.kind === "read_back" && signal.status === "pending") await readBack(signal);
      else if (signal.status === "pending") {
        const reading = readOptOut(await askOptOut(deps.generate?.(), workspaceId, signalId, signal.text ?? ""), signal.text ?? "");
        if (reading.decided !== "person") {
          const at = now();
          await inWorkspace(workspaceId, async (tx) => {
            const locked = await lockSignal(tx, signalId);
            if (locked?.status !== "pending") return;
            if (reading.decided === "opted_out") {
              await settleSignal(tx, signalId, { status: "opted_out", decidedBy: "model", decidedAt: at, quote: reading.quote.slice(0, QUOTE_CHARS), text: null });
              await suppressAll(tx, locked, at);
            } else {
              // The words stay for the reply desk until a person settles its Item; the 30-day clear still applies.
              await settleSignal(tx, signalId, { status: "not_opt_out", decidedBy: "model", decidedAt: at });
            }
          });
        } else {
          await askPerson(signal, `Did ${signal.senderEmail} ask to stop?`);
          return;
        }
      }
      if (signal.status === "needs_person") return;
      if (deps.desk) {
        const settled = await inWorkspace(workspaceId, (tx) => readSignal(tx, signalId));
        if (settled) await deps.desk.open(settled);
      }
      await deps.ledger().resumeHeldBy(workspaceId, HELD_FOR_REPLY, { system: "outreach" }, async (tx, touch) => {
        if (touch.personId === signal.personId) return true;
        return (await emailsOfGroup(tx, touch.personId)).includes(signal.senderEmail);
      });
    },

    ensureQueue: () => deps.boss.createQueue(REPLY_QUEUE, { retryLimit: 5, retryDelay: 5, retryBackoff: true }),

    /** Works outreach.reply jobs. A malformed payload fails the job; it is never guessed at. */
    async work(): Promise<void> {
      await api.ensureQueue();
      await deps.boss.work(REPLY_QUEUE, { pollingIntervalSeconds: 1 }, async (jobs) => {
        for (const job of jobs) {
          const p = JobPayload.parse(job.data);
          await api.decide(p.workspaceId, p.signalId);
        }
      });
    },
  };
  return api;
}
export type Replies = ReturnType<typeof createReplies>;

/** A person settles a reply nothing else could. A retried job can leave a second Item, which then does nothing. */
export function optOutReviewKind(deps: { boss: PgBoss; now?: () => Date }): Record<string, ItemKind> {
  const now = deps.now ?? (() => new Date());
  return {
    opt_out_review: {
      permission: "item.approve",
      async apply(tx, item, _actor, choice) {
        if (choice !== "opted_out" && choice !== "not_opt_out") return { ok: false, reason: "choice_required" };
        const { signalId } = ReviewPayload.parse(item.payload);
        const signal = await lockSignal(tx, signalId);
        if (signal?.status !== "needs_person") return { ok: true };
        const at = now();
        const quote = choice === "opted_out" ? (signal.text?.slice(0, QUOTE_CHARS) ?? null) : null;
        // A reply that isn't an opt-out keeps its words for the reply desk, which drops them when settled.
        await settleSignal(tx, signalId, { status: choice, decidedBy: "person", decidedAt: at, quote, ...(choice === "opted_out" && { text: null }) });
        if (choice === "opted_out") await suppressAll(tx, signal, at);
        await sendJobInTx(deps.boss, tx, REPLY_QUEUE, JobPayload.parse({ workspaceId: item.workspaceId, signalId }), at);
        return { ok: true };
      },
    },
  };
}
