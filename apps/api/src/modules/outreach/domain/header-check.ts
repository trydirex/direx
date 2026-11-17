// SPDX-License-Identifier: AGPL-3.0-only
// Pure: whether a Mailbox's provider delivered the probe's opt-out as Direx sent it. A provider that
// swaps the unsubscribe link sends a recipient's one-click somewhere Direx never hears about, so
// anything short of an exact match means the Mailbox can't send cold or marketing email.

export const FAILURES = ["unsubscribe_link_replaced", "unsubscribe_header_added", "one_click_missing", "not_signed", "footer_changed"] as const;
export type Failure = (typeof FAILURES)[number];
export const CHECK_WARNINGS = ["message_id_replaced", "text_added"] as const;
export type CheckWarning = (typeof CHECK_WARNINGS)[number];

/** What went out. `messageId` is how the Message-ID Direx set begins, since the domain after @ varies by provider. */
export type Sent = { unsubscribeUrl: string | null; text: string; footer: string; messageId?: string | undefined };
export type Received = { headers: string; text: string; html: string | null };
export type Verdict = { state: "passed" | "replies_only"; failures: Failure[]; warnings: CheckWarning[] };

/** Every value of every header, names lowercased, folded lines joined. */
function headerValues(raw: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of raw.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ").split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    out.set(name, [...(out.get(name) ?? []), line.slice(at + 1).trim()]);
  }
  return out;
}

/** The header names a DKIM signature covers, from its `h=` tag. */
const signedNames = (signature: string): string[] =>
  /(?:^|;)\s*h\s*=\s*([^;]*)/i
    .exec(signature)?.[1]
    ?.split(":")
    .map((n) => n.replace(/\s+/g, "").toLowerCase()) ?? [];

const flat = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();

const ENTITIES: Record<string, string> = { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", nbsp: " " };
/** The text a person sees in an HTML part, close enough to look for one line and one link in it. */
const htmlText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) =>
      e.startsWith("#") ? String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
    )
    .replace(/\s+/g, " ");

export function compareProbe(sent: Sent, got: Received): Verdict {
  const h = headerValues(got.headers);
  const failures: Failure[] = [];
  const lists = h.get("list-unsubscribe") ?? [];
  if (sent.unsubscribeUrl) {
    const uris = lists.flatMap((v) => [...v.matchAll(/<([^>]*)>/g)].map((m) => m[1]!.trim()));
    if (lists.length !== 1 || uris.length !== 1 || uris[0] !== sent.unsubscribeUrl) failures.push("unsubscribe_link_replaced");
    const post = h.get("list-unsubscribe-post") ?? [];
    if (post.length !== 1 || post[0] !== "List-Unsubscribe=One-Click") failures.push("one_click_missing");
    const covered = (h.get("dkim-signature") ?? []).some((sig) => {
      const names = signedNames(sig);
      return names.includes("list-unsubscribe") && names.includes("list-unsubscribe-post");
    });
    if (!covered) failures.push("not_signed");
  } else if (lists.length) {
    failures.push("unsubscribe_header_added");
  }

  const text = flat(got.text);
  const footer = flat(sent.footer);
  const lines = footer.split("\n");
  const html = got.html === null ? null : htmlText(got.html);
  const htmlKeeps = html === null || lines.slice(-(sent.unsubscribeUrl ? 2 : 1)).every((l) => html.includes(l.replace(/\s+/g, " ")));
  if (!text.includes(footer) || !htmlKeeps) failures.push("footer_changed");

  const warnings: CheckWarning[] = [];
  const messageId = h.get("message-id")?.[0];
  if (sent.messageId && !messageId?.startsWith(sent.messageId)) warnings.push("message_id_replaced");
  if (text !== flat(sent.text)) warnings.push("text_added");
  return { state: failures.length ? "replies_only" : "passed", failures, warnings };
}
