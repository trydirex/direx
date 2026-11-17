// SPDX-License-Identifier: AGPL-3.0-only
// Pure: no I/O, no clock. State names follow the product glossary. claimed and
// dispatching are internal and show as Scheduled; there is no Failed state.

export type State =
  | "draft"
  | "needs_approval"
  | "scheduled"
  | "claimed"
  | "dispatching"
  | "sent"
  | "held"
  | "blocked"
  | "cancelled";

/** Hold reasons the ledger itself sets. Checks passed in by other modules add their own. */
export type CoreHoldReason =
  | "outcome_unknown"
  | "provider_rejected"
  | "approval_invalid"
  | "approval_expired"
  | "snapshot_changed"
  | "rule_needs_review"
  | "keys_unavailable"
  | "late";

/** How far past its approved time an Action may still go out with no person choosing again [DEFAULT]. */
export const LATE_LIMIT_MS = 86_400_000;
/** Strictly more than the limit after the time it was approved for. */
export const isLate = (dueAt: Date, now: Date) => now.getTime() - dueAt.getTime() > LATE_LIMIT_MS;

export type CoreBlockReason = "provider_refused_permanently";

const NEXT: Record<State, readonly State[]> = {
  // draft -> draft: an edit before submission, recorded like any other change.
  draft: ["draft", "needs_approval", "cancelled"],
  needs_approval: ["needs_approval", "scheduled", "held", "cancelled"],
  // scheduled -> scheduled: the send time moved later and the approval stands.
  scheduled: ["scheduled", "needs_approval", "claimed", "held", "blocked", "cancelled"],
  // claimed -> scheduled: the dispatch check found its Mailbox's day already sent, so it goes later, still approved.
  claimed: ["needs_approval", "scheduled", "dispatching", "held", "blocked", "cancelled"],
  // The provider call may have begun: only its outcome may follow, never a cancel.
  dispatching: ["sent", "held", "blocked"],
  // held: the next retry is rescheduled, or handed to a person. claimed: a retry or
  // resend runs the dispatch check again. sent: a person or a reconcile confirmed an
  // unknown outcome. blocked: a reconcile found the provider never will, such as access removed (ADR 0025 rule 005).
  held: ["held", "needs_approval", "scheduled", "claimed", "sent", "blocked", "cancelled"],
  sent: [],
  blocked: [],
  cancelled: [],
};

export function canTransition(from: State, to: State): boolean {
  return NEXT[from].includes(to);
}

export function isFinal(state: State): boolean {
  return NEXT[state].length === 0;
}
