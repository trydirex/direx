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
