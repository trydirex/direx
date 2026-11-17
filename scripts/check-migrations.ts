// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { NO_TRANSACTION } from "@direx/db/migrate";

// Checks a drizzle-kit migrations folder. Merged migrations are
// immutable, so each file's sha256 is recorded once in receipts.json and never changes.

type Receipt = { sha256: string; description: string };
// checkFrom: the first journal idx the large-table, marker and RLS checks judge (ADR 0029
// rules 003 and 007). Files before it were merged before those rules and are never re-judged.
type Receipts = { large: string[]; checkFrom?: number; files: Record<string, Receipt> };

const PLACEHOLDER = "TODO: describe this migration";
const PREFIX = "migrations: ";

const { values } = parseArgs({
  options: {
    dir: { type: "string", default: "packages/db/migrations" },
    record: { type: "boolean", default: false },
    description: { type: "string" },
  },
});
const dir = values.dir;
const receiptsPath = join(dir, "receipts.json");
const errors: string[] = [];

const journal: { entries: { idx: number; tag: string }[] } = JSON.parse(
  readFileSync(join(dir, "meta/_journal.json"), "utf8"),
);
const receipts: Receipts = existsSync(receiptsPath)
  ? JSON.parse(readFileSync(receiptsPath, "utf8"))
  : { large: [], files: {} };
const large = new Set(receipts.large.map((t) => t.toLowerCase()));
const sha256 = (file: string) => createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");

const tags = journal.entries.map((e) => e.tag);
const onDisk = readdirSync(dir).filter((f) => f.endsWith(".sql"));

if (values.record) {
  const unrecorded = tags.map((t) => `${t}.sql`).filter((f) => onDisk.includes(f) && !receipts.files[f]);
  if (values.description && unrecorded.length > 1) {
    console.error(`${PREFIX}--description given but ${unrecorded.length} files are unrecorded; record them one at a time`);
    process.exit(1);
  }
  for (const f of unrecorded) {
    receipts.files[f] = { sha256: sha256(f), description: values.description ?? PLACEHOLDER };
    console.log(`recorded ${f}`);
  }
  writeFileSync(receiptsPath, `${JSON.stringify(receipts, null, 2)}\n`);
}

// Sequence and names.
journal.entries.forEach((e, i) => {
  if (e.idx !== i) errors.push(`journal entry ${i} has idx ${e.idx}; the sequence must be 0..n-1 with no gaps`);
  if (!/^\d{4}_[a-z0-9]+(_[a-z0-9]+)*$/.test(e.tag)) {
    errors.push(`${e.tag}: name must be NNNN_<words> in lowercase snake_case`);
  } else if (Number(e.tag.slice(0, 4)) !== e.idx) {
    errors.push(`${e.tag}: number does not match journal idx ${e.idx}`);
  }
  if (!onDisk.includes(`${e.tag}.sql`)) errors.push(`${e.tag}: in the journal but ${e.tag}.sql is missing`);
});
for (const f of onDisk) {
  if (!tags.includes(f.slice(0, -4))) errors.push(`${f}: not in meta/_journal.json`);
}

// Receipts.
for (const f of tags.map((t) => `${t}.sql`).filter((f) => onDisk.includes(f))) {
  const r = receipts.files[f];
  if (!r) {
    errors.push(`${f}: not recorded; run bun run check:migrations --record after review`);
    continue;
  }
  if (r.sha256 !== sha256(f)) errors.push(`${f}: edited after it was recorded; add a new migration instead`);
  if (!r.description?.trim() || r.description === PLACEHOLDER) {
    errors.push(`${f}: no description in receipts.json`);
  }
}
for (const f of Object.keys(receipts.files)) {
  if (!onDisk.includes(f)) errors.push(`${f}: recorded but the file is gone; merged migrations are never deleted`);
}

const checkFrom = receipts.checkFrom ?? 0;
const judged = onDisk.filter((f) => tags.indexOf(f.slice(0, -4)) >= checkFrom);

// Large-table safety.
const table = (name: string) => name.replaceAll('"', "").split(".").pop()!.toLowerCase();
for (const f of judged) {
  const sql = readFileSync(join(dir, f), "utf8").replace(/--.*$/gm, "");
  const name = String.raw`((?:"?\w+"?\.)?"?\w+"?)`;
  for (const m of sql.matchAll(new RegExp(String.raw`CREATE\s+(?:UNIQUE\s+)?INDEX\b([\s\S]*?)\bON\s+(?:ONLY\s+)?${name}`, "gi"))) {
    if (large.has(table(m[2]!)) && !/\bCONCURRENTLY\b/i.test(m[1]!)) {
      errors.push(`${f}: index on large table ${table(m[2]!)} must use CREATE INDEX CONCURRENTLY`);
    }
  }
  // ponytail: only an UPDATE with no WHERE at all is caught. A WHERE on an unindexed
  // column passes; checking it needs the index set per table from the drizzle snapshot.
  for (const stmt of sql.split(";")) {
    const m = stmt.match(new RegExp(String.raw`^\s*UPDATE\s+(?:ONLY\s+)?${name}`, "i"));
    if (m && large.has(table(m[1]!)) && !/\bWHERE\b/i.test(stmt)) {
      errors.push(`${f}: UPDATE of large table ${table(m[1]!)} has no WHERE; backfill in indexed batches`);
    }
  }
}

// The no-transaction marker, and a new tenant table's RLS in the same file (ADR 0029 rules 002 and 007).
for (const f of judged) {
  const raw = readFileSync(join(dir, f), "utf8");
  const lines = raw.split("\n");
  const marked = lines[0]!.trimEnd() === NO_TRANSACTION;
  lines.forEach((l, i) => {
    if (/^\s*--\s*direx:/i.test(l) && !(i === 0 && marked)) errors.push(`${f}: line ${i + 1}: the only directive is "${NO_TRANSACTION}", as the first line`);
  });
  const sql = raw.replace(/--.*$/gm, "");
  if (!marked && /\bCONCURRENTLY\b/i.test(sql)) errors.push(`${f}: CONCURRENTLY needs "${NO_TRANSACTION}" as the first line`);
  for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?(\w+)"?\s*\(([\s\S]*?)\);/gi)) {
    if (!/\bworkspace_id\b/i.test(m[2]!)) continue;
    for (const what of ["ENABLE", "FORCE"]) {
      const rls = new RegExp(String.raw`ALTER\s+TABLE\s+(?:ONLY\s+)?(?:"?public"?\.)?"?${m[1]}"?\s+${what}\s+ROW\s+LEVEL\s+SECURITY`, "i");
      if (!rls.test(sql)) errors.push(`${f}: tenant table ${m[1]} needs ${what} ROW LEVEL SECURITY in the same file`);
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(PREFIX + e);
  process.exit(1);
}
console.log(`check:migrations: ${tags.length} migrations ok`);
