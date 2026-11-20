// SPDX-License-Identifier: AGPL-3.0-only
// What a Strategy and a marketing plan must contain before they can be submitted.
import { z } from "zod";
import { MEASURE_SOURCES, TEMPLATE_FIELDS, type PlanBody, type StrategyBody } from "../domain/types";

const MAX_NOW_CHANNELS = 3;
const MAX_PLAN_DAYS = 45;
// The same limits as a Campaign step's template, which this text becomes.
const MAX_SUBJECT = 200;
const MAX_TEXT = 5000;
const MAX_CITATIONS = 40;
const DAY_MS = 86_400_000;

const words = z.string().trim().min(1).max(2000);
const key = z.string().regex(/^[a-z0-9_-]{1,64}$/);
const isoDate = z.iso.date();

const basis = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fact"), factId: z.uuid(), version: z.number().int().positive() }),
  // httpUrl, because this is shown as a link.
  z.strictObject({ kind: z.literal("source"), label: words, url: z.httpUrl().optional() }),
  z.strictObject({ kind: z.literal("assumption") }),
  z.strictObject({ kind: z.literal("reading"), readingId: z.uuid() }),
]);

const template = z.strictObject({
  subject: z.string().trim().min(1).max(MAX_SUBJECT),
  text: z.string().trim().min(1).max(MAX_TEXT),
  citations: z.array(z.strictObject({ factId: z.uuid(), version: z.number().int().positive() })).max(MAX_CITATIONS),
});
const FIELD = /\{\{\s*([^}]*?)\s*\}\}/g;
const unknownFields = (text: string) => [...text.matchAll(FIELD)].map((m) => m[1]!).filter((f) => !(TEMPLATE_FIELDS as readonly string[]).includes(f));

const assumptions = z.array(z.strictObject({ text: words })).max(20);

function refuseRepeats(items: { key: string }[], path: string, ctx: z.RefinementCtx) {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.key)) ctx.addIssue({ code: "custom", path: [path, i, "key"], message: "duplicate_key" });
    seen.add(item.key);
  });
}

export const strategyBody: z.ZodType<StrategyBody> = z
  .strictObject({
    schemaVersion: z.literal(1),
    whoFor: words,
    personas: z.array(z.strictObject({ name: words, notes: words.optional() })).max(5),
    positioning: words,
    channels: z.array(z.strictObject({ key, label: words, timing: z.enum(["now", "later"]), reason: words, basis })).max(20),
    assumptions,
  })
  .superRefine((b, ctx) => {
    refuseRepeats(b.channels, "channels", ctx);
    const now = b.channels.filter((c) => c.timing === "now").length;
    if (now < 1 || now > MAX_NOW_CHANNELS) ctx.addIssue({ code: "custom", path: ["channels"], message: "channels_now_out_of_range" });
  });

export const planBody: z.ZodType<PlanBody> = z
  .strictObject({
    schemaVersion: z.literal(1),
    goal: words,
    audience: words,
    startsOn: isoDate,
    endsOn: isoDate,
    steps: z.array(z.strictObject({ key, on: isoDate, channelKey: key.optional(), title: words, template: template.optional() })).max(60),
    measures: z.array(z.strictObject({ key, label: words, target: words, basis, source: z.enum(MEASURE_SOURCES).optional() })).max(10),
    budget: z
      .array(
        z.strictObject({
          label: words,
          amountCents: z.number().int().nonnegative().nullable(),
          currency: z.string().regex(/^[A-Z]{3}$/),
          billedBy: z.enum(["direx", "your_account"]),
        }),
      )
      .max(20),
    assumptions,
  })
  .superRefine((b, ctx) => {
    refuseRepeats(b.steps, "steps", ctx);
    refuseRepeats(b.measures, "measures", ctx);
    // ISO dates of one shape compare correctly as strings.
    if (b.endsOn < b.startsOn || Date.parse(b.endsOn) - Date.parse(b.startsOn) > MAX_PLAN_DAYS * DAY_MS) {
      ctx.addIssue({ code: "custom", path: ["endsOn"], message: "plan_dates_out_of_range" });
    }
    b.steps.forEach((s, i) => {
      if (s.on < b.startsOn || s.on > b.endsOn) ctx.addIssue({ code: "custom", path: ["steps", i, "on"], message: "step_outside_plan" });
      if (!s.template) return;
      // A template goes out on a channel, so a step on none has nothing to send it.
      if (!s.channelKey) ctx.addIssue({ code: "custom", path: ["steps", i, "template"], message: "template_without_channel" });
      if (unknownFields(`${s.template.subject} ${s.template.text}`).length) ctx.addIssue({ code: "custom", path: ["steps", i, "template"], message: "unknown_merge_field" });
    });
  });

/** What still stops a draft being submitted, as a path and a reason. Empty means it can go. */
export function whatsMissing(schema: z.ZodType, draft: unknown): { path: string; message: string }[] {
  const parsed = schema.safeParse(draft);
  return parsed.success ? [] : parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
