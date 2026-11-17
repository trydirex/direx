// SPDX-License-Identifier: AGPL-3.0-only
// A docs tool's database imported to the Calendar (spec P2). Each row with a date ahead, a mapped
// channel and some text becomes a post waiting for approval, through the social module's own write.
// Check again is the same read: the docs tool wins over a post nobody touched in Direx, and anything
// else is flagged, never overwritten (spec Decision 2).
import type { QueryOutput } from "@direx/plugin-sdk";
import { z } from "zod";
import { inWorkspace, insertRow, markChecked, rowsOf, saveSource, sourceById, sources, updateRow, type SourceRow } from "../adapters/repo";
import { mappingProblem, outcomeOf, seenUntil, type Column, type Mapping, type Outcome, type Skip, type SourceRowIn } from "../domain/plan";
import { reader, type Connection, type DocsReason, type ReadDeps } from "./read";
import { settleIn } from "./write-back";

type Account = { id: string; credentialId: string; connection: string; networkId: string; name: string };
type Wrote = { ok: boolean; itemId?: string | undefined; reason?: string | undefined };
export type ImportDeps = {
  accounts: (workspaceId: string) => Promise<Account[]>;
  writePost: (workspaceId: string, p: { connection: string; credentialId: string; networkId: string; text: string; at: Date }, userId: string) => Promise<Wrote>;
  editPost: (workspaceId: string, itemId: string, text: string, userId: string) => Promise<{ ok: boolean; reason?: string | undefined }>;
  movePost: (workspaceId: string, itemId: string, at: Date, userId: string) => Promise<{ ok: boolean; reason?: string | undefined }>;
  postOf: (workspaceId: string, itemId: string) => Promise<{ state: string; revision: number } | undefined>;
  timeZone: (workspaceId: string) => Promise<string>;
  now?: () => Date;
};

export const MappingInput = z.strictObject({
  date: z.string().min(1).max(200),
  channel: z.string().min(1).max(200),
  text: z.union([z.strictObject({ column: z.string().min(1).max(200) }), z.strictObject({ page: z.literal(true) })]),
  accounts: z.record(z.string().min(1).max(200), z.uuid()),
});

// ponytail: a whole database is read each time, 10 pages of 100 rows at most; read since checkedAt if calendars grow past that.
const MAX_PAGES = 10;
type Planned = { row: SourceRowIn; title: string; outcome: Outcome };

