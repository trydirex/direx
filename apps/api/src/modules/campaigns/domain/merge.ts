// SPDX-License-Identifier: AGPL-3.0-only
// Merge fields in a template. A value goes in once and is never read as a field itself, so a hostile
// CSV value can't pull in another one.

export const MERGE_FIELDS = ["firstName", "company", "senderName"] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export type MergeValues = Partial<Record<MergeField, string | null>>;

/** The URL of another step's output, by that step's key, written like {{steps.launch-page.url}}. */
export type StepUrls = Readonly<Record<string, string>>;

const FIELD = /\{\{\s*([\w.-]+)\s*\}\}/g;
const STEP_FIELD = /^steps\.([a-z0-9_-]{1,64})\.url$/;
const known = (name: string): name is MergeField => (MERGE_FIELDS as readonly string[]).includes(name);
const stepOf = (name: string): string | null => STEP_FIELD.exec(name)?.[1] ?? null;

export const fieldsIn = (text: string): string[] => [...new Set([...text.matchAll(FIELD)].map((m) => m[1]!))];

/** The step keys whose output this text asks for. */
export const stepFields = (text: string): string[] => fieldsIn(text).map(stepOf).filter((k): k is string => k !== null);

/** Fields that are neither a Person field nor the output of a step in `allowedSteps`. */
export const unknownFields = (text: string, allowedSteps: readonly string[] = []): string[] =>
  fieldsIn(text).filter((f) => !known(f) && !allowedSteps.includes(stepOf(f) ?? ""));

const valueOf = (name: string, values: MergeValues, steps: StepUrls): string | null | undefined => {
  if (known(name)) return values[name];
  const step = stepOf(name);
  return step !== null && Object.hasOwn(steps, step) ? steps[step] : undefined;
};

/** The fields this text needs that this Person has no value for, unknown fields included. */
export const missingFields = (text: string, values: MergeValues, steps: StepUrls = {}): string[] => fieldsIn(text).filter((f) => !valueOf(f, values, steps));

export function merge(text: string, values: MergeValues, steps: StepUrls = {}): { ok: true; text: string } | { ok: false; missing: string[] } {
  const missing = missingFields(text, values, steps);
  if (missing.length) return { ok: false, missing };
  return { ok: true, text: text.replace(FIELD, (_, name: string) => valueOf(name, values, steps)!) };
}
