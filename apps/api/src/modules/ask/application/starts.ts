// SPDX-License-Identifier: AGPL-3.0-only
// An Ask start (ADR 0008 rules 028 and 029): an Item a person accepts before another module's work
// begins. Accepting needs that work's own permission, never a grant or "approve all clean", and
// checks again that nothing it rests on changed. The approval records the start and queues its job
// in one transaction; the job then calls the owning module's start with the Item id as its key, and
// records the work it made or why it was refused, once.
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { AskStart } from "../../agents/index";
import type { ItemKind, Items } from "../../items/index";
import * as repo from "../adapters/repo";
import { sendAskStart, type AskStartJob } from "../adapters/queue";

export const ASK_START_KIND = "ask_start";
export const AskStartPayload = z.strictObject({ start: z.string().min(1), args: z.unknown(), basis: z.string(), tainted: z.boolean(), messageId: z.uuid() });
export type AskStartPayload = z.infer<typeof AskStartPayload>;

/** The permission when the start is gone from this server; apply then refuses it as not_available. */
const FALLBACK = "item.approve";

type StartsDeps = { starts: () => readonly AskStart[]; boss: PgBoss; now?: () => Date };
const byId = (starts: readonly AskStart[], id: string) => starts.find((s) => s.id === id);

/** Whether a start can still run as the Item offered it: the same answer its check gave, on the same basis. */
export async function stillOffered(starts: readonly AskStart[], workspaceId: string, p: AskStartPayload): Promise<{ ok: true; start: AskStart; args: unknown } | { ok: false; reason: string }> {
  const start = byId(starts, p.start);
  if (!start) return { ok: false, reason: "not_available" };
  const args = start.args.safeParse(p.args);
  if (!args.success) return { ok: false, reason: "bad_payload" };
  const checked = await start.check(workspaceId, args.data);
  if (!checked.ok || checked.basis !== p.basis) return { ok: false, reason: "moved_on" };
  return { ok: true, start, args: args.data };
}

export function askStartKinds(d: StartsDeps): Record<string, ItemKind> {
  const now = d.now ?? (() => new Date());
  return {
    [ASK_START_KIND]: {
      permission: FALLBACK,
      permissionOf: (item) => {
        const p = AskStartPayload.safeParse(item.payload);
        return (p.success && byId(d.starts(), p.data.start)?.permission) || FALLBACK;
      },
      bulk: false,
      grant: false,
      async apply(tx, item, actor) {
        const p = AskStartPayload.safeParse(item.payload);
        if (!p.success) return { ok: false, reason: "bad_payload" };
        if (!("userId" in actor)) return { ok: false, reason: "person_required" };
        const offered = await stillOffered(d.starts(), item.workspaceId, p.data);
        if (!offered.ok) return offered;
        await repo.insertStart(tx, { workspaceId: item.workspaceId, itemId: item.id, messageId: p.data.messageId, createdAt: now() });
        await sendAskStart(d.boss, tx, { workspaceId: item.workspaceId, itemId: item.id, userId: actor.userId }, now());
        return { ok: true };
      },
    },
  };
}

/** The ask.start job. Its last try records `start_failed`, so the done line never waits on a job that won't come. */
export function askStartJob(d: { starts: () => readonly AskStart[]; items: () => Pick<Items, "detail"> }) {
  const record = (workspaceId: string, itemId: string, outcome: { workKind: string; workId: string } | { refused: string }) => repo.inWorkspace(workspaceId, (tx) => repo.setStartOutcome(tx, itemId, outcome));
  return async function run(job: AskStartJob, lastTry: boolean): Promise<void> {
    const row = await repo.inWorkspace(job.workspaceId, (tx) => repo.startOf(tx, job.itemId));
    if (!row || row.workKind || row.refused) return;
    const seen = await d.items().detail(job.workspaceId, job.itemId);
    const p = AskStartPayload.safeParse(seen?.content);
    if (!p.success) return void (await record(job.workspaceId, job.itemId, { refused: "bad_payload" }));
    const start = byId(d.starts(), p.data.start);
    const args = start?.args.safeParse(p.data.args);
    if (!start || !args?.success) return void (await record(job.workspaceId, job.itemId, { refused: "not_available" }));
    try {
      const r = await start.start(job.workspaceId, args.data, { userId: job.userId, key: job.itemId, tainted: p.data.tainted });
      await record(job.workspaceId, job.itemId, r.ok ? { workKind: r.work.kind, workId: r.work.id } : { refused: r.why });
    } catch (e) {
      if (!lastTry) throw e;
      console.error("ask: a start failed on its last try", job.itemId, e);
      await record(job.workspaceId, job.itemId, { refused: "start_failed" });
    }
  };
}
