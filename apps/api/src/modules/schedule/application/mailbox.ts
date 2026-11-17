// SPDX-License-Identifier: AGPL-3.0-only
// A Mailbox's daily limit: one reservation per email on its Mailbox's day, taken under a lock on
// that Mailbox so two writers can't both take the last place. Every path that sets an email's send
// time calls reserveMailbox; automatic paths find their time with nextMailboxTime first.
import { actionStates, type ActionRow, type Check, type CheckResult, type LedgerTx } from "../../ledger";
import { inWorkspace, type ScheduleTx } from "../adapters/schedule-repo";
import { insertMailboxReservation, lockMailbox, mailboxesAround, newestAround, newestFor, paceOf, sendOf, workspaceZone } from "../adapters/mailbox-repo";
import { countedOn, DEFAULT_PACE, insideHours, localTime, mailboxDay, nextDay, plan, sendsOn, type MailboxPace } from "../domain/mailbox";

export type MailboxReserveResult =
  | { kind: "reserved"; day: string }
  /** Not an email from a Mailbox, so the limit doesn't apply. */
  | { kind: "not_counted" }
  | { kind: "full"; day: string; limit: number }
  | { kind: "not_found" };

/** Whether an Action counts toward its Mailbox's day: an email sent from a connected Mailbox. */
const counted = (capability: string, credentialId: string | null): credentialId is string => !!credentialId && capability.split("/").at(-1) === "email.send";

async function dayCount(tx: ScheduleTx, credentialId: string, on: string, now: Date, exceptActionId?: string): Promise<number> {
  const rows = await newestAround(tx, credentialId, on, on);
  const states = await actionStates(tx, rows.map((r) => r.actionId));
  return countedOn(on, rows, states, now, exceptActionId);
}

/**
 * Takes the Action's place on its Mailbox's day for `slot`, in the caller's transaction. Staying on
 * the day it already holds always fits, so approving or moving within a day never refuses.
 */
export async function reserveMailboxIn(tx: ScheduleTx, workspaceId: string, actionId: string, slot: Date, now: Date): Promise<MailboxReserveResult> {
  const send = await sendOf(tx, actionId);
  if (!send) return { kind: "not_found" };
  if (!counted(send.capability, send.credentialId)) return { kind: "not_counted" };
  const credentialId = send.credentialId;
  const mailbox = await paceOf(tx, credentialId);
  if (!mailbox) return { kind: "not_found" };
  await lockMailbox(tx, credentialId);
  const on = mailboxDay(slot, mailbox.timeZone);
  const own = await newestFor(tx, actionId);
  if (own?.day === on && own.slot.getTime() === slot.getTime()) return { kind: "reserved", day: on };
  if (own?.day !== on && (await dayCount(tx, credentialId, on, now, actionId)) >= mailbox.pace.dailyLimit) {
    return { kind: "full", day: on, limit: mailbox.pace.dailyLimit };
  }
  // Wall time, not the caller's clock: it orders an Action's reservations.
  await insertMailboxReservation(tx, { workspaceId, actionId, credentialId, day: on, slot, createdAt: new Date() });
  return { kind: "reserved", day: on };
}

export function reserveMailbox(workspaceId: string, actionId: string, slot: Date, opts: { now?: Date } = {}): Promise<MailboxReserveResult> {
  return inWorkspace(workspaceId, (tx) => reserveMailboxIn(tx, workspaceId, actionId, slot, opts.now ?? new Date()));
}

/** The most a Mailbox sends in a day, emails and Placement checks together, whatever its pace. */
export const PROVIDER_CEILING = 2000;

/**
 * Takes the Mailbox's lock for the caller's transaction and returns how many emails count on its day
 * holding `at`: for mail its daily limit leaves out, such as Placement checks, which still count
 * toward the provider ceiling.
 */
export async function lockMailboxDay(tx: ScheduleTx, credentialId: string, at: Date, now: Date): Promise<number> {
  await lockMailbox(tx, credentialId);
  const mailbox = await paceOf(tx, credentialId);
  return mailbox ? dayCount(tx, credentialId, mailboxDay(at, mailbox.timeZone), now) : 0;
}

/** How far ahead an automatic path looks for a day with room. */
const SEARCH_DAYS = 60;

/**
 * The first time at or after `from` inside the Mailbox's hours, on a day with room for this Action:
 * the time itself when it fits, otherwise the next day's first sending minute. Null when nothing
 * within the search horizon has room. An Action that isn't a counted email gets `from` back.
 */
export async function nextMailboxTime(workspaceId: string, actionId: string, from: Date, opts: { now?: Date } = {}): Promise<Date | null> {
  const now = opts.now ?? new Date();
  return inWorkspace(workspaceId, async (tx) => {
    const send = await sendOf(tx, actionId);
    if (!send || !counted(send.capability, send.credentialId)) return from;
    const mailbox = await paceOf(tx, send.credentialId);
    if (!mailbox) return from;
    return searchIn(tx, send.credentialId, mailbox, actionId, from, now);
  });
}

