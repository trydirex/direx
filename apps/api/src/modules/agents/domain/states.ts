// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the run states and the moves between them. Failed is a run state, not an Item state.

export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "step_capped"
  | "cost_capped"
  | "refused"
  | "expired";

export type WaitReason = "daily_cap" | "budget_stop";

const NEXT: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "waiting", "cancelled", "refused", "expired", "timed_out"],
  // running -> queued is a reclaim or a planned re-enqueue.
  running: ["succeeded", "failed", "cancelled", "timed_out", "step_capped", "cost_capped", "queued", "waiting"],
  waiting: ["queued", "cancelled", "expired"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  step_capped: [],
  cost_capped: [],
  refused: [],
  expired: [],
};

export const canMove = (from: RunStatus, to: RunStatus): boolean => NEXT[from].includes(to);
export const hasEnded = (s: RunStatus): boolean => NEXT[s].length === 0;
/** Ended without finishing, so what it proposed is marked as from an incomplete run. */
export const isIncomplete = (s: RunStatus): boolean => hasEnded(s) && s !== "succeeded";
