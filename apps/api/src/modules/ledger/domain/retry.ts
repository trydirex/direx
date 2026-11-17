// SPDX-License-Identifier: AGPL-3.0-only
// Retries per Action: 3, at 1, 5 and 25 minutes by default. One counter covers
// resends, reconciles and retryable refusals.

const DELAYS_MS = [1, 5, 25].map((m) => m * 60_000);
export const MAX_RETRIES = DELAYS_MS.length;

/** When the next retry runs, or null when the Action has used all its retries. */
export function nextRetryAt(retriesSoFar: number, now: Date): Date | null {
  const delay = DELAYS_MS[retriesSoFar];
  return delay === undefined ? null : new Date(now.getTime() + delay);
}
