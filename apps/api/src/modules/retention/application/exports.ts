// SPDX-License-Identifier: AGPL-3.0-only
// A Workspace's data export (ADR 0030 rule 008): an Owner asks, a job builds one ZIP of a JSON Lines
// file per table plus the media files, the ZIP is stored where media goes, an Owner downloads it for
// 24 hours, and an hourly sweep removes it. It works for a deleted Workspace until its purge.
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import type { Store, Stored } from "../../media/index";
import { exportSweepDue, findExport, insertExport, liveFiles, markFailed, markReady, markRemoved, readTable, recentExports, TENANT_TABLES, type ExportRow } from "../adapters/export-repo";
import { OMITTED } from "../domain/omitted";
import { createZip } from "../adapters/zip";

export const EXPORT_QUEUE = "retention.export";
export const EXPORT_SWEEP = "retention.export_sweep";
/** How long a ready ZIP can be downloaded; the table's check holds the same number. */
export const LINK_MS = 24 * 60 * 60_000;
/** A build not done after an hour is taken as lost, so another may start [DEFAULT]. */
const BUSY_MS = 60 * 60_000;

export type ExportState = "building" | "ready" | "failed" | "expired";
export type ExportView = { id: string; state: ExportState; requestedAt: Date; readyAt: Date | null; expiresAt: Date | null; bytes: number | null };

/** The job's data. Not `workspaceId`: soft delete cancels jobs by that key, and an export must outlive it. */
type ExportJob = { exportOf: string; exportId: string };

const EXTENSIONS: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export type ExportDeps = {
  store: () => Store;
  now: () => Date;
  /** Where a ZIP is put together before it is stored. */
  scratch?: () => string;
};

export function createExports(deps: ExportDeps) {
  // The server's pg-boss, once its worker has started the export queue.
  let boss: Pick<PgBoss, "send"> | undefined;
  const view = (r: ExportRow): ExportView => {
    const gone = r.removedAt !== null || (r.expiresAt !== null && r.expiresAt <= deps.now());
    const state: ExportState = r.failedAt ? "failed" : r.readyAt ? (gone ? "expired" : "ready") : "building";
    return { id: r.id, state, requestedAt: r.requestedAt, readyAt: r.readyAt, expiresAt: r.expiresAt, bytes: r.bytes };
  };

  /** Starts a build, unless one is already under way. */
  async function start(workspaceId: string, userId: string): Promise<{ ok: true; export: ExportView } | { ok: false; reason: "export_running" }> {
    if (!boss) throw new Error("exports are built on the server's worker, which starts with the server");
    const at = deps.now();
    const row = await insertExport(workspaceId, userId, at, new Date(at.getTime() - BUSY_MS));
    if (!row) return { ok: false, reason: "export_running" };
    const job: ExportJob = { exportOf: workspaceId, exportId: row.id };
    await boss.send(EXPORT_QUEUE, job);
    return { ok: true, export: view(row) };
  }

  /** The newest exports, newest first. */
  const list = async (workspaceId: string): Promise<ExportView[]> => (await recentExports(workspaceId, 5)).map(view);

  /** The ZIP while it may be downloaded, or null. */
  async function download(workspaceId: string, id: string): Promise<Stored | null> {
    const row = await findExport(workspaceId, id);
    if (!row || view(row).state !== "ready") return null;
    return deps.store().read(row.storageKey);
  }

  /** A stored file's bytes, from disk or through object storage's short-lived link. */
  async function bytesOf(stored: Stored): Promise<ReadableStream<Uint8Array>> {
    if (stored.kind === "file") return stored.file.stream();
    const r = await fetch(stored.url);
    if (!r.ok || !r.body) throw new Error(`export: object storage answered ${r.status}`);
    return r.body;
  }

  /** Builds one export's ZIP and stores it. A failure marks it failed and leaves nothing stored. */
  async function build(workspaceId: string, id: string): Promise<void> {
    const row = await findExport(workspaceId, id);
    if (!row || row.readyAt || row.failedAt) return;
    const store = deps.store();
    const temp = join(deps.scratch?.() ?? tmpdir(), `direx-export-${id}.zip`);
    try {
      const sink = Bun.file(temp).writer();
      const zip = createZip(async (b) => void (await sink.write(b)), deps.now());
      const counts: Record<string, number> = {};
      for (const table of TENANT_TABLES) {
        const e = zip.entry(`tables/${table.split(".")[1]}.jsonl`, true);
        counts[table] = await readTable(workspaceId, table, OMITTED[table] ?? [], (lines) => e.write(Buffer.from(`${lines.join("\n")}\n`)));
        await e.end();
      }
      const files: string[] = [];
      for (const f of await liveFiles(workspaceId)) {
        const path = `media/${f.id}${EXTENSIONS[f.contentType] ?? ""}`;
        const e = zip.entry(path, false);
        for await (const chunk of await bytesOf(await store.read(f.storageKey))) await e.write(chunk);
        await e.end();
        files.push(path);
      }
      const about = { workspaceId, exportId: id, exportedAt: deps.now().toISOString(), rows: counts, media: files, omitted: OMITTED };
      await zip.file("export.json", Buffer.from(JSON.stringify(about, null, 2)));
      const bytes = await zip.end();
      await sink.end();
      await store.put(row.storageKey, Bun.file(temp).stream());
      const at = deps.now();
      await markReady(workspaceId, id, bytes, at, new Date(at.getTime() + LINK_MS));
    } catch (e) {
      console.error(`export: ${id} failed:`, e);
      await store.remove(row.storageKey).catch(() => undefined);
      await markFailed(workspaceId, id, deps.now());
    } finally {
      await rm(temp, { force: true });
    }
  }

  /** The hourly sweep: each expired or failed export's ZIP goes. One the store can't remove waits for the next run. */
  async function sweep(): Promise<{ removed: number; failed: number }> {
    const store = deps.store();
    let removed = 0;
    let failed = 0;
    for (const d of await exportSweepDue()) {
      try {
        await store.remove(d.storageKey);
        await markRemoved(d.workspaceId, d.id, deps.now());
        removed++;
      } catch (e) {
        failed++;
        console.error(`export: sweep could not remove ${d.storageKey}, trying again next run:`, e);
      }
    }
    return { removed, failed };
  }

  /** The build queue and the hourly sweep, on the server's pg-boss. */
  async function work(b: Pick<PgBoss, "createQueue" | "schedule" | "work" | "send">): Promise<void> {
    await b.createQueue(EXPORT_QUEUE);
    await b.work<ExportJob>(EXPORT_QUEUE, async (jobs) => {
      for (const j of jobs) await build(j.data.exportOf, j.data.exportId);
    });
    await b.createQueue(EXPORT_SWEEP);
    await b.schedule(EXPORT_SWEEP, "20 * * * *");
    await b.work(EXPORT_SWEEP, async () => sweep());
    boss = b;
  }

  return { start, list, download, build, sweep, work };
}

export type Exports = ReturnType<typeof createExports>;
