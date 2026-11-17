// SPDX-License-Identifier: AGPL-3.0-only
// Reading replies. A full read lists the last 7 days of inbox mail not sent by us; it
// runs on the first poll, once a day, and when Gmail has forgotten the stored history
// id. In between, Gmail's history says what was added to the inbox since the marker.
// A read is complete or it fails: the cursor only moves past mail that was read, and
// the host drops events it has already handed off, so overlapping reads are harmless.
// ponytail: a full read fetches every message of the week again; add a seen-id check
// through the host if Gmail quota ever matters.
import type { SkipMail, TriggerData, TriggerEvent } from "@direx/plugin-sdk";
import { dsnRecipients, failedRecipients, isBounce, MAX_DECODE_BYTES, TEXT_CHARS, type Dsn } from "../mail/inbound";
import { headerOf, type GmailClient, type GmailMessage, type MessagePart } from "./client";
import { checkIds } from "./placement";

export { isBounce, MAX_DECODE_BYTES, TEXT_CHARS };
export const FULL_READ_EVERY_MS = 24 * 60 * 60 * 1000;
export const MAX_PAGES = 40;
const NOT_REPLIES = new Set(["SENT", "DRAFT", "SPAM", "TRASH"]);
const FULL_READ_QUERY = "in:inbox -from:me newer_than:7d";

type Cursor = { historyId: string; fullReadAt: number };

function parseCursor(raw: string | null): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<Cursor>;
    return typeof c.historyId === "string" && c.historyId && typeof c.fullReadAt === "number" ? (c as Cursor) : null;
  } catch {
    return null;
  }
}

export async function pollMailbox(
  client: GmailClient,
  token: string,
  rawCursor: string | null,
  now: number,
  skip: readonly SkipMail[] = [],
): Promise<{ events: TriggerEvent[]; cursor: string }> {
  const c = parseCursor(rawCursor);
  if (c && now - c.fullReadAt < FULL_READ_EVERY_MS) {
    const changed = await historyRead(client, token, c.historyId, skip, now);
    if (changed) return { events: changed.events, cursor: JSON.stringify({ historyId: changed.marker, fullReadAt: c.fullReadAt }) };
  }
  // The marker is taken first, so mail arriving during the read comes in the next history read.
  const marker = (await client.profile(token))?.historyId;
  if (!marker) throw new Error("Gmail's profile has no history id");
  const events = await fullRead(client, token, FULL_READ_QUERY, skip, now);
  return { events, cursor: JSON.stringify({ historyId: String(marker), fullReadAt: now }) };
}

async function historyRead(client: GmailClient, token: string, start: string, skip: readonly SkipMail[], now: number) {
  const wanted: string[] = [];
  let marker: string | undefined;
  let pageToken: string | undefined;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new Error(`Gmail history has more than ${MAX_PAGES} pages; refusing a partial read`);
    const data = await client.history(token, start, pageToken);
    if (data === null) return null; // Gmail no longer has the marker
    if (page === 1) {
      if (!data.historyId) throw new Error("Gmail's first history page has no history id");
      marker = String(data.historyId);
    }
    for (const r of data.history ?? []) {
      for (const e of r.messagesAdded ?? []) if (e.message?.id) wanted.push(e.message.id);
      for (const e of r.labelsAdded ?? []) {
        if (e.message?.id && e.labelIds?.includes("INBOX")) wanted.push(e.message.id);
      }
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  const events: TriggerEvent[] = [];
  // Expected Placement checks are found by search and never fetched.
  const done = wanted.length && skip.length ? await checkIds(client, token, skip, now) : new Set<string>();
  for (const id of wanted) {
    if (done.has(id)) continue;
    done.add(id);
    const m = await client.message(token, id, "full");
    if (!m) continue; // deleted since
    const labels = new Set(m.labelIds ?? []);
    if ([...labels].some((l) => NOT_REPLIES.has(l)) || !labels.has("INBOX")) continue;
    events.push(toEvent(m));
  }
  return { events, marker: marker! };
}

/** The last week of mail from one address, for someone just added as a Person. Same limits as a full read. */
export function messagesFrom(client: GmailClient, token: string, email: string, skip: readonly SkipMail[] = [], now = Date.now()): Promise<TriggerEvent[]> {
  return fullRead(client, token, `from:${email} newer_than:7d -in:sent -in:drafts`, skip, now);
}

async function fullRead(client: GmailClient, token: string, q: string, skip: readonly SkipMail[], now: number): Promise<TriggerEvent[]> {
  const events: TriggerEvent[] = [];
  // Expected Placement checks are found by search and never fetched.
  const seen = skip.length ? await checkIds(client, token, skip, now) : new Set<string>();
  let pageToken: string | undefined;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new Error(`the inbox has more than ${MAX_PAGES} pages; refusing a partial read`);
    const listing = await client.list(token, { q, maxResults: 500, pageToken });
    for (const stub of listing?.messages ?? []) {
      if (seen.has(stub.id)) continue;
      seen.add(stub.id);
      const m = await client.message(token, stub.id, "full");
      if (!m || (m.labelIds ?? []).some((l) => NOT_REPLIES.has(l))) continue;
      events.push(toEvent(m));
    }
    if (!listing?.nextPageToken) return events;
    pageToken = listing.nextPageToken;
  }
}

