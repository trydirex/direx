// SPDX-License-Identifier: AGPL-3.0-only
// Pure: the shape of a Strategy and a marketing plan. Every reason and target has a basis, so
// nothing can go unlabelled. application/body.ts validates these.

export type Basis =
  | { kind: "fact"; factId: string; version: number }
  | { kind: "source"; label: string; url?: string | undefined }
  | { kind: "assumption" }
  // A stored Measure reading from an earlier Campaign. Readings are append-only, so the id fixes the value.
  | { kind: "reading"; readingId: string };

export type Assumption = { text: string };

export type StrategyBody = {
  schemaVersion: 1;
  whoFor: string;
  personas: { name: string; notes?: string | undefined }[];
  positioning: string;
  channels: { key: string; label: string; timing: "now" | "later"; reason: string; basis: Basis }[];
  assumptions: Assumption[];
};

/** The fields a plan's template may use. The Campaign that sends it fills them per Person. */
export const TEMPLATE_FIELDS = ["firstName", "company", "senderName"] as const;

/** An email step's text, written with the plan so approving the plan approves the words. */
export type StepTemplate = { subject: string; text: string; citations: { factId: string; version: number }[] };

/** Where a Measure's number comes from. Direx counts the first four itself; it can't see `external`. */
export const MEASURE_SOURCES = ["replies", "interested_replies", "meetings", "deals", "external"] as const;
export type MeasureSource = (typeof MEASURE_SOURCES)[number];
export type Measure = { key: string; label: string; target: string; basis: Basis; source?: MeasureSource | undefined };
// Optional, so plans approved before sources existed keep their schemaVersion and read as external.
export const measureSource = (m: Pick<Measure, "source">): MeasureSource => m.source ?? "external";

export type PlanBody = {
  schemaVersion: 1;
  goal: string;
  audience: string;
  startsOn: string;
  endsOn: string;
  steps: { key: string; on: string; channelKey?: string | undefined; title: string; template?: StepTemplate | undefined }[];
  measures: Measure[];
  // No amount means no separate cost, such as "your existing plan".
  budget: { label: string; amountCents: number | null; currency: string; billedBy: "direx" | "your_account" }[];
  assumptions: Assumption[];
};
