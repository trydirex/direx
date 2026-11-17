// SPDX-License-Identifier: AGPL-3.0-only
// Pure: when a stored access token is too close to expiry to hand out.

/** [DEFAULT] A token with less than this left is refreshed before use. */
export const REFRESH_WINDOW_MS = 5 * 60_000;

export const needsRefresh = (expiresAt: Date, now: Date) => expiresAt.getTime() - now.getTime() < REFRESH_WINDOW_MS;

/** [DEFAULT] A self-renewing token is renewed this early, since it may go unused for weeks. */
export const SELF_RENEW_WINDOW_MS = 7 * 24 * 60 * 60_000;

export const dueForRenewal = (selfRenews: boolean, expiresAt: Date, now: Date) =>
  selfRenews ? expiresAt.getTime() - now.getTime() < SELF_RENEW_WINDOW_MS : needsRefresh(expiresAt, now);

/** The date a warning should use: the grant can end before the token does. */
export const effectiveExpiry = (tokenExpiry: Date, grantExpiresAt: string | undefined) => {
  const grant = grantExpiresAt ? new Date(grantExpiresAt) : null;
  return grant && grant < tokenExpiry ? grant : tokenExpiry;
};
