// SPDX-License-Identifier: AGPL-3.0-only
// A run's life outside the model loop: start, admission, wakes, cancelling and ending. One wake
// handler serves every timer, since the row says what is due. Admission runs under the Workspace
// lock, so concurrent starts can't pass a cap.
import type { PgBoss } from "pg-boss";
import { utcMonth, withBudget } from "../../ledger/index";
import type { RunGate } from "../../models/index";
import { digestOf } from "../adapters/digest";
import * as repo from "../adapters/repo";
import { inWorkspace, type RunRow, type RunTx } from "../adapters/repo";
import { sendRunWake, type RunWake } from "../adapters/queue";
import { admit, DEFAULT_CAPS, EXPIRE_AFTER_MS, LEASE_MS, MAX_RECLAIMS, nextUtcDay, RUN_COST_CAP_MICROS } from "../domain/caps";
import { hasEnded, isIncomplete, type RunStatus, type WaitReason } from "../domain/states";
import type { WarnItem } from "./proposals";

/** Told when a run ends capped or starts waiting. A failed notice never changes the run. */
export type NotifyStarter = (run: RunRow, what: "capped" | "waiting") => Promise<void>;

/**
 * The Agent lessons a run carries, owned by the lessons module. `fix` runs once, at the first claim,
 * so a retry or a reclaim carries exactly what the run started with; it returns the set's digest.
 */
export type RunLessons = {
  fix: (tx: RunTx, workspaceId: string, agent: string, runId: string) => Promise<string>;
  carried: (workspaceId: string, runId: string) => Promise<{ lessonId: string; version: number; text: string }[]>;
  withdrawn: (tx: RunTx, runId: string) => Promise<boolean>;
};

/** A run ended without a result: failed, cancelled, expired, refused or at a limit. Told once, after the end commits. */
export type OnIncomplete = (run: RunRow) => Promise<void>;
export type RunsDeps = { boss: PgBoss; now: () => Date; notify: NotifyStarter; warnItem: WarnItem; lessons?: RunLessons | undefined; onIncomplete?: OnIncomplete | undefined };

/** A person's request and what a run needs to answer it, all of it from inside the Workspace. `target` is what the proposal may change, as it stood at the start. */
export type DraftInput = { request: string; brief: { kind: string; refId: string; version: string | null; text: string }[]; url?: string; person?: { id: string; text: string }; attached?: { id: string; text: string }; history?: string; target: { id: string | null; draftRevision: number } };
export type RunInput = { url: string } | { text: string } | DraftInput;
export type CancelBy = { userId: string; admin: boolean } | { source: "queued_message" | "shutdown" | "emergency_pause" };
type RunSpec = { id: string; version: number; promptRevision: string; prompt: string; tools: readonly string[]; deadlineMs: number; stepCap: number };

const CAPPED: readonly RunStatus[] = ["timed_out", "step_capped", "cost_capped"];
const WAKE_ON_FREE_SLOT = 5;
const DAY_MS = 86_400_000;