async function searchIn(tx: ScheduleTx, credentialId: string, { pace, timeZone }: { pace: MailboxPace; timeZone: string }, actionId: string, from: Date, now: Date): Promise<Date | null> {
  for (let on = mailboxDay(from, timeZone), n = 0; n < SEARCH_DAYS; on = nextDay(on), n++) {
    if (!sendsOn(on, pace) || (await dayCount(tx, credentialId, on, now, actionId)) >= pace.dailyLimit) continue;
    const opens = localTime(on, pace.sendFrom, timeZone);
    const at = from > opens ? from : opens;
    if (insideHours(at, pace, timeZone)) return at;
  }
  return null;
}

/** An email that has gone out, or may have: what "already sent" means for a Mailbox's day. */
const gone = (s: { state: string; holdReason: string | null; outcomeUnknownAt?: Date | null } | undefined) =>
  !!s && (s.state === "sent" || s.state === "claimed" || s.state === "dispatching" || (s.state === "held" && s.holdReason === "outcome_unknown") || !!s.outcomeUnknownAt);

/**
 * The ledger check for a Mailbox's day, at claim and again at dispatch: when the Mailbox has already
 * sent its limit today, the email goes at the next time with room, keeping its approval. It only
 * counts what has gone, so after a limit is lowered the earliest emails still send and the rest move.
 * Read without the Mailbox lock: the dispatcher holds the Action row, and the move reserves after.
 */
export function mailboxDayCheck(deps: { now: () => Date }): Check {
  return async (tx: LedgerTx, row: ActionRow): Promise<CheckResult> => {
    if (!counted(row.capability, row.credentialId)) return { kind: "ok" };
    const mailbox = await paceOf(tx, row.credentialId);
    if (!mailbox) return { kind: "ok" };
    const now = deps.now();
    const today = mailboxDay(now, mailbox.timeZone);
    const rows = await newestAround(tx, row.credentialId, today, today);
    const states = await actionStates(tx, rows.map((r) => r.actionId));
    const sent = rows.filter((r) => r.day === today && r.actionId !== row.id && gone(states.get(r.actionId))).length;
    if (sent < mailbox.pace.dailyLimit) return { kind: "ok" };
    const at = await searchIn(tx, row.credentialId, mailbox, row.id, localTime(nextDay(today), 0, mailbox.timeZone), now);
    const detail = `${today} already sent ${mailbox.pace.dailyLimit}`;
    if (!at) return { kind: "hold", reason: "mailbox_day_full", detail: `${detail}, and no day in ${SEARCH_DAYS} has room` };
    return { kind: "later", reason: "mailbox_day_full", at, detail: `${detail}; moved to ${at.toISOString()}` };
  };
}

/**
 * Send times for `count` new emails from a Mailbox, from day `on`: inside its hours, evenly spaced, at
 * most its limit a day after what each day already holds. The planner's read isn't locked; each
 * draft reserves its day when it is placed.
 */
export function planMailbox(workspaceId: string, credentialId: string, a: { on: string; count: number; notBefore?: Date; now?: Date }): Promise<Date[]> {
  const now = a.now ?? new Date();
  return inWorkspace(workspaceId, async (tx) => {
    const mailbox = (await paceOf(tx, credentialId)) ?? { pace: DEFAULT_PACE, timeZone: await workspaceZone(tx, workspaceId) };
    const rows = await newestAround(tx, credentialId, a.on, "9999-12-31");
    const states = await actionStates(tx, rows.map((r) => r.actionId));
    const taken: Record<string, number> = {};
    for (const on of new Set(rows.map((r) => r.day))) taken[on] = countedOn(on, rows, states, now);
    return plan({ on: a.on, count: a.count, pace: mailbox.pace, timeZone: mailbox.timeZone, taken, ...(a.notBefore && { notBefore: a.notBefore }) });
  });
}

export type MailboxDay = { credentialId: string; name: string; day: string; counted: number; limit: number };

/** Each Mailbox's count against its limit on every day in [from, to] where it has emails, for the Calendar. */
export function mailboxDays(workspaceId: string, from: Date, to: Date, opts: { now?: Date } = {}): Promise<MailboxDay[]> {
  const now = opts.now ?? new Date();
  return inWorkspace(workspaceId, async (tx) => {
    const timeZone = await workspaceZone(tx, workspaceId);
    const [first, last] = [mailboxDay(from, timeZone), mailboxDay(to, timeZone)];
    const out: MailboxDay[] = [];
    for (const m of await mailboxesAround(tx, first, last)) {
      const rows = await newestAround(tx, m.credentialId, first, last);
      const states = await actionStates(tx, rows.map((r) => r.actionId));
      for (const on of [...new Set(rows.map((r) => r.day))].filter((d) => d >= first && d <= last).sort()) {
        const n = countedOn(on, rows, states, now);
        if (n) out.push({ credentialId: m.credentialId, name: m.name, day: on, counted: n, limit: m.pace.dailyLimit });
      }
    }
    return out;
  });
}

export type { MailboxPace };
