// SPDX-License-Identifier: AGPL-3.0-only
// The items module's only public entry point: every piece of work has one state, and every
// Action is created through its Item.
export type { Change, Changes } from "./application/changes";
export type { AppliedItem, Decided, EditOf, OnApplied } from "./application/decide";
export type { Appearance, AppearanceFor, ItemKind, RecipientFor, RecipientNotes, RuleApproval, TimelineEntry } from "./application/items";
export type { MoveStep } from "./application/move";
export type { ItemView } from "./application/view";
export type { VisibleState } from "./domain/state";
export { reasonLabel } from "./domain/reasons";
export { MAX_REASON_NOTE, REVIEW_REASONS, type ReasonGiven, type ReviewReason } from "./domain/rates";
export { blocking, EXEMPT_PROVENANCE, warn, WARNING_CODES, type Warning, type WarningCode } from "./domain/warnings";
export { itemRoutes, WarningShape } from "./routes";
export { createItems, KEYS_LOST_KIND, type Items } from "./application/create";
export { mailboxCapacity, routeCapacity, type CapacityPort, type CapacityResult, type PlaceTarget, type Placed } from "./application/capacity";
export { askResultWhy } from "./application/result-why";
export { lineProblems, resultWhy, type WhyResult } from "./definitions/result-why";
