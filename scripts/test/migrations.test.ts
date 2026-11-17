// SPDX-License-Identifier: AGPL-3.0-only
import { appendFileSync, cpSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const script = join(import.meta.dirname, "../check-migrations.ts");
const clean = join(import.meta.dirname, "fixtures/migrations/clean");

function run(dir?: string, ...args: string[]) {
  const r = Bun.spawnSync([process.execPath, script, ...(dir ? ["--dir", dir] : []), ...args]);
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

/** A temp copy of the clean fixture, changed by fn. */
function copy(fn: (dir: string) => void = () => {}): string {
  const dir = mkdtempSync(join(tmpdir(), "direx-migrations-"));
  cpSync(clean, dir, { recursive: true });
  fn(dir);
  return dir;
}

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

function expectFailure(dir: string, message: string) {
  const r = run(dir);
  expect(r.code).toBe(1);
  expect(r.out).toMatch(new RegExp(`^migrations: .*${message}`, "m"));
}

test("passes on the clean fixture", () => {
  expect(run(clean).code).toBe(0);
});

// The real folder may hold a migration that is still awaiting review; that is the only
// failure allowed here.
test("the real migrations fail only on unrecorded files", () => {
  const r = run();
  const errors = r.out.split("\n").filter((l) => l.startsWith("migrations: "));
  expect(r.code).toBe(errors.length ? 1 : 0);
  for (const e of errors) expect(e).toMatch(/not recorded/);
});

test("fails when a recorded file is edited", () => {
  expectFailure(copy((d) => appendFileSync(join(d, "0000_create_posts.sql"), "\n-- edit\n")), "edited after it was recorded");
});

test("fails on a gap in the sequence", () => {
  const dir = copy((d) => {
    const j = json(join(d, "meta/_journal.json"));
    j.entries[1].idx = 2;
    writeFileSync(join(d, "meta/_journal.json"), JSON.stringify(j));
  });
  expectFailure(dir, "sequence must be 0..n-1");
});

test("fails on a file missing from the journal", () => {
  expectFailure(copy((d) => writeFileSync(join(d, "0002_stray.sql"), "SELECT 1;\n")), "not in meta/_journal.json");
});

test("fails on a name that is not snake_case", () => {
  const dir = copy((d) => {
    const j = json(join(d, "meta/_journal.json"));
    j.entries[0].tag = "0000_CreatePosts";
    writeFileSync(join(d, "meta/_journal.json"), JSON.stringify(j));
    renameSync(join(d, "0000_create_posts.sql"), join(d, "0000_CreatePosts.sql"));
  });
  expectFailure(dir, "lowercase snake_case");
});

test("fails on a missing description", () => {
  const dir = copy((d) => {
    const r = json(join(d, "receipts.json"));
    r.files["0000_create_posts.sql"].description = "";
    writeFileSync(join(d, "receipts.json"), JSON.stringify(r));
  });
  expectFailure(dir, "no description");
});

test("fails on a non-concurrent index on a large table", () => {
  const dir = copy((d) => {
    writeFileSync(join(d, "0001_index_posts_status.sql"), 'CREATE UNIQUE INDEX "posts_id_idx" ON "public"."posts" ("id");\n');
    const r = json(join(d, "receipts.json"));
    delete r.files["0001_index_posts_status.sql"];
    writeFileSync(join(d, "receipts.json"), JSON.stringify(r));
  });
  expect(run(dir, "--record", "--description", "Index posts").code).toBe(1);
  expectFailure(dir, "index on large table posts must use CREATE INDEX CONCURRENTLY");
});

test("fails on an UPDATE of a large table with no WHERE", () => {
  const dir = copy((d) => {
    writeFileSync(join(d, "0001_index_posts_status.sql"), "UPDATE posts SET status = 'draft';\n");
    const r = json(join(d, "receipts.json"));
    delete r.files["0001_index_posts_status.sql"];
    writeFileSync(join(d, "receipts.json"), JSON.stringify(r));
  });
  run(dir, "--record", "--description", "Backfill");
  expectFailure(dir, "UPDATE of large table posts has no WHERE");
});

test("--record adds a missing receipt and never overwrites one", () => {
  const dir = copy((d) => {
    writeFileSync(join(d, "0002_add_title.sql"), 'ALTER TABLE "posts" ADD COLUMN "title" text;\n');
    const j = json(join(d, "meta/_journal.json"));
    j.entries.push({ idx: 2, version: "7", when: 1793332842691, tag: "0002_add_title", breakpoints: true });
    writeFileSync(join(d, "meta/_journal.json"), JSON.stringify(j));
  });
  const before = json(join(dir, "receipts.json")).files;
  expectFailure(dir, "0002_add_title.sql: not recorded");

  expect(run(dir, "--record").code).toBe(1);
  expectFailure(dir, "0002_add_title.sql: no description");

  appendFileSync(join(dir, "0000_create_posts.sql"), "\n-- edit\n");
  run(dir, "--record", "--description", "Add a title to posts");
  const after = json(join(dir, "receipts.json")).files;
  expect(after["0000_create_posts.sql"]).toEqual(before["0000_create_posts.sql"]);
  expect(after["0002_add_title.sql"].description).toBe("TODO: describe this migration");
  expectFailure(dir, "0000_create_posts.sql: edited after it was recorded");
});

test("--record with --description fills the new receipt", () => {
  const dir = copy((d) => {
    const r = json(join(d, "receipts.json"));
    delete r.files["0000_create_posts.sql"];
    writeFileSync(join(d, "receipts.json"), JSON.stringify(r));
  });
  expect(run(dir, "--record", "--description", "Create the posts table").code).toBe(0);
  expect(json(join(dir, "receipts.json")).files["0000_create_posts.sql"].description).toBe("Create the posts table");
});

/** The clean fixture with 0001 replaced by sql and recorded, and receipts changed by edit. */
function with0001(sql: string, edit: (r: { checkFrom?: number }) => void = () => {}): string {
  const dir = copy((d) => {
    writeFileSync(join(d, "0001_index_posts_status.sql"), sql);
    const r = json(join(d, "receipts.json"));
    delete r.files["0001_index_posts_status.sql"];
    edit(r);
    writeFileSync(join(d, "receipts.json"), JSON.stringify(r));
  });
  run(dir, "--record", "--description", "Changed");
  return dir;
}

test("fails on CONCURRENTLY in a file without the no-transaction marker", () => {
  expectFailure(with0001('CREATE INDEX CONCURRENTLY "posts_s" ON "posts" ("status");\n'), 'CONCURRENTLY needs "-- direx:no-transaction" as the first line');
});

test("fails on the marker anywhere but the first line, and on a misspelt one", () => {
  expectFailure(with0001('SELECT 1;\n-- direx:no-transaction\n'), 'line 2: the only directive is "-- direx:no-transaction"');
  expectFailure(with0001("-- direx:no-transactions\nSELECT 1;\n"), "line 1: the only directive");
});

test("fails on a new tenant table without its row-level security in the same file", () => {
  const table = 'CREATE TABLE "notes" (\n\t"workspace_id" uuid NOT NULL,\n\t"id" uuid NOT NULL\n);\n';
  expectFailure(with0001(table), "tenant table notes needs ENABLE ROW LEVEL SECURITY in the same file");
  expectFailure(with0001(`${table}ALTER TABLE notes ENABLE ROW LEVEL SECURITY;\n`), "tenant table notes needs FORCE ROW LEVEL SECURITY");
  expect(run(with0001(`${table}ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "notes" FORCE ROW LEVEL SECURITY;\n`)).code).toBe(0);
});

test("files before checkFrom are not judged by the large-table, marker or RLS checks", () => {
  const plain = 'CREATE INDEX "posts_s" ON "posts" ("status");\n';
  expectFailure(with0001(plain), "index on large table posts must use CREATE INDEX CONCURRENTLY");
  expect(run(with0001(plain, (r) => (r.checkFrom = 2))).code).toBe(0);
});
