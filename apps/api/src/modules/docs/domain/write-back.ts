// SPDX-License-Identifier: AGPL-3.0-only
// The write-back part of a source's mapping (ADR 0025): which column holds the status, the option
// for each Direx state, and the column for a sent post's link. All by id, so a rename in the docs
// tool can't redirect a write.

/** The Direx states a row's status can show. Anything else, such as waiting for approval, isn't written. */
export const WRITE_STATES = ["scheduled", "sent", "cancelled"] as const;
export type WriteState = (typeof WRITE_STATES)[number];

export type WriteBack = {
  statusPropertyId: string;
  statusType: "status" | "select";
  options: Partial<Record<WriteState, string>>;
  urlPropertyId?: string | undefined;
};
export type WriteColumn = { name: string; id?: string | undefined; type: string; choices?: { id: string; name: string }[] | null | undefined };

/** Why a write-back mapping doesn't fit the database's columns, or null when it does. */
export function writeBackProblem(w: WriteBack, columns: readonly WriteColumn[]): string | null {
  const status = columns.find((c) => c.id === w.statusPropertyId);
  if (!status || status.type !== w.statusType) return "status_not_a_choice";
  const ids = new Set((status.choices ?? []).map((c) => c.id));
  if (Object.values(w.options).some((o) => o && !ids.has(o))) return "unknown_option";
  if (w.urlPropertyId && columns.find((c) => c.id === w.urlPropertyId)?.type !== "url") return "url_not_a_link";
  return null;
}

/** The mapping as canonical JSON: keys sorted, unset keys left out, so equal mappings hash equal. */
export const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}` : JSON.stringify(v);

/** A post's visible state as a state the row can show; a post marked posted by hand is sent. */
export const writeStateOf = (visible: string): WriteState | null => (visible === "applied" ? "sent" : (WRITE_STATES as readonly string[]).includes(visible) ? (visible as WriteState) : null);

/** The state a written option stands for: Sent when the write carried the link, else the first state mapped to it. */
export const stateOfWrite = (w: WriteBack, optionId: string, withUrl: boolean): WriteState | null => (withUrl ? "sent" : (WRITE_STATES.find((s) => w.options[s] === optionId) ?? null));
