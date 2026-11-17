// SPDX-License-Identifier: AGPL-3.0-only
// What an External token may be allowed to use through the door (ADR 0032 rules 003 and 004). Names
// only: door-reads and door-proposals register what each does, and fail at startup on a name here
// with nothing registered. A personal reader can return a Person's name or address, so it starts off.

/** `read_needs_you` and `read_schedule` show Item titles, and an email's title is its subject line, which can name its Person. */
export const DOOR_READERS = {
  read_changes: { personal: false },
  read_needs_you: { personal: true },
  read_schedule: { personal: true },
  read_campaign: { personal: false },
} as const satisfies Record<string, { personal: boolean }>;
export type DoorReader = keyof typeof DOOR_READERS;

/** A `draft` has one target, a social post on the Calendar. */
export const DOOR_KINDS = ["fact_proposal", "draft"] as const;
export type DoorKind = (typeof DOOR_KINDS)[number];
