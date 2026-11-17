// SPDX-License-Identifier: AGPL-3.0-only
// Pure: a Campaign's steps follow one launch. Each step keeps its distance from the launch, decisions
// are due early enough that the launch doesn't slip, and a step waiting on an output that never comes
// turns into a choice.
import { localTime } from "./slots";
import { addDays } from "./timing";

/** Days after a step's date with no output before a person is asked what to do. */
export const STALL_DAYS = 3;
/** Working days a person is given to approve before a step's first send. */
export const APPROVE_LEAD_DAYS = 1;

export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const isWeekend = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());

/**
 * A step's date: the launch plus the step's distance from the plan's start. With an output anchor,
 * the later of that and the output's date plus the same distance, so an early output never pulls a
 * step ahead of the date a person planned.
 */
export function stepDate(a: { planStartsOn: string; stepOn: string; anchorOn: string; outputOn?: string | null }): string {
  const offset = daysBetween(a.planStartsOn, a.stepOn);
  const planned = addDays(a.anchorOn, offset);
  if (!a.outputOn) return planned;
  const fromOutput = addDays(a.outputOn, offset);
  return fromOutput > planned ? fromOutput : planned;
}

/**
 * When a step's decision is due: a working day before its first send, less the days drafting takes
 * for per-Person drafts not written yet. Kept at the first send's local time of day.
 */
export function decideBy(a: { firstSlot: Date; draftingDays: number; timeZone: string }): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: a.timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(a.firstSlot);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  let day = `${part("year")}-${part("month")}-${part("day")}`;
  for (let left = APPROVE_LEAD_DAYS; left > 0; ) {
    day = addDays(day, -1);
    if (!isWeekend(day)) left--;
  }
  day = addDays(day, -a.draftingDays);
  return localTime(day, Number(part("hour")) * 60 + Number(part("minute")) + Number(part("second")) / 60, a.timeZone);
}

/** Each plan step with its date following the Campaign's launch. With no launch set, the plan's own dates. */
export function datedSteps<S extends { on: string }>(plan: { startsOn: string; steps: readonly S[] }, anchorOn: string | null, outputOn?: string | null): S[] {
  const anchor = anchorOn ?? plan.startsOn;
  return plan.steps.map((s) => ({ ...s, on: stepDate({ planStartsOn: plan.startsOn, stepOn: s.on, anchorOn: anchor, outputOn }) }));
}

const nextWeekday = (day: string) => {
  let d = day;
  while (isWeekend(d)) d = addDays(d, 1);
  return d;
};

/**
 * A planned time moved by whole days, keeping its local time of day in the zone. A time that lands on
 * a weekend goes to the Monday after, as a new draft's slot would.
 */
export function shiftAt(at: Date, days: number, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  const day = nextWeekday(addDays(`${part("year")}-${part("month")}-${part("day")}`, days));
  return localTime(day, Number(part("hour")) * 60 + Number(part("minute")) + Number(part("second")) / 60, timeZone);
}

/** A date as a person reads it in a notice, such as "Tue 10 Nov". */
export const dayWords = (day: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(`${day}T00:00:00Z`));

/** What the move notice says: the old and new dates, and what happened to Items already approved. */
export function launchMovedTitle(a: { from: string; to: string; kept: number; backToApproval: number; overCap: number; approvers?: readonly string[] }): string {
  const parts = [];
  const by = a.approvers?.length ? ` (approved by ${a.approvers.join(", ")})` : "";
  if (a.kept) parts.push(`${a.kept} approved ${a.kept === 1 ? "Item goes" : "Items go"} later as approved${by}`);
  if (a.backToApproval) parts.push(`${a.backToApproval} ${a.backToApproval === 1 ? "needs" : "need"} approving again`);
  if (a.overCap) parts.push(`${a.overCap} over the cap will wait`);
  return `Launch moved ${dayWords(a.from)} to ${dayWords(a.to)}${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

export type StallChoice = "wait" | "go_ahead" | "cancel";

/** Going ahead is offered only when no waiting step's text uses the missing output: it would link nowhere. */
export function stallChoices(dependants: readonly { key: string; usesOutput: boolean }[]): StallChoice[] {
  return dependants.some((d) => d.usesOutput) ? ["wait", "cancel"] : ["wait", "go_ahead", "cancel"];
}

/** Whether to ask about a step with no output: 3 days after its date, or 3 days after a person chose to keep waiting. */
export function stallDue(a: { dependencyOn: string; hasOutput: boolean; today: string; waitingSince?: string | null }): boolean {
  if (a.hasOutput) return false;
  return a.today >= addDays(a.waitingSince ?? a.dependencyOn, STALL_DAYS);
}
