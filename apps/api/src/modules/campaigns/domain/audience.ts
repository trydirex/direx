// SPDX-License-Identifier: AGPL-3.0-only
// Who gets a draft, and the stated reason for anyone who doesn't. Eligibility is checked here as well
// as at dispatch, so no draft or run is spent on someone the floor would hold.

export type PersonStatus = "active" | "replied" | "removed" | "conflict";
export type AudiencePerson = { status: PersonStatus; replied: boolean; mergeFieldsMissing: string[]; eligibilityMissing: string[] };
export type AudienceStep = { audience: "everyone" | "no_reply_yet" };
export type LeftOut = { reason: "replied" | "removed" | "conflict" } | { reason: "missing_merge_field" | "not_eligible"; fields: string[] };

export function leftOut(person: AudiencePerson, step: AudienceStep): LeftOut | null {
  if (person.status !== "active") return { reason: person.status };
  if (step.audience === "no_reply_yet" && person.replied) return { reason: "replied" };
  if (person.eligibilityMissing.length) return { reason: "not_eligible", fields: person.eligibilityMissing };
  return person.mergeFieldsMissing.length ? { reason: "missing_merge_field", fields: person.mergeFieldsMissing } : null;
}
