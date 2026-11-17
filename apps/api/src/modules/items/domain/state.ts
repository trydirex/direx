// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the one Item state, shown with the same names everywhere. An Action's comes from
// its ledger state; claimed and dispatching are internal and show as Scheduled.

export type LedgerState =
  | "draft"
  | "needs_approval"
  | "scheduled"
  | "claimed"
  | "dispatching"
  | "sent"
  | "held"
  | "blocked"
  | "cancelled";

/** What a non-Action Item stores. It has no effect outside Direx, so it ends in Applied. */
export type OwnState = "draft" | "needs_approval" | "scheduled" | "applied" | "cancelled";

export type VisibleState = "draft" | "needs_approval" | "scheduled" | "sent" | "applied" | "held" | "blocked" | "cancelled";

const VISIBLE: Record<LedgerState, VisibleState> = {
  draft: "draft",
  needs_approval: "needs_approval",
  scheduled: "scheduled",
  claimed: "scheduled",
  dispatching: "scheduled",
  sent: "sent",
  held: "held",
  blocked: "blocked",
  cancelled: "cancelled",
};

export const visibleState = (s: LedgerState | OwnState): VisibleState => (s === "applied" ? "applied" : VISIBLE[s]);

/** Details written for an older draft than the Action now holds no longer describe it. */
export const detailsStale = (describedDraftVersion: number, draftVersion: number) => describedDraftVersion !== draftVersion;

/** Clean Items can be approved in bulk: no warnings, and the warnings describe this draft. */
export const isClean = (warnings: readonly unknown[], stale = false) => !stale && warnings.length === 0;

/**
 * An Item can move until its effect may have begun. An unknown outcome may already have
 * happened, so moving it could send twice.
 */
export function canMove(state: LedgerState | OwnState, holdReason: string | null): boolean {
  if (state === "held") return holdReason !== "outcome_unknown";
  return state === "draft" || state === "needs_approval" || state === "scheduled" || state === "claimed";
}
