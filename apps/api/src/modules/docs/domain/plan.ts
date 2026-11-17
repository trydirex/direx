// SPDX-License-Identifier: AGPL-3.0-only
// What an import does to each row, decided from the row, the mapping and what was imported before. The
// docs tool is the source, so it wins, except over what only Direx holds: a post edited, approved or sent
// in Direx is never overwritten (spec Decision 2).

/** Which column is the date, the channel and the text (a column, or the row's own page), and the social
    account each channel value's posts go out as. A value left out is skipped. */
export type Mapping = { date: string; channel: string; text: { column: string } | { page: true }; accounts: Record<string, string> };
export type Column = { name: string; type: string; options: string[] | null };
export type SourceRowIn = { id: string; editedAt: string | null; values: Record<string, string | string[] | null> };
/** `writtenEditedAt` is the edit Direx's own status write-back made (ADR 0025 rule 003). */
export type Imported = { itemId: string; importedRevision: number; editedAt: Date | null; writtenEditedAt?: Date | null };

/** The newest edit already accounted for: the last one read, or Direx's own write-back, whichever is later. */
export const seenUntil = (i: Pick<Imported, "editedAt" | "writtenEditedAt">): Date | null => (i.writtenEditedAt && (!i.editedAt || i.writtenEditedAt > i.editedAt) ? i.writtenEditedAt : i.editedAt);
export type PostNow = { state: string; revision: number };

/** Why a mapping doesn't fit the database, or null when it does. */
export function mappingProblem(m: Mapping, columns: readonly Column[]): string | null {
  const type = (name: string) => columns.find((c) => c.name === name)?.type;
  if (type(m.date) !== "date") return "date_not_a_date";
  if (!["select", "status"].includes(type(m.channel) ?? "")) return "channel_not_a_choice";
  if ("column" in m.text && !["rich_text", "title"].includes(type(m.text.column) ?? "")) return "text_not_text";
  const options = columns.find((c) => c.name === m.channel)?.options ?? [];
  if (Object.keys(m.accounts).some((v) => !options.includes(v))) return "unknown_channel_value";
  return null;
}

export const SKIPS = ["no_date", "past_date", "no_channel", "no_text"] as const;
export type Skip = (typeof SKIPS)[number];
export type Outcome =
  | { kind: "make"; at: Date; accountId: string; text: string | null }
  | { kind: "update"; at: Date; text: string | null; itemId: string }
  | { kind: "changed"; itemId: string }
  | { kind: "same" }
  | { kind: "skip"; reason: Skip };

/** The instant a wall-clock time on a local day happens in a time zone; a second pass settles a clock change. */
export function atLocal(y: number, m: number, d: number, hour: number, minute: number, timeZone: string): Date {
  const offsetAt = (at: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(at / 1000) * 1000;
  };
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  return new Date(wall - offsetAt(wall - offsetAt(wall)));
}

/** A date column's value as an instant: a day with no time is 9:00 in the Workspace's zone. */
export function instantOf(value: string, timeZone: string): Date | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) return atLocal(Number(day[1]), Number(day[2]), Number(day[3]), 9, 0, timeZone);
  const at = new Date(value);
  return isNaN(at.getTime()) ? null : at;
}

const one = (v: string | string[] | null | undefined) => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** What to do with one row. `text` is null when it comes from the row's page, read only if the row is made or updated. */
export function outcomeOf(row: SourceRowIn, m: Mapping, a: { timeZone: string; now: Date; imported?: Imported; post?: PostNow }): Outcome {
  if (a.imported) {
    const edited = row.editedAt ? new Date(row.editedAt) : null;
    const seen = seenUntil(a.imported);
    if (edited && seen && edited.getTime() <= seen.getTime()) return { kind: "same" };
    // Untouched in Direx: still waiting, at the revision it was imported at.
    if (a.post?.state === "needs_approval" && a.post.revision === a.imported.importedRevision) {
      const date = one(row.values[m.date]);
      const at = date ? instantOf(date, a.timeZone) : null;
      if (at && at > a.now) return { kind: "update", at, text: "column" in m.text ? one(row.values[m.text.column]) : null, itemId: a.imported.itemId };
    }
    return { kind: "changed", itemId: a.imported.itemId };
  }
  const date = one(row.values[m.date]);
  const at = date ? instantOf(date, a.timeZone) : null;
  if (!at) return { kind: "skip", reason: "no_date" };
  if (at <= a.now) return { kind: "skip", reason: "past_date" };
  const value = one(row.values[m.channel]);
  const accountId = value ? m.accounts[value] : undefined;
  if (!accountId) return { kind: "skip", reason: "no_channel" };
  if ("column" in m.text) {
    const text = one(row.values[m.text.column])?.trim();
    if (!text) return { kind: "skip", reason: "no_text" };
    return { kind: "make", at, accountId, text };
  }
  return { kind: "make", at, accountId, text: null };
}
