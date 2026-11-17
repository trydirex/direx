// SPDX-License-Identifier: AGPL-3.0-only
// The schedule module's only public entry point: Touch reservations under the Person
// group lock, and the ledger check that holds a Touch without one.
export type { CapName, TouchClass } from "./domain/caps";
export { CAPS, CAPS_BY_CLASS } from "./domain/caps";
export { touchCheck } from "./application/check";
export { reserveTouch, type ReserveResult } from "./application/reserve";
export { lockMailboxDay, mailboxDayCheck, mailboxDays, nextMailboxTime, planMailbox, PROVIDER_CEILING, reserveMailbox, reserveMailboxIn, type MailboxDay, type MailboxReserveResult } from "./application/mailbox";
export { scheduleRoutes } from "./routes";
export { mailboxPace, setMailboxPace, setTimeZone, timeZoneOf } from "./application/settings";
export { DEFAULT_PACE, localTime, mailboxDay, nextDay, plan as planSends, type MailboxPace } from "./domain/mailbox";
export { direxTouchNear, recordOutsideTouch, type NewOutsideTouch, type OutsideTouchRow } from "./application/outside";
export { touchOf, type Touch } from "./application/touch";
