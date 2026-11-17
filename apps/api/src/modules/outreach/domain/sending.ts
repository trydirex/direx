// SPDX-License-Identifier: AGPL-3.0-only
// Pure: when a Mailbox's bounces mean it stops sending.

/** How many of a Mailbox's latest sends are read for the pause. */
export const PAUSE_WINDOW = 50;
const PAUSE_AT = 3;

/**
 * Whether a Mailbox's latest sends, up to 50 and none from before its last resume, have bounced too
 * much. Any permanent failure counts, a sender block included: it says more about the Mailbox than
 * about the Person.
 */
export const shouldPause = (lastSends: { bounced: boolean }[]): boolean => lastSends.filter((s) => s.bounced).length >= PAUSE_AT;
