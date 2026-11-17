// SPDX-License-Identifier: AGPL-3.0-only
// Pure: which work an approval makes possible, what the card says, and what it is bound to. A Next
// step names work a person starts by accepting it; nothing here starts anything.

export const NEXT_STEP_KIND = "next_step";

/**
 * Drafting each step's text once its plan is approved, making a step's drafts once its template is
 * saved, or drafting a per-Person follow-up shortly before it is due.
 */
export type NextStep =
  | { link: "plan_to_templates"; campaignId: string; planId: string; planVersion: number; stepKeys: string[] }
  | { link: "template_to_drafts"; campaignId: string; stepKey: string; templateRevision: number }
  | { link: "due_to_drafts"; campaignId: string; stepKey: string };

/** Links whose start writes drafts timed in the accepting person's zone, which they choose on accepting. */
export const needsTimeZone = (s: NextStep): boolean => s.link !== "plan_to_templates";

/** Only one live Next step per link and target, so a newer one replaces the older. */
export const targetOf = (s: NextStep): string => (s.link === "plan_to_templates" ? `${s.link}:${s.campaignId}` : `${s.link}:${s.campaignId}:${s.stepKey}`);

export function titleOf(s: NextStep, names: { campaign: string; step?: string; people?: number }): string {
  if (s.link === "plan_to_templates") {
    const n = s.stepKeys.length;
    return `Draft the text for ${n} ${n === 1 ? "step" : "steps"} in ${names.campaign}`;
  }
  const n = names.people ?? 0;
  if (s.link === "due_to_drafts") return `Draft follow-ups for ${names.step ?? s.stepKey} in ${names.campaign}: ${n} ${n === 1 ? "Person" : "People"}`;
  return `Make drafts for ${names.step ?? s.stepKey} in ${names.campaign}: ${n} ${n === 1 ? "Person" : "People"}`;
}

/** A post-only card belongs with social work; anything with an email belongs with outreach. */
export const workAreaOf = (stepTypes: readonly string[]): "social" | "outreach" => (stepTypes.length > 0 && stepTypes.every((t) => t === "post") ? "social" : "outreach");

/** An IANA zone the runtime knows, such as "Europe/London". */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
