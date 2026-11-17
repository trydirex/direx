// SPDX-License-Identifier: AGPL-3.0-only
// Reading over IMAP. Every folder opens read-only, so nothing here can mark, move or delete mail.
// UIDs only go up within one UIDVALIDITY, so a read can stop part way and carry on next time.
// ponytail: a new login per call, about one a minute per Mailbox; keep a connection per Mailbox if
// a real service throttles logins.
import { createHash } from "node:crypto";
import type { QueryOutput, TriggerData, TriggerEvent } from "@direx/plugin-sdk";
import { ImapFlow } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { dsnRecipients, failedRecipients, isBounce, MAX_DECODE_BYTES, TEXT_CHARS, type Dsn } from "../mail/inbound";
import { tlsOptions, type ConnectOptions, type Connection } from "./connection";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const SENT_NAMES = /^(.*[/.])?(sent|sent items|sent mail|sent messages)$/i;

async function withImap<T>(c: Connection, o: ConnectOptions, use: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: c.imapHost,
    port: c.imapPort,
    secure: true,
    auth: { user: c.username, pass: c.password },
    logger: false,
    connectionTimeout: o.timeoutMs,
    greetingTimeout: o.timeoutMs,
    socketTimeout: o.timeoutMs,
    ...tlsOptions(o),
  });
  // A connection error after the call has finished has nobody to report to.
  client.on("error", () => {});
  try {
    await client.connect();
    return await use(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function sentFolder(client: ImapFlow): Promise<string | null> {
  const folders = await client.list();
  return (folders.find((f) => f.specialUse === "\\Sent") ?? folders.find((f) => SENT_NAMES.test(f.path)))?.path ?? null;
}

/** Looks for the Action's message by its header. Null covers both "not there" and "no Sent folder". */
export function findSent(c: Connection, o: ConnectOptions, actionId: string): Promise<string | null> {
  return withImap(c, o, async (client) => {
    const folder = await sentFolder(client);
    if (!folder) return null;
    const lock = await client.getMailboxLock(folder, { readOnly: true });
    try {
      const uids = await client.search({ header: { "x-direx-action": actionId } }, { uid: true });
      if (!uids || !uids.length) return null;
      const m = await client.fetchOne(String(uids[0]), { envelope: true }, { uid: true });
      return (m && m.envelope?.messageId) || `uid:${uids[0]}`;
    } finally {
      lock.release();
    }
  });
}

export type ProbeRead = QueryOutput<"mailbox.probe_read">;
const HEADER_BYTES = 64 * 1024;
const PROBE_CHARS = 20_000;

/** The probe as it arrived, from the inbox or the junk folder, or nothing. The raw header block is
 * kept byte for byte, since the point is to see what the provider changed on the way. */
export function findProbe(c: Connection, o: ConnectOptions, actionId: string, subject?: string): Promise<ProbeRead> {
  return withImap(c, o, async (client) => {
    const junk = (await client.list()).find((f) => f.specialUse === "\\Junk")?.path;
    const folders = [{ path: "INBOX", folder: "inbox" as const }, ...(junk ? [{ path: junk, folder: "junk" as const }] : [])];
    for (const { path, folder } of folders) {
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        // Some servers (AgentMail, seen 2026-11-05) can't search by a header of ours, so the probe's
        // random subject finds it when given; either way the header is compared whole after parsing.
        const criteria = subject ? { subject } : { header: { "x-direx-action": actionId } };
        for (const uid of (await client.search(criteria, { uid: true })) || []) {
          const m = await client.fetchOne(String(uid), { source: { maxLength: MAX_DECODE_BYTES } }, { uid: true });
          if (!m || !m.source) continue;
          const parsed = await simpleParser(m.source);
          if (parsed.headers.get("x-direx-action") !== actionId) continue;
          const blank = m.source.indexOf("\r\n\r\n");
          return {
            found: true,
            folder,
            headers: m.source.subarray(0, Math.min(blank < 0 ? m.source.length : blank, HEADER_BYTES)).toString("utf8"),
            text: (parsed.text ?? "").slice(0, PROBE_CHARS),
            html: typeof parsed.html === "string" ? parsed.html.slice(0, PROBE_CHARS) : null,
          };
        }
      } finally {
        lock.release();
      }
    }
    return { found: false };
  });
}

/** Logs in and looks for the Sent folder. Throws a message naming what failed. */
export async function checkImap(c: Connection, o: ConnectOptions): Promise<{ hasSent: boolean }> {
  try {
    return await withImap(c, o, async (client) => ({ hasSent: !!(await sentFolder(client)) }));
  } catch (e) {
    const x = e as { authenticationFailed?: boolean; code?: string };
    throw new Error(x.authenticationFailed ? "IMAP: the mail server refused the password" : `IMAP: ${x.code ?? "connection failed"}`, { cause: undefined });
  }
}

const addresses = (a: ParsedMail["to"]) => (Array.isArray(a) ? a.map((x) => x.text).join(", ") : (a?.text ?? ""));

function dsnOf(m: ParsedMail): Dsn | null {
  const part = m.attachments.find((a) => a.contentType.toLowerCase() === "message/delivery-status");
  const recipients = part ? dsnRecipients(part.content.toString("utf8")) : [];
  if (recipients.length) return { recipients };
  const failed = m.headers.get("x-failed-recipients");
  return typeof failed === "string" ? { recipients: failedRecipients(failed) } : null;
}

function toEvent(m: ParsedMail, fallbackId: string): { eventId: string; data: TriggerData<"email.received"> } {
  const from = m.from?.text ?? "";
  const subject = m.subject ?? "";
  const messageId = m.messageId ?? "";
  const references = Array.isArray(m.references) ? m.references.join(" ") : (m.references ?? "");
  const auto = m.headers.get("auto-submitted");
  return {
    eventId: messageId ? createHash("sha256").update(messageId).digest("hex") : fallbackId,
    data: {
      kind: "message",
      bounce: isBounce(from, subject),
      autoSubmitted: typeof auto === "string" ? auto : (auto as { value?: string } | undefined)?.value || (m.headers.has("x-autoreply") ? "auto-replied" : ""),
      dsn: dsnOf(m),
      headers: { from, to: addresses(m.to), cc: addresses(m.cc), subject, date: m.date?.toISOString() ?? "", messageId, inReplyTo: m.inReplyTo ?? "", references },
      text: (m.text ?? "").slice(0, TEXT_CHARS),
    },
  };
}

async function read(client: ImapFlow, uids: number[], fromAddress: string, uidValidity: string): Promise<TriggerEvent[]> {
  const events: TriggerEvent[] = [];
  for (const uid of uids) {
    const found = await client.fetchOne(String(uid), { source: { maxLength: MAX_DECODE_BYTES } }, { uid: true });
    if (!found || !found.source) continue;
    const parsed = await simpleParser(found.source, { keepDeliveryStatus: true });
    const sender = parsed.from?.value[0]?.address?.toLowerCase();
    if (sender === fromAddress.toLowerCase()) continue;
    events.push(toEvent(parsed, `${uidValidity}:${uid}`));
  }
  return events;
}

type Cursor = { uidValidity: string; lastUid: number };

function parseCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<Cursor>;
    return typeof c.uidValidity === "string" && typeof c.lastUid === "number" ? (c as Cursor) : null;
  } catch {
    return null;
  }
}

