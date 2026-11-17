// SPDX-License-Identifier: AGPL-3.0-only
import { listTime, STATE_LABEL, type ItemState } from "./actions";

/** The stamp an approved send gets: Scheduled and when it goes out, in the Scheduled slate, set a little askew. */
export function Postmark({ at }: { at: Date }) {
  const when = listTime(at);
  return (
    <span role="img" aria-label={`Scheduled, ${when}`} className="inline-flex shrink-0 -rotate-3 flex-col items-center rounded-sm border-2 border-double border-scheduled px-2 py-0.5 leading-tight text-scheduled">
      <span className="text-xs font-semibold tracking-widest uppercase">Scheduled</span>
      <span className="text-sm font-medium tabular-nums">{when}</span>
    </span>
  );
}

// A reason can be long ("Held: this Mailbox hasn't passed its unsubscribe check"), so the chip wraps inside its column.
const chip = "inline-flex max-w-full items-center gap-1.5 rounded-sm border px-2 py-0.5 text-left text-xs leading-tight font-medium";
/** Each state has its own colour: peach means "needs you", slate "scheduled", green "done". Red is never a state. */
export const STATE_STYLE: Record<ItemState, string> = {
  draft: "border-dashed border-faint text-muted-foreground",
  needs_approval: "border-transparent bg-peach text-peach-foreground",
  scheduled: "border-transparent bg-scheduled-tint text-scheduled",
  sent: "border-transparent bg-success-tint text-success",
  applied: "border-transparent bg-success-tint text-success",
  held: "border-transparent bg-muted text-foreground",
  blocked: "border-muted-foreground bg-muted-foreground text-primary-foreground",
  cancelled: "border-border text-muted-foreground",
};

/** A shape per state, so a state reads without colour too: a dot, a ring, a check, two bars, a diamond, a dash. */
const MARK: Record<ItemState, string> = {
  draft: "size-2 rounded-full border border-current",
  needs_approval: "size-2 rounded-full bg-current",
  scheduled: "size-2 rounded-full border-2 border-current",
  sent: "h-2 w-1 rotate-45 border-r-2 border-b-2 border-current",
  applied: "h-2 w-1 rotate-45 border-r-2 border-b-2 border-current",
  held: "h-2 w-1.5 border-x-2 border-current",
  blocked: "size-1.5 rotate-45 bg-current",
  cancelled: "h-0.5 w-2 bg-current",
};

/** The one Item state, the same everywhere. The name is always written, so colour is never the only signal. */
export function StateChip({ state, reason }: { state: ItemState; reason?: string | null }) {
  return (
    <span className={`${chip} ${STATE_STYLE[state]}`}>
      <span aria-hidden className={`shrink-0 ${MARK[state]}`} />
      <span>
        {STATE_LABEL[state]}
        {reason ? `: ${reason}` : ""}
      </span>
    </span>
  );
}

export type CampaignStatus = "ended" | "paused" | "draft" | "awaiting_signoff" | "scheduled" | "no_launch_date" | "running";
/** A Campaign's status in the Item chip's colours and shapes: peach when it waits on a person, green while it runs. */
const CAMPAIGN_LOOK: Record<CampaignStatus, [style: string, mark: string]> = {
  draft: [STATE_STYLE.draft, MARK.draft],
  awaiting_signoff: [STATE_STYLE.needs_approval, MARK.needs_approval],
  no_launch_date: [STATE_STYLE.needs_approval, MARK.needs_approval],
  scheduled: [STATE_STYLE.scheduled, MARK.scheduled],
  running: [STATE_STYLE.sent, "size-2 rounded-full bg-current"],
  paused: [STATE_STYLE.held, MARK.held],
  ended: [STATE_STYLE.cancelled, MARK.cancelled],
};

/** A Campaign's status, written out ("Starts 3 Dec") beside its shape, so it reads the same as an Item's state. */
export function CampaignChip({ status, label }: { status: CampaignStatus; label: string }) {
  const [style, mark] = CAMPAIGN_LOOK[status];
  return (
    <span className={`${chip} ${style}`}>
      <span aria-hidden className={`shrink-0 ${mark}`} />
      <span>{label}</span>
    </span>
  );
}

/** How many warnings an Item has, in amber words ("1 warning"); nothing when there are none. */
export function WarningCount({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="text-xs font-medium text-warning tabular-nums">{`${count} ${count === 1 ? "warning" : "warnings"}`}</span>;
}

/** A company's review state in Search, in the Item chip's look: peach while it waits for you, green once kept. */
const REVIEW_LOOK: Record<string, ItemState> = { new: "draft", in_review: "needs_approval", accepted: "sent", rejected: "cancelled" };
export function ReviewChip({ state, label }: { state: string; label: string }) {
  const look = REVIEW_LOOK[state] ?? "draft";
  return (
    <span className={`${chip} ${STATE_STYLE[look]}`}>
      <span aria-hidden className={`shrink-0 ${MARK[look]}`} />
      <span>{label}</span>
    </span>
  );
}
