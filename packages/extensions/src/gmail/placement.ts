// SPDX-License-Identifier: AGPL-3.0-only
// Placement checks on the receiving side. A check is found only by Gmail's own search, by its sender,
// the subject text it must carry and its send window, so nothing of it is fetched to recognise it.
// A read then fetches its labels and Message-ID and nothing else: never the body, the snippet or the
// subject. Archiving takes INBOX off one message and nothing more, and never touches spam.
import { effectSchemas, type ExecuteResult, type QueryOutput, type SkipMail } from "@direx/plugin-sdk";
import { headerOf, type GmailClient } from "./client";

// Goes into a Gmail search, so nothing that could widen the search gets through.
const ADDRESS = /^[^\s"():{}<>]+@[^\s"():{}<>]+$/;
const MESSAGE_ID = /^<([^\s"():{}<>]+)>$/;
/** Gmail's tabs other than Primary. */
const OTHER_TABS = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS"];
/** All a read gets back: the id, the labels and the one header asked for. */
const READ_FIELDS = "id,labelIds,payload/headers";
/** How many search hits a poll leaves unread per expected check. */
export const CHECK_HITS = 10;

/** Quotes, backslashes and grouping characters would end or widen the search. */
function phrase(text: string): string {
  const clean = text.replace(/["\\{}()]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("a Placement check's subject text is empty");
  return `"${clean}"`;
}

/** Gmail's search for one expected check: its sender, its subject text, not the other kind's tag, and its window. */
export function checkQuery(m: SkipMail): string {
  if (!ADDRESS.test(m.from)) throw new Error("a Placement check's sender must be one email address");
  if (m.after > m.before) throw new Error("a Placement check's window ends before it starts");
  const not = m.notSubject ? [`-subject:${phrase(m.notSubject)}`] : [];
  return [`from:${m.from}`, `subject:${phrase(m.subject)}`, ...not, `after:${Math.floor(m.after / 1000)}`, `before:${Math.ceil(m.before / 1000)}`].join(" ");
}

/** Searches at once, to stay inside one poll's deadline. */
const PARALLEL = 8;

/** The Gmail ids of expected checks already in the Mailbox, which a poll must not fetch. A failed search fails the poll. */
export async function checkIds(client: GmailClient, token: string, skip: readonly SkipMail[], now: number): Promise<Set<string>> {
  const ids = new Set<string>();
  // A window still to come holds nothing yet.
  const due = skip.filter((m) => m.after <= now);
  for (let i = 0; i < due.length; i += PARALLEL) {
    const pages = await Promise.all(due.slice(i, i + PARALLEL).map((m) => client.list(token, { q: checkQuery(m), includeSpamTrash: true, maxResults: CHECK_HITS })));
    for (const h of pages.flatMap((p) => p?.messages ?? [])) ids.add(h.id);
  }
  return ids;
}

export type CheckRead = QueryOutput<"placement.read">;

/** Where one expected check landed, from its labels alone. A Gmail error throws, so it is never taken for "not found". */
export async function readCheck(client: GmailClient, token: string, m: SkipMail): Promise<CheckRead> {
  const hits = await client.list(token, { q: checkQuery(m), includeSpamTrash: true, maxResults: 1 });
  const id = hits?.messages?.[0]?.id;
  const got = id ? await client.message(token, id, "metadata", ["Message-ID"], READ_FIELDS) : null;
  if (!got) return { found: false };
  const labels = new Set(got.labelIds ?? []);
  return { found: true, messageId: headerOf(got, "Message-ID") ?? null, inbox: labels.has("INBOX"), spam: labels.has("SPAM"), otherTab: OTHER_TABS.some((l) => labels.has(l)) };
}

export const archiveSpec = effectSchemas("placement.archive").input;

/** Takes INBOX off the check with this Message-ID. Refused when it is in spam or gone; done when it is already out of the inbox. */
export async function archiveCheck(client: GmailClient, token: string, spec: unknown): Promise<ExecuteResult> {
  const s = archiveSpec.safeParse(spec);
  if (!s.success) return { kind: "refused", permanent: true, retryable: false, detail: "the approved spec is not a Placement check to archive" };
  let found: { id: string; labelIds?: string[] } | null;
  try {
    const hits = await client.list(token, { q: `rfc822msgid:${MESSAGE_ID.exec(s.data.messageId)![1]}`, includeSpamTrash: true, maxResults: 1 });
    const id = hits?.messages?.[0]?.id;
    found = id ? await client.message(token, id, "minimal", undefined, "id,labelIds") : null;
  } catch (e) {
    // Nothing was changed yet.
    return { kind: "refused", permanent: false, retryable: true, detail: (e as Error).message };
  }
  if (!found) return { kind: "refused", permanent: true, retryable: false, detail: "the check is no longer in this Mailbox" };
  const labels = found.labelIds ?? [];
  if (labels.includes("SPAM")) return { kind: "refused", permanent: true, retryable: false, detail: "the check is in spam, which is never moved" };
  if (!labels.includes("INBOX")) return { kind: "sent", providerRef: found.id };
  // Throws when the outcome is unknown; the Dispatcher then holds the Action.
  const after = await client.unlabel(token, found.id, ["INBOX"]);
  if (!after) return { kind: "refused", permanent: true, retryable: false, detail: "the check is no longer in this Mailbox" };
  return { kind: "sent", providerRef: found.id };
}