/** New inbox mail since the cursor, oldest first and at most `limit`; the rest comes next time. */
export function pollInbox(c: Connection, o: ConnectOptions, rawCursor: string | null, now: number, limit: number): Promise<{ events: TriggerEvent[]; cursor: string }> {
  return withImap(c, o, async (client) => {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const box = client.mailbox;
      if (!box) throw new Error("IMAP: the inbox did not open");
      const uidValidity = String(box.uidValidity);
      const was = parseCursor(rawCursor);
      const carryOn = was?.uidValidity === uidValidity ? was : null;
      // "n:*" always includes the newest message, even one below n, so the filter is needed.
      const found = carryOn
        ? ((await client.search({ uid: `${carryOn.lastUid + 1}:*` }, { uid: true })) || []).filter((u) => u > carryOn.lastUid)
        : (await client.search({ since: new Date(now - WEEK_MS) }, { uid: true })) || [];
      const uids = [...found].sort((a, b) => a - b).slice(0, limit);
      const lastUid = uids.at(-1) ?? carryOn?.lastUid ?? Math.max(Number(box.uidNext) - 1, 0);
      return { events: await read(client, uids, c.fromAddress, uidValidity), cursor: JSON.stringify({ uidValidity, lastUid }) };
    } finally {
      lock.release();
    }
  });
}

/** The last week of inbox mail from one address, newest `limit` messages. */
export function messagesFrom(c: Connection, o: ConnectOptions, email: string, now: number, limit: number): Promise<TriggerEvent[]> {
  return withImap(c, o, async (client) => {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const uids = (await client.search({ from: email, since: new Date(now - WEEK_MS) }, { uid: true })) || [];
      return await read(client, [...uids].sort((a, b) => a - b).slice(-limit), c.fromAddress, String(client.mailbox && client.mailbox.uidValidity));
    } finally {
      lock.release();
    }
  });
}