export function createRuns(d: RunsDeps) {
  const tell = (run: RunRow | null, what: "capped" | "waiting") => {
    if (run) void d.notify(run, what).catch((e) => console.error("agents: notice failed:", e));
  };

  // ponytail: runs after the end commits, so a crash right here loses this warning. Each such Item already has the untrusted warning and the run stays marked incomplete.
  async function warnIncomplete(run: RunRow | null) {
    if (!run || !isIncomplete(run.status as RunStatus)) return;
    // Whoever started it for their own work, such as a company's names, settles that work here.
    await d.onIncomplete?.(run).catch((e) => console.error("agents: incomplete hook failed:", run.id, e));
    try {
      const made = await inWorkspace(run.workspaceId, (tx) => repo.proposalsOf(tx, run.id));
      for (const p of made) if (p.itemId) await d.warnItem(run.workspaceId, p.itemId);
    } catch (e) {
      console.error("agents: incomplete warning failed:", e);
    }
  }

  const wakeAt = (tx: RunTx, run: Pick<RunRow, "workspaceId" | "id">, at: Date) => sendRunWake(d.boss, tx, { workspaceId: run.workspaceId, runId: run.id }, at);

  async function wakeNext(tx: RunTx, workspaceId: string, at: Date) {
    for (const id of await repo.nextQueued(tx, WAKE_ON_FREE_SLOT)) await wakeAt(tx, { workspaceId, id }, at);
  }

  /** Same key, same run: starting twice is one run. */
  /** `tainted` starts the run already tainted, for work asked for by a run that read untrusted text (rule 018). */
  async function start(workspaceId: string, a: { definition: RunSpec; input: RunInput; idempotencyKey: string; startedBy?: string; trigger: string; unevaluated?: boolean; tainted?: boolean }): Promise<RunRow> {
    const at = d.now();
    const def = a.definition;
    return inWorkspace(workspaceId, async (tx) => {
      const made = await repo.insertRun(tx, {
        workspaceId,
        idempotencyKey: a.idempotencyKey,
        agent: def.id,
        definitionVersion: def.version,
        promptRevision: def.promptRevision,
        promptDigest: digestOf(def.prompt),
        toolSetDigest: digestOf(JSON.stringify([...def.tools].sort())),
        trigger: a.trigger,
        startedBy: a.startedBy,
        status: "queued",
        deadlineMs: def.deadlineMs,
        stepCap: def.stepCap,
        costCapMicros: RUN_COST_CAP_MICROS,
        unevaluated: a.unevaluated ?? false,
        tainted: a.tainted ?? false,
        input: a.input,
        createdAt: at,
        updatedAt: at,
      });
      if (!made) return (await repo.runByKey(tx, a.idempotencyKey))!;
      await wakeAt(tx, made, at);
      await wakeAt(tx, made, new Date(at.getTime() + EXPIRE_AFTER_MS));
      return made;
    });
  }

  /** Decides a queued run, under the Workspace lock with its row already locked. */
  async function admission(tx: RunTx, run: RunRow, at: Date): Promise<{ claimed: RunRow | null; waiting: RunRow | null }> {
    const dayStart = new Date(nextUtcDay(at).getTime() - DAY_MS);
    const s = await repo.settingsFor(tx, run.agent);
    const caps = { ...DEFAULT_CAPS, agentConcurrent: s?.maxConcurrentRuns ?? DEFAULT_CAPS.agentConcurrent, agentDaily: s?.maxDailyRuns ?? DEFAULT_CAPS.agentDaily };
    const used = await repo.usage(tx, run.agent, dayStart);
    // A run already admitted isn't counted against the day a second time when it comes back.
    const decision = admit(run.admittedAt ? { ...used, agentToday: 0, workspaceToday: 0 } : used, caps);
    if (decision === "stay_queued") return { claimed: null, waiting: null };
    if (decision === "daily_cap") {
      const resumeAt = nextUtcDay(at);
      const waiting = await repo.transition(tx, run.id, run.version, "waiting", { statusReason: "daily_cap" satisfies WaitReason, resumeAt }, at);
      if (waiting) {
        await wakeAt(tx, waiting, resumeAt);
        await wakeAt(tx, waiting, new Date(at.getTime() + EXPIRE_AFTER_MS));
      }
      return { claimed: null, waiting };
    }
    const leaseExpiresAt = new Date(at.getTime() + LEASE_MS);
    const deadlineAt = run.deadlineAt ?? new Date(at.getTime() + run.deadlineMs);
    const lessonDigest = !run.admittedAt && d.lessons ? await d.lessons.fix(tx, run.workspaceId, run.agent, run.id) : undefined;
    const claimed = await repo.transition(tx, run.id, run.version, "running", { leaseExpiresAt, deadlineAt, resumeAt: null, admittedAt: run.admittedAt ?? at, attempt: run.attempt, ...(lessonDigest !== undefined && { lessonDigest }) }, at);
    if (claimed) {
      await wakeAt(tx, claimed, leaseExpiresAt);
      await wakeAt(tx, claimed, deadlineAt);
    }
    return { claimed, waiting: null };
  }

  /** Whatever is due for this run. Returns the run to work on when this wake claimed it. */
  async function wake(p: RunWake): Promise<RunRow | null> {
    const at = d.now();
    let capped: RunRow | null = null;
    let waiting: RunRow | null = null;
    let ended: RunRow | null = null;
    const claimed = await withBudget(p.workspaceId, async ({ tx }) => {
      let run = await repo.lockRun(tx, p.runId);
      if (!run || hasEnded(run.status as RunStatus)) return null;

      const endWith = async (to: RunStatus, statusReason?: string) => {
        ended = await repo.transition(tx, run!.id, run!.version, to, { statusReason }, at);
        await wakeNext(tx, p.workspaceId, at);
        return ended;
      };

      if (run.status === "running") {
        if (run.deadlineAt && run.deadlineAt <= at) {
          capped = await endWith("timed_out");
          return null;
        }
        if (run.leaseExpiresAt && run.leaseExpiresAt > at) {
          await wakeAt(tx, run, run.leaseExpiresAt);
          return null;
        }
        if (run.reclaims >= MAX_RECLAIMS) {
          await endWith("failed", run.lastError ?? "lease_lapsed");
          return null;
        }
        run = (await repo.transition(tx, run.id, run.version, "queued", { attempt: run.attempt + 1, reclaims: run.reclaims + 1, leaseExpiresAt: null, retries: 0 }, at))!;
      } else {
        // A re-enqueued run past its deadline timed out; it didn't merely expire.
        if (run.status === "queued" && run.deadlineAt && run.deadlineAt <= at) {
          capped = await endWith("timed_out");
          return null;
        }
        if (run.updatedAt.getTime() + EXPIRE_AFTER_MS <= at.getTime()) {
          await endWith("expired");
          return null;
        }
        if (run.resumeAt && run.resumeAt > at) return null;
        if (run.status === "waiting") {
          // A resume gets a fresh deadline: the wait wasn't the run's time to spend.
          run = (await repo.transition(tx, run.id, run.version, "queued", { deadlineAt: null, resumeAt: null }, at))!;
          // A lesson withdrawn during the wait may have been a bad one, so the run doesn't carry on with it.
          if (await d.lessons?.withdrawn(tx, run.id)) {
            await endWith("refused", "lesson_withdrawn");
            return null;
          }
        }
      }
      const decided = await admission(tx, run, at);
      waiting = decided.waiting;
      return decided.claimed;
    });
    tell(capped, "capped");
    tell(waiting, "waiting");
    await warnIncomplete(ended);
    return claimed;
  }

  /** Ends a run from its worker. Null when the claim was already gone. */
  async function end(run: RunRow, token: number, to: RunStatus, statusReason?: string): Promise<RunRow | null> {
    const at = d.now();
    const ended = await inWorkspace(run.workspaceId, async (tx) => {
      const row = await repo.transition(tx, run.id, token, to, { statusReason }, at);
      if (row) await wakeNext(tx, run.workspaceId, at);
      return row;
    });
    if (CAPPED.includes(to)) tell(ended, "capped");
    await warnIncomplete(ended);
    return ended;
  }

  /** Budget stopped: wait for the month to turn, on the same row. */
  async function waitForBudget(run: RunRow, token: number): Promise<void> {
    const at = d.now();
    const resumeAt = utcMonth(at).end;
    const waiting = await inWorkspace(run.workspaceId, async (tx) => {
      const row = await repo.transition(tx, run.id, token, "waiting", { statusReason: "budget_stop" satisfies WaitReason, resumeAt, leaseExpiresAt: null }, at);
      if (row) {
        await wakeAt(tx, row, resumeAt);
        await wakeAt(tx, row, new Date(at.getTime() + EXPIRE_AFTER_MS));
        await wakeNext(tx, run.workspaceId, at);
      }
      return row;
    });
    tell(waiting, "waiting");
  }

  /** A long wait before a retry: release the claim and come back later. This isn't a reclaim. */
  async function requeue(run: RunRow, token: number, resumeAt: Date, retries: number, attempt: number): Promise<void> {
    const at = d.now();
    await inWorkspace(run.workspaceId, async (tx) => {
      const row = await repo.transition(tx, run.id, token, "queued", { resumeAt, retries, attempt, leaseExpiresAt: null }, at);
      if (row) {
        await wakeAt(tx, row, resumeAt);
        await wakeNext(tx, run.workspaceId, at);
      }
    });
  }

  async function cancel(workspaceId: string, runId: string, by: CancelBy, reason?: string) {
    const at = d.now();
    let ended: RunRow | null = null;
    const result = await inWorkspace(workspaceId, async (tx) => {
      const run = await repo.lockRun(tx, runId);
      if (!run) return { ok: false, reason: "not_found" } as const;
      const person = "userId" in by ? by : null;
      if (person && !person.admin && run.startedBy !== person.userId) return { ok: false, reason: "not_allowed" } as const;
      if (hasEnded(run.status as RunStatus)) return { ok: false, reason: "already_ended" } as const;
      await repo.recordCancellation(tx, {
        workspaceId,
        runId,
        source: person ? (run.startedBy === person.userId ? "person" : "admin") : (by as { source: string }).source,
        who: person?.userId ?? null,
        reason,
        at,
      });
      ended = await repo.transition(tx, runId, run.version, "cancelled", {}, at);
      await wakeNext(tx, workspaceId, at);
      return { ok: true } as const;
    });
    await warnIncomplete(ended);
    return result;
  }

  /** What models asks before each call: is this claim still live, and is the run tainted? */
  const runGate: RunGate = (workspaceId, runId, claimToken) =>
    inWorkspace(workspaceId, async (tx) => {
      const run = await repo.readRun(tx, runId);
      if (!run) return { live: false, tainted: true };
      return { live: run.status === "running" && String(run.version) === claimToken, tainted: run.tainted };
    });

  return { start, wake, end, waitForBudget, requeue, cancel, runGate };
}

export type Runs = ReturnType<typeof createRuns>;
