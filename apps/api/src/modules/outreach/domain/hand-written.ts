// SPDX-License-Identifier: AGPL-3.0-only
// Pure: whether a message in the founder's Sent mail was written to someone by hand. Only those say
// "we're talking"; the founder's own cold and bulk sends would otherwise hold their whole list.

/** More recipients than this reads as an announcement, not a conversation. */
export const MAX_RECIPIENTS = 10;
const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);

export type SentHeaders = {
  messageId: string;
  recipients: readonly string[];
  xDirexAction: string | null;
  listUnsubscribe: string | null;
  precedence: string | null;
};

export function isHandWritten(m: SentHeaders, sentByDirex: ReadonlySet<string>): boolean {
  return (
    !m.xDirexAction &&
    !sentByDirex.has(m.messageId) &&
    !m.listUnsubscribe &&
    !BULK_PRECEDENCE.has((m.precedence ?? "").trim().toLowerCase()) &&
    m.recipients.length > 0 &&
    m.recipients.length <= MAX_RECIPIENTS
  );
}