export function createImports(deps: ReadDeps & ImportDeps) {
  const now = deps.now ?? (() => new Date());
  const { connection, ask } = reader(deps);

  async function rowsConnection(workspaceId: string) {
    const c = await connection(workspaceId);
    if (!c) return { ok: false, reason: "not_connected" } as const;
    if (!c.provider.rows) return { ok: false, reason: "no_import" } as const;
    return { ok: true, c: c as Connection & { provider: { rows: string } } } as const;
  }
  /** Every row of the database, up to the cap, with its columns. `cut` says there were more. */
  async function readAll(workspaceId: string, c: Connection & { provider: { rows: string } }, externalId: string) {
    let cursor: string | null = null;
    const rows: SourceRowIn[] = [];
    let columns: Column[] = [];
    let title = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const r: { ok: true; out: QueryOutput<"docs.rows"> } | { ok: false; reason: DocsReason } = await ask(workspaceId, c, c.provider.rows, { sourceId: externalId, ...(cursor ? { cursor } : {}) });
      if (!r.ok) return r;
      ({ columns, title } = r.out);
      rows.push(...r.out.rows);
      cursor = r.out.next;
      if (!cursor) return { ok: true, rows, columns, title, cut: false } as const;
    }
    return { ok: true, rows, columns, title, cut: true } as const;
  }
  const titleColumn = (columns: readonly Column[]) => columns.find((c) => c.type === "title")?.name;

  async function plan(workspaceId: string, source: SourceRow, c: Connection & { provider: { rows: string } }) {
    const read = await readAll(workspaceId, c, source.externalId);
    if (!read.ok) return read;
    const mapping = source.mapping as Mapping;
    const problem = mappingProblem(mapping, read.columns);
    if (problem) return { ok: false, reason: problem } as const;
    // A write-back sent since the last pass is Direx's own edit, so it is recorded first (ADR 0025 rule 003).
    const rows = await inWorkspace(workspaceId, async (tx) => {
      await settleIn(tx, source, now());
      return rowsOf(tx, source.id);
    });
    const imported = new Map(rows.map((r) => [r.externalId, r]));
    const timeZone = await deps.timeZone(workspaceId);
    const named = titleColumn(read.columns);
    const planned: Planned[] = [];
    for (const row of read.rows) {
      const before = imported.get(row.id);
      const seen = before && seenUntil(before);
      const newer = before && row.editedAt && (!seen || new Date(row.editedAt) > seen);
      const post = newer ? await deps.postOf(workspaceId, before.itemId) : undefined;
      const outcome = outcomeOf(row, mapping, { timeZone, now: now(), ...(before && { imported: before }), ...(post && { post }) });
      const title = (named && typeof row.values[named] === "string" ? (row.values[named] as string) : "") || "Untitled";
      planned.push({ row, title, outcome });
    }
    return { ok: true, planned, cut: read.cut, title: read.title } as const;
  }
  const textFor = async (workspaceId: string, c: Connection, p: Planned, given: string | null) => {
    if (given !== null) return given.trim();
    const page = await ask(workspaceId, c, c.provider.pageText, { pageId: p.row.id });
    return page.ok ? page.out.text.trim() : null;
  };

  return {
    /** The databases shared with Direx, each with the source it was set up as, if any. */
    async databases(workspaceId: string) {
      const r = await rowsConnection(workspaceId);
      if (!r.ok) return r;
      const found = await ask(workspaceId, r.c, r.c.provider.sources, { kind: "database" });
      if (!found.ok) return found;
      const saved = new Map((await inWorkspace(workspaceId, sources)).map((s) => [s.externalId, s]));
      return { ok: true, databases: found.out.pages.map((p) => ({ id: p.id, title: p.title, editedAt: p.editedAt, sourceId: saved.get(p.id)?.id ?? null })) } as const;
    },

    /** One database's columns, and its saved mapping. */
    async database(workspaceId: string, externalId: string) {
      const r = await rowsConnection(workspaceId);
      if (!r.ok) return r;
      const read = await ask(workspaceId, r.c, r.c.provider.rows, { sourceId: externalId });
      if (!read.ok) return read;
      const saved = (await inWorkspace(workspaceId, sources)).find((s) => s.externalId === externalId);
      return { ok: true, title: read.out.title, columns: read.out.columns, sourceId: saved?.id ?? null, mapping: (saved?.mapping as Mapping | undefined) ?? null } as const;
    },

    /** Saves how a database maps to posts, checked against its columns and the Workspace's accounts. */
    async saveMapping(workspaceId: string, externalId: string, mapping: Mapping, userId: string) {
      const r = await rowsConnection(workspaceId);
      if (!r.ok) return r;
      const read = await ask(workspaceId, r.c, r.c.provider.rows, { sourceId: externalId });
      if (!read.ok) return read;
      const problem = mappingProblem(mapping, read.out.columns);
      if (problem) return { ok: false, reason: problem } as const;
      const accounts = new Set((await deps.accounts(workspaceId)).map((a) => a.id));
      if (Object.values(mapping.accounts).some((id) => !accounts.has(id))) return { ok: false, reason: "unknown_account" } as const;
      const row = await inWorkspace(workspaceId, (tx) => saveSource(tx, { workspaceId, externalId, title: read.out.title, mapping, setBy: userId, now: now() }));
      return { ok: true, sourceId: row.id } as const;
    },

    /** What an import would do to each row, changing nothing. */
    async preview(workspaceId: string, sourceId: string) {
      const r = await rowsConnection(workspaceId);
      if (!r.ok) return r;
      const source = await inWorkspace(workspaceId, (tx) => sourceById(tx, sourceId));
      if (!source) return { ok: false, reason: "not_found" } as const;
      const p = await plan(workspaceId, source, r.c);
      if (!p.ok) return p;
      return { ok: true, cut: p.cut, rows: p.planned.map(({ row, title, outcome }) => ({ id: row.id, title, outcome: outcome.kind, ...(outcome.kind === "skip" && { reason: outcome.reason }) })) } as const;
    },

    /** Imports: makes, updates and flags, as the preview said. Each row's result is returned. */
    async run(workspaceId: string, sourceId: string, userId: string) {
      const r = await rowsConnection(workspaceId);
      if (!r.ok) return r;
      const source = await inWorkspace(workspaceId, (tx) => sourceById(tx, sourceId));
      if (!source) return { ok: false, reason: "not_found" } as const;
      // ponytail: two imports of one source at once can both make a post for a new row; the second row insert fails and leaves its post. Lock the source if teams hit it.
      const p = await plan(workspaceId, source, r.c);
      if (!p.ok) return p;
      const accounts = new Map((await deps.accounts(workspaceId)).map((a) => [a.id, a]));
      const result = { made: 0, updated: 0, changed: 0, skipped: [] as { id: string; title: string; reason: Skip | string }[] };
      for (const item of p.planned) {
        const o = item.outcome;
        const editedAt = item.row.editedAt ? new Date(item.row.editedAt) : null;
        const skip = (reason: Skip | string) => void result.skipped.push({ id: item.row.id, title: item.title, reason });
        if (o.kind === "skip") skip(o.reason);
        else if (o.kind === "changed") {
          await inWorkspace(workspaceId, (tx) => updateRow(tx, { sourceId, externalId: item.row.id, editedAt, flag: "changed_in_source", now: now() }));
          result.changed += 1;
        } else if (o.kind === "make") {
          const text = await textFor(workspaceId, r.c, item, o.text);
          const account = accounts.get(o.accountId);
          if (!text) skip("no_text");
          else if (!account) skip("no_channel");
          else {
            const wrote = await deps.writePost(workspaceId, { connection: account.connection, credentialId: account.credentialId, networkId: account.networkId, text, at: o.at }, userId);
            const post = wrote.ok && wrote.itemId ? await deps.postOf(workspaceId, wrote.itemId) : undefined;
            if (!wrote.ok || !wrote.itemId || !post) skip(wrote.reason ?? "failed");
            else {
              await inWorkspace(workspaceId, (tx) => insertRow(tx, { workspaceId, sourceId, externalId: item.row.id, itemId: wrote.itemId!, revision: post.revision, editedAt, now: now() }));
              result.made += 1;
            }
          }
        } else if (o.kind === "update") {
          const text = await textFor(workspaceId, r.c, item, o.text);
          const edited = text ? await deps.editPost(workspaceId, o.itemId, text, userId) : { ok: false, reason: "no_text" };
          const moved = edited.ok ? await deps.movePost(workspaceId, o.itemId, o.at, userId) : edited;
          const post = moved.ok ? await deps.postOf(workspaceId, o.itemId) : undefined;
          if (!post) skip(moved.reason ?? "failed");
          else {
            await inWorkspace(workspaceId, (tx) => updateRow(tx, { sourceId, externalId: item.row.id, revision: post.revision, editedAt, flag: null, now: now() }));
            result.updated += 1;
          }
        }
      }
      await inWorkspace(workspaceId, (tx) => markChecked(tx, sourceId, now()));
      return { ok: true, ...result, cut: p.cut } as const;
    },
  };
}
