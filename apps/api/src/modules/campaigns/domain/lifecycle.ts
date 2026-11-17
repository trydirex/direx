// SPDX-License-Identifier: AGPL-3.0-only
// ADR 0023 rule 003: where a Campaign is, derived on every read and never stored. Days are YYYY-MM-DD in the
// Workspace time zone.

export const STATUSES = ["ended", "paused", "draft", "awaiting_signoff", "scheduled", "no_launch_date", "running"] as const;
export type CampaignStatus = (typeof STATUSES)[number];

export type LifecycleInput = {
  endsOn: string | null;
  paused: boolean;
  /** Some version of the plan was approved once. */
  approved: boolean;
  /** A version waits for sign-off. */
  waiting: boolean;
  launchOn: string | null;
};

/**
 * First match wins: Ended, Paused, Draft, Awaiting sign-off, Scheduled, No launch date, Running. A version
 * waiting while an approved one runs is the separate `changesWaiting` marker, never a status.
 */
export function lifecycle(c: LifecycleInput, today: string): { status: CampaignStatus; changesWaiting: boolean } {
  const changesWaiting = c.approved && c.waiting;
  const status: CampaignStatus =
    c.endsOn && today > c.endsOn ? "ended" : c.paused ? "paused" : !c.approved ? (c.waiting ? "awaiting_signoff" : "draft") : !c.launchOn ? "no_launch_date" : today < c.launchOn ? "scheduled" : "running";
  return { status, changesWaiting };
}
