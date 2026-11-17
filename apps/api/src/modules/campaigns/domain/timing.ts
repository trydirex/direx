// SPDX-License-Identifier: AGPL-3.0-only
// Pure: when a Campaign's emails get written. The first email per Person is drafted on import, once a
// person confirms what it takes; per-Person follow-ups are drafted shortly before they are due, and
// only for People still waiting on them; anything that can't be drafted yet says what it waits on.

export type StepMode = "template" | "per_person";
/** Why a Person's draft can't be made yet. Only the daily cap clears without a person. */
export type WaitReason = { kind: "no_mailbox" } | { kind: "no_eligibility" } | { kind: "no_text" } | { kind: "step_output"; label: string } | { kind: "daily_cap" };

/** Days before a per-Person follow-up is due that it is drafted, when it is known who hasn't replied. */
export const FOLLOW_UP_LEAD_DAYS = 2;
/** A per-Person draft is two runs: a reader and a writer, each counted against its own agent's cap. */
export const RUNS_PER_PERSON = 2;
const DAY_MS = 86_400_000;

/**
 * Each email step's mode when nobody has chosen one. The first email is written per Person when the
 * Campaign lets outside content in, since that is the email a reader of their site improves most;
 * follow-ups are templates, which cost no runs.
 */
export function defaultModes(steps: readonly { key: string; email: boolean }[], outsideContentAllowed: boolean): Record<string, StepMode> {
  const first = steps.find((s) => s.email)?.key;
  return Object.fromEntries(steps.filter((s) => s.email).map((s) => [s.key, s.key === first && outsideContentAllowed ? "per_person" : "template"]));
}

export type Caps = {
  /** Runs each of the reader and the writer may still start today, and on any later day. */
  agentLeftToday: number;
  agentPerDay: number;
  /** Runs the Workspace may still start today, and on any later day, across all agents. */
  workspaceLeftToday: number;
  workspacePerDay: number;
};

/** People that can be drafted in a day: each needs one run of each agent and two of the Workspace's. */
const peoplePerDay = (agent: number, workspace: number) => Math.max(0, Math.min(agent, Math.floor(workspace / RUNS_PER_PERSON)));

/**
 * What confirming an import will take, shown before anything starts. A template step costs no runs
 * and is ready today. `costCapCents` is one run's cost cap, null when the route has no price, as on a
 * subscription. Days count today as the first, in UTC, as the caps do; null when the caps allow none.
 */
export function draftingPreview(a: { ready: number; mode: StepMode; costCapCents: number | null; caps: Caps; today: string }) {
  if (a.mode === "template" || a.ready === 0) return { people: a.ready, runs: 0, worstCaseCents: 0, days: 1, readyOn: a.today };
  const runs = a.ready * RUNS_PER_PERSON;
  const today = peoplePerDay(a.caps.agentLeftToday, a.caps.workspaceLeftToday);
  const perDay = peoplePerDay(a.caps.agentPerDay, a.caps.workspacePerDay);
  const days = a.ready <= today ? 1 : perDay === 0 ? null : 1 + Math.ceil((a.ready - today) / perDay);
  return { people: a.ready, runs, worstCaseCents: a.costCapCents === null ? null : runs * a.costCapCents, days, readyOn: days === null ? null : addDays(a.today, days - 1) };
}

export type FollowUpPerson = { personId: string; replied: boolean; stopped: boolean; drafted: ReadonlySet<string> };

/**
 * The People each per-Person follow-up should be drafted for today: from its lead day on, for anyone
 * who hasn't replied, stopped or been drafted for it. The first email step is drafted on import, not here.
 */
export function followUpsDue(steps: readonly { key: string; on: string; mode: StepMode; email: boolean }[], people: readonly FollowUpPerson[], today: string): { stepKey: string; personIds: string[] }[] {
  return followUpStepsDue(steps, today)
    .map((s) => ({ stepKey: s.key, personIds: people.filter((p) => !p.replied && !p.stopped && !p.drafted.has(s.key)).map((p) => p.personId) }))
    .filter((d) => d.personIds.length > 0);
}

/** The per-Person follow-up steps whose drafting lead has come. The first email step is drafted on import, not here. */
export function followUpStepsDue<S extends { key: string; on: string; mode: StepMode | null; email: boolean }>(steps: readonly S[], today: string): S[] {
  return steps
    .filter((s) => s.email)
    .slice(1)
    .filter((s) => s.mode === "per_person" && addDays(s.on, -FOLLOW_UP_LEAD_DAYS) <= today);
}

/** What a person can fix, counted by reason, for the waiting-on Item. The daily cap clears on its own. */
export function fixable(waiting: readonly WaitReason[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const w of waiting) {
    if (w.kind === "daily_cap") continue;
    const label = w.kind === "no_mailbox" ? "a Mailbox for the step" : w.kind === "no_eligibility" ? "eligibility" : w.kind === "no_text" ? "the step's text" : w.label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count }));
}

/**
 * How far one email step's drafting has got: drafts written, People still to write, the day the last
 * should be written, and what the rest wait on. `blocked` stops the whole step, so every active Person
 * waits on it; otherwise only People missing eligibility do. Read, never stored.
 */
export function stepProgress(a: { written: number; toWrite: number; days: number | null; today: string; people: number; notEligible: number; blocked: WaitReason | null }) {
  const waiting: WaitReason[] = a.blocked ? Array.from({ length: Math.max(0, a.people - a.written) }, () => a.blocked!) : Array.from({ length: a.notEligible }, () => ({ kind: "no_eligibility" as const }));
  const toWrite = a.blocked ? 0 : a.toWrite;
  return { written: a.written, toWrite, readyOn: toWrite > 0 && a.days !== null ? addDays(a.today, Math.max(1, a.days) - 1) : null, waiting: fixable(waiting), reasons: waiting };
}

/** The waiting-on Item's title, naming the owner, since everyone in the Workspace sees it. Null when nothing is left to fix. */
export function waitingTitle(owner: string, waiting: readonly WaitReason[]): string | null {
  const parts = fixable(waiting).map(({ label, count }) => `${count} ${count === 1 ? "Person" : "People"} waiting on ${label}`);
  return parts.length ? `${owner}'s Campaign: ${parts.join(", ")}` : null;
}

export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}
