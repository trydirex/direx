// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what Direx did for one Campaign, as short lines, newest first, from records already kept:
// its draft Actions' state changes grouped by step, state and hour, its notices, its running agent
// runs, and its creation.

/** The kind of the notice a launch move leaves; the latest one can be undone. */
export const LAUNCH_MOVED_KIND = "campaign_launch_moved";

export type ActivityRow =
  | { kind: "actions"; stepKey: string; fromState: string | null; toState: string; reason: string | null; n: number; at: Date; byPerson: boolean }
  | { kind: "notice"; title: string; at: Date; undo?: Undo }
  | { kind: "running"; stepKey: string | null; at: Date }
  | { kind: "created"; at: Date };

/** What reverses a line: for now only the latest launch move, back to the day it came from. */
export type Undo = { kind: "launch"; on: string };
export type ActivityLine = { at: Date; text: string; by: "person" | "direx"; undo?: Undo };

const many = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;

/** One line per row, or none for a change no one needs to see (claiming, dispatching, an edit). */
export function activityLines(rows: readonly ActivityRow[], step: (key: string) => string, reason: (code: string) => string, limit = 20): ActivityLine[] {
  const lines: ActivityLine[] = [];
  for (const r of rows) {
    if (r.kind === "created") lines.push({ at: r.at, text: "Created the campaign from its plan", by: "person" });
    else if (r.kind === "notice") lines.push({ at: r.at, text: r.title, by: "direx", ...(r.undo && { undo: r.undo }) });
    else if (r.kind === "running") lines.push({ at: r.at, text: r.stepKey ? `Drafting ${step(r.stepKey)}` : "Drafting", by: "direx" });
    else {
      const s = step(r.stepKey);
      const by = r.byPerson ? "person" : "direx";
      const text =
        r.toState === "needs_approval"
          ? r.fromState === null || r.fromState === "draft"
            ? `Drafted ${s} for ${many(r.n, "person", "people")}`
            : `${many(r.n, "draft", "drafts")} of ${s} went back for approval`
          : r.toState === "scheduled" && r.fromState === "needs_approval"
            ? `Approved ${many(r.n, "draft", "drafts")} of ${s}`
            : r.toState === "sent"
              ? `Sent ${s} to ${many(r.n, "person", "people")}`
              : r.toState === "held"
                ? `Held ${many(r.n, "email", "emails")} of ${s}: ${reason(r.reason ?? "")}`
                : r.toState === "blocked"
                  ? `Couldn't send ${many(r.n, "email", "emails")} of ${s}: ${reason(r.reason ?? "")}`
                  : r.toState === "cancelled"
                    ? `Cancelled ${many(r.n, "email", "emails")} of ${s}`
                    : null;
      if (text) lines.push({ at: r.at, text, by });
    }
  }
  return lines.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

/** The launch move an Undo can reverse: the newest one, and only while the launch is still where it put it. */
export function launchUndo<N extends { kind: string; payload: unknown; at: Date; state: string | null }>(notices: readonly N[], movedKind: string, anchorOn: string | null): { notice: N; undo: Undo } | null {
  // Each move replaces the last one's notice, so at the same moment the one still open is the newer.
  const latest = notices.filter((n) => n.kind === movedKind).sort((a, b) => b.at.getTime() - a.at.getTime() || Number(a.state === "cancelled") - Number(b.state === "cancelled"))[0];
  const p = latest?.payload as { from?: unknown; to?: unknown } | undefined;
  if (!latest || typeof p?.from !== "string" || p.to !== anchorOn) return null;
  return { notice: latest, undo: { kind: "launch", on: p.from } };
}
