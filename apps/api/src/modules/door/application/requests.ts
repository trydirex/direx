// SPDX-License-Identifier: AGPL-3.0-only
// What the door lets through and what it remembers (ADR 0032 rules 006 and 011). A request counts
// against its token's cap first, and only then against its Workspace's, so one busy token can't use
// up the Workspace's allowance for the others. Counts live in Postgres, one statement each, so every
// API process sees the same number. Over a cap is refused, never queued. Each request leaves one row:
// reader, outcome, time, and nothing that was asked or answered. The exception is a token past its
// cap: only its first refusal each minute leaves a row, so a flood can't grow the log without bound.
import * as repo from "../adapters/repo";

export type DoorOutcome = repo.DoorOutcome;
export type Caps = { perToken: number; perWorkspace: number };
/** Per minute; guesses until a pilot uses the door (ADR 0032, Consequences). */
export const DEFAULT_CAPS: Caps = { perToken: 60, perWorkspace: 300 };

const MINUTE_MS = 60_000;
const KEEP_MS = 10 * MINUTE_MS;

export function createRequests(d: { caps?: Caps; now?: () => Date } = {}) {
  const caps = d.caps ?? DEFAULT_CAPS;
  const now = d.now ?? (() => new Date());
  return {
    /** Counts this request; records the first refusal atomically with its suppression marker. */
    async admit(workspaceId: string, tokenId: string, reader: string): Promise<{ ok: true } | { ok: false; retryAfter: number; first: boolean }> {
      const at = now();
      const minute = new Date(Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS);
      const retryAfter = Math.max(1, Math.ceil((minute.getTime() + MINUTE_MS - at.getTime()) / 1000));
      return repo.inWorkspace(workspaceId, async (tx) => {
        await repo.pruneCounters(tx, workspaceId, new Date(minute.getTime() - KEEP_MS));
        const over = async () => {
          const first = (await repo.bumpCounter(tx, workspaceId, `refused:${tokenId}`, minute)) === 1;
          if (first) await repo.insertRequest(tx, { workspaceId, tokenId, reader, outcome: "rate_limited", at });
          return { ok: false as const, retryAfter, first };
        };
        if ((await repo.bumpCounter(tx, workspaceId, `token:${tokenId}`, minute)) > caps.perToken) return over();
        if ((await repo.bumpCounter(tx, workspaceId, "workspace", minute)) > caps.perWorkspace) return over();
        return { ok: true as const };
      });
    },

    record: (workspaceId: string, tokenId: string, reader: string, outcome: DoorOutcome) =>
      repo.inWorkspace(workspaceId, (tx) => repo.insertRequest(tx, { workspaceId, tokenId, reader, outcome, at: now() })),

    /** A token's latest requests for its page, newest first. */
    recent: (workspaceId: string, tokenId: string, limit = 20) => repo.inWorkspace(workspaceId, (tx) => repo.recentRequests(tx, tokenId, limit)),
  };
}

export type Requests = ReturnType<typeof createRequests>;
