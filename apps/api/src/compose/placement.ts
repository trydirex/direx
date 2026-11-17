// SPDX-License-Identifier: AGPL-3.0-only
// Placement checks on the worker side, self-hosted only. Each Mailbox's day is made at 06:00 UTC, before
// the 09:00 to 17:00 send window, with the checks it sends, those it expects and its reports; a check
// still unsent 30 minutes after its time is cancelled, and an expected one is read two hours after.
// Each queue, schedule and consumer goes through `later` (ADR 0027 rule 001).
import type { PgBoss } from "pg-boss";
import type { Later } from "./sweeps";

export const PLACEMENT_DAILY = "placement.daily";
export const PLACEMENT_SWEEP = "placement.sweep";

type Mailbox = { workspaceId: string; credentialId: string };

export function placementJobs(d: {
  boss: Pick<PgBoss, "createQueue" | "schedule" | "work">;
  later: Later;
  /** The connections a Mailbox can be on, and the active Mailboxes among them. */
  connections: () => string[];
  connected: (connections: string[]) => Promise<Mailbox[]>;
  sending: { daily: (workspaceId: string, credentialId: string) => Promise<unknown>; cancelLate: (workspaceId: string) => Promise<unknown> };
  reading: { plan: (workspaceId: string, credentialId: string) => Promise<unknown>; readDue: (workspaceId: string) => Promise<unknown> };
  reporting: { daily: (workspaceId: string, credentialId: string) => Promise<unknown> };
}) {
  const { boss, later } = d;
  const mailboxes = () => d.connected(d.connections());
  later(() => boss.createQueue(PLACEMENT_DAILY));
  later(() => boss.schedule(PLACEMENT_DAILY, "0 6 * * *"));
  later(() =>
    boss.work(PLACEMENT_DAILY, async () => {
      for (const m of await mailboxes()) {
        await d.sending.daily(m.workspaceId, m.credentialId);
        await d.reading.plan(m.workspaceId, m.credentialId);
        // Yesterday's verdicts, read by now, go to their senders.
        await d.reporting.daily(m.workspaceId, m.credentialId);
      }
    }),
  );
  later(() => boss.createQueue(PLACEMENT_SWEEP));
  later(() => boss.schedule(PLACEMENT_SWEEP, "*/5 * * * *"));
  later(() =>
    boss.work(PLACEMENT_SWEEP, async () => {
      for (const workspaceId of new Set((await mailboxes()).map((m) => m.workspaceId))) {
        await d.sending.cancelLate(workspaceId);
        await d.reading.readDue(workspaceId);
      }
    }),
  );
}
