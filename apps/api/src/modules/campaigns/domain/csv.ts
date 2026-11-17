// SPDX-License-Identifier: AGPL-3.0-only
// A small strict CSV reader. Values stay data: nothing here interprets them. A row with the wrong
// number of columns is reported on its own, so the good rows of a pasted list still count.

export type CsvRow = { row: number; values: Record<string, string> } | { row: number; bad: "wrong_column_count" };
export type Csv = { ok: true; rows: CsvRow[] } | { ok: false; reason: "no_email_column" | "bad_quote" };

function records(text: string): string[][] | null {
  const out: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') {
      if (field || wasQuoted) return null;
      quoted = wasQuoted = true;
    } else if (ch === "," || ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      field = "";
      wasQuoted = false;
      if (ch !== ",") {
        out.push(record);
        record = [];
      }
    } else {
      if (wasQuoted) return null;
      field += ch;
    }
  }
  if (quoted) return null;
  if (field || wasQuoted || record.length) out.push([...record, field]);
  return out.filter((r) => r.length > 1 || r[0] !== "");
}

export function parseCsv(input: string): Csv {
  const all = records(input.replace(/^﻿/, ""));
  if (!all) return { ok: false, reason: "bad_quote" };
  const header = (all[0] ?? []).map((h) => h.trim().toLowerCase());
  if (!header.includes("email")) return { ok: false, reason: "no_email_column" };
  const rows = all.slice(1).map((r, i): CsvRow => {
    if (r.length !== header.length) return { row: i + 1, bad: "wrong_column_count" };
    return { row: i + 1, values: Object.fromEntries(header.map((h, c) => [h, r[c]!.trim()])) };
  });
  return { ok: true, rows };
}
