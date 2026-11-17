// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the limits on runs, and what they decide. A day is a UTC calendar day.

export const LEASE_MS = 60_000;
export const LEASE_RENEW_MS = 20_000;
export const MAX_RECLAIMS = 1;
export const EXPIRE_AFTER_MS = 7 * 86_400_000;
export const RUN_COST_CAP_MICROS = 1_000_000n;

export type Caps = { agentConcurrent: number; workspaceConcurrent: number; agentDaily: number; workspaceDaily: number };
export const DEFAULT_CAPS: Caps = { agentConcurrent: 2, workspaceConcurrent: 5, agentDaily: 100, workspaceDaily: 300 };

export type Usage = { agentRunning: number; workspaceRunning: number; agentToday: number; workspaceToday: number };
export type Admission = "start" | "stay_queued" | "daily_cap";

/** A spent daily cap outranks a full slot: waiting for a slot can't help until the day turns. */
export function admit(u: Usage, c: Caps): Admission {
  if (u.agentToday >= c.agentDaily || u.workspaceToday >= c.workspaceDaily) return "daily_cap";
  if (u.agentRunning >= c.agentConcurrent || u.workspaceRunning >= c.workspaceConcurrent) return "stay_queued";
  return "start";
}

export const nextUtcDay = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));

const RETRYABLE = new Set(["transient_upstream", "provider_quota"]);
const DEFAULT_WAITS_MS = [30_000, 60_000];
/** A wait up to this long stays in the run. A longer one releases the claim. */
export const STAY_IN_RUN_MS = 10_000;

/** How long to wait before retrying, or null when this failure doesn't get another try. */
export function retryWait(family: string, retriesSoFar: number, at: Date, notBefore?: Date): number | null {
  if (!RETRYABLE.has(family) || retriesSoFar >= DEFAULT_WAITS_MS.length) return null;
  return notBefore ? Math.max(0, notBefore.getTime() - at.getTime()) : DEFAULT_WAITS_MS[retriesSoFar]!;
}
