// SPDX-License-Identifier: AGPL-3.0-only
// The reply a person is asked to judge, shown as plain text: it came from outside and is untrusted.
import { useQuery } from "@tanstack/react-query";
import { QueryBoundary } from "../components/QueryBoundary";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { ITEM_MESSAGES, replyQuery, type Reply } from "./actions";

export function ReplyReview(p: { workspaceId: string; signalId: string; initial?: Reply | undefined }) {
  const reply = useQuery({ ...replyQuery(p.workspaceId, p.signalId), initialData: p.initial });
  return (
    <QueryBoundary query={reply} skeleton={<Skeleton className="h-16 w-full" />} messages={ITEM_MESSAGES}>
      {(r) => (
        <>
          <p>From {r.senderEmail}</p>
          {r.text === null ? <p>Direx no longer keeps the text of this reply. It is still in the mailbox.</p> : <blockquote className="border-l-2 border-border pl-4 whitespace-pre-wrap">{r.text}</blockquote>}
        </>
      )}
    </QueryBoundary>
  );
}

/** A reply Item's content: the model's label and the words it rests on, and who owns the reply. */
export type ReplyContent = { signalId: string; label: string; quote: string | null; owner: { userIds: string[]; rule: "approver" | "mailbox" | "workspace_owners" } };

const LABELS: Record<string, string> = {
  interested: "Wants to talk",
  question: "Question",
  not_now: "Not now",
  referral: "Someone else",
  wrong_person: "Wrong person",
  no: "No",
  unlabelled: "Not sorted",
};
/** Who owns the reply and why, in one sentence. "You" and several names take the plural verb. */
export function ownerLine(names: string[], rule: ReplyContent["owner"]["rule"]): string {
  const plural = names.length > 1 || names[0] === "You";
  const who = names.join(", ");
  if (rule === "approver") return `${who} approved the email they replied to.`;
  if (rule === "mailbox") return `${who} ${plural ? "own" : "owns"} the Mailbox it came to. Nobody approved that email.`;
  return `${who} ${plural ? "are" : "is"} ${names.length > 1 ? "Owners" : "an Owner"} here. Nobody approved that email and the Mailbox is shared.`;
}

/**
 * The reply desk's view of one reply: the label orders the queue and is never the answer, so it shows with
 * the sender's own words behind it. The text itself is folded away and stays plain, untrusted text.
 */
export function ReplyItem(p: { workspaceId: string; content: ReplyContent; members: { userId: string; name: string; email: string }[] | undefined; meId: string | undefined; initial?: Reply | undefined }) {
  const { label, quote, owner } = p.content;
  const names = owner.userIds.flatMap((id) => {
    if (id === p.meId) return ["You"];
    const m = p.members?.find((x) => x.userId === id);
    return m ? [m.name || m.email] : [];
  });
  return (
    <>
      <p className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-border px-2 text-xs font-medium">{LABELS[label] ?? LABELS.unlabelled}</span>
        {label === "unlabelled" && <span className="text-sm text-muted-foreground">Direx didn't sort this one. Read it to see what it needs.</span>}
      </p>
      {quote && <blockquote className="border-l-2 border-border pl-4 whitespace-pre-wrap">{quote}</blockquote>}
      {names.length > 0 && <p className="text-sm">{ownerLine(names, owner.rule)}</p>}
      <details>
        <summary className="cursor-pointer text-sm">Their reply</summary>
        <ReplyReview workspaceId={p.workspaceId} signalId={p.content.signalId} initial={p.initial} />
      </details>
    </>
  );
}