function deliveryStatusPart(p: MessagePart | undefined): MessagePart | undefined {
  if (!p) return undefined;
  if (p.mimeType?.toLowerCase() === "message/delivery-status") return p;
  for (const child of p.parts ?? []) {
    const found = deliveryStatusPart(child);
    if (found) return found;
  }
  return undefined;
}

/** Who a delivery notice says failed. Gmail may hand the status part over as text or as child parts. */
function dsnOf(m: GmailMessage): Dsn | null {
  const part = deliveryStatusPart(m.payload);
  if (part) {
    const fromChildren = (part.parts ?? []).map((c) => (c.headers ?? []).map((x) => `${x.name}: ${x.value}`).join("\n")).join("\n\n");
    const recipients = dsnRecipients(`${decode(part)}\n\n${fromChildren}`);
    if (recipients.length) return { recipients };
  }
  const failed = headerOf(m, "X-Failed-Recipients");
  return failed ? { recipients: failedRecipients(failed) } : null;
}

/** One inbox message, as the catalogue's email.received entry describes it. */
export function toEvent(m: GmailMessage): { eventId: string; data: TriggerData<"email.received"> } {
  const h = (name: string) => headerOf(m, name) ?? "";
  const headers = {
    from: h("From"),
    to: h("To"),
    cc: h("Cc"),
    subject: h("Subject"),
    date: h("Date"),
    messageId: h("Message-ID"),
    inReplyTo: h("In-Reply-To"),
    references: h("References"),
    // The topmost one, which Gmail's receiving server writes: Placement reports are counted only on its DKIM pass.
    authenticationResults: h("Authentication-Results"),
  };
  return {
    eventId: m.id,
    data: {
      kind: "message",
      gmailId: m.id,
      threadId: m.threadId ?? "",
      labelIds: m.labelIds ?? [],
      bounce: isBounce(headers.from, headers.subject),
      autoSubmitted: h("Auto-Submitted") || (h("X-Autoreply") ? "auto-replied" : ""),
      dsn: dsnOf(m),
      headers,
      text: textOf(m),
    },
  };
}

function decode(p: MessagePart): string {
  const data = p.body?.data;
  if (!data) return "";
  const bytes = Buffer.from(data, "base64url").subarray(0, MAX_DECODE_BYTES);
  const charset = /charset="?([^";\s]+)"?/i.exec(headerOf(p, "Content-Type") ?? "")?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // An unknown or odd charset label never costs the text.
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function firstPart(p: MessagePart | undefined, type: string): MessagePart | undefined {
  if (!p) return undefined;
  if (p.mimeType?.toLowerCase().startsWith(type) && !p.body?.attachmentId) return p;
  for (const child of p.parts ?? []) {
    const found = firstPart(child, type);
    if (found) return found;
  }
  return undefined;
}

/** The first text/plain part, else the HTML with tags stripped, else Gmail's snippet. */
export function textOf(m: GmailMessage): string {
  const plain = firstPart(m.payload, "text/plain");
  if (plain) return decode(plain).slice(0, TEXT_CHARS);
  const html = firstPart(m.payload, "text/html");
  if (html) {
    // ponytail: a tag strip, not an HTML parser; enough for classifying a reply.
    const text = decode(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return text.slice(0, TEXT_CHARS);
  }
  return (m.snippet ?? "").slice(0, TEXT_CHARS);
}
