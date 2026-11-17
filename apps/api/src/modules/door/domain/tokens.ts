// SPDX-License-Identifier: AGPL-3.0-only
// An External token's life and who it speaks for (ADR 0032 rule 005), in pure code. Making and
// hashing a token needs randomness, so that lives in application/tokens.ts.
import type { DoorKind, DoorReader } from "./catalogue";

const BASE_DAYS = [7, 30, 90] as const;
const LONGER_DAYS = [180, 365] as const;
const MAX_VAR = "DIREX_EXTERNAL_TOKEN_MAX_DAYS";

/** The lifetimes offered, in days; 180 and 365 only where a self-hosted operator allows that many. */
export const lifetimeChoices = (maxDays: number | null): number[] => [...BASE_DAYS, ...LONGER_DAYS.filter((d) => maxDays !== null && d <= maxDays)];

/** Read once at start. Cloud tokens never live past 90 days, so the variable there is a mistake. */
export function maxDaysFromEnv(raw: string | undefined, onCloud: boolean): number | null {
  if (!raw) return null;
  if (onCloud) throw new Error(`${MAX_VAR} is for a self-hosted Direx only; unset it on cloud`);
  const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(days >= 91 && days <= 365)) throw new Error(`${MAX_VAR} must be a whole number of days from 91 to 365, not ${raw}`);
  return days;
}

/** Who is calling with a live token. No user, role or sign-in time, so it can't pass for a Member or an approver. */
export type TokenCaller = {
  tokenId: string;
  workspaceId: string;
  name: string;
  readers: readonly DoorReader[];
  kinds: readonly DoorKind[];
};
