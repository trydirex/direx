// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a connected account can do right now, and when to warn about it. Computed each time and
// never stored, so it can't drift from the scopes, the app or the network's description.

export type CanDo = "available" | "coming" | "needs_own_app" | "reconnect";

export function canDo(feature: { built: boolean; scopes: readonly string[]; needsOwnApp?: boolean }, granted: readonly string[], ownApp: boolean): CanDo {
  if (!feature.built) return "coming";
  if (feature.needsOwnApp && !ownApp) return "needs_own_app";
  return feature.scopes.every((s) => granted.includes(s)) ? "available" : "reconnect";
}

const DAY_MS = 24 * 60 * 60_000;
/** [DEFAULT] How many days before an ending warns, and when it turns urgent. */
export const WARN_DAYS = 14;
export const URGENT_DAYS = 3;

export function expiryWarning(endsAt: Date | null, now: Date): { level: "soon" | "urgent"; endsAt: Date } | null {
  if (!endsAt) return null;
  const days = (endsAt.getTime() - now.getTime()) / DAY_MS;
  if (days > WARN_DAYS) return null;
  return { level: days <= URGENT_DAYS ? "urgent" : "soon", endsAt };
}
