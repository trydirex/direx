// SPDX-License-Identifier: AGPL-3.0-only
// Pure: how many emails a new Mailbox may send a day. It starts low, grows a step after clean
// sending days, halves on a pause or a provider's refusal, and never passes the Mailbox's own daily
// limit. Every number is a guess the beta will replace: providers publish their sending limits, not
// the level at which a new account gets flagged, and that level is far lower.

/** [DEFAULT] Where a new Mailbox starts, and the least a halving leaves. */
export const RAMP_FLOOR = 20;
/** [DEFAULT] How much one step adds. */
export const RAMP_STEP = 10;
/** [DEFAULT] Clean days, with at least one email sent, before the ramp grows a step. */
export const RAMP_CLEAN_DAYS = 2;

const DAY_MS = 86_400_000;

/** Half, rounded down, never below the floor: what a pause or a provider's refusal leaves. */
export const halveRamp = (ramp: number) => Math.max(RAMP_FLOOR, Math.floor(ramp / 2));

export type RampState = { ramp: number; cleanSince: Date; dailyLimit: number; paused: boolean; sent: number; bounced: number };

/**
 * What the nightly sweep does to one Mailbox's ramp. A bounce since the clean days began restarts
 * them, unchanged; enough clean days with an email sent add a step, up to the daily limit; a paused
 * Mailbox, or one that sent nothing, waits.
 */
export function sweepRamp(s: RampState, now: Date): { ramp: number; restart: boolean } {
  if (s.paused || s.ramp >= s.dailyLimit) return { ramp: s.ramp, restart: false };
  if (s.bounced > 0) return { ramp: s.ramp, restart: true };
  const cleanDays = Math.floor((now.getTime() - s.cleanSince.getTime()) / DAY_MS);
  if (cleanDays < RAMP_CLEAN_DAYS || s.sent === 0) return { ramp: s.ramp, restart: false };
  return { ramp: Math.min(s.ramp + RAMP_STEP, s.dailyLimit), restart: true };
}
