// SPDX-License-Identifier: AGPL-3.0-only
// A Mailbox's pace, set by whoever connects it and changed afterwards only by someone who manages
// credentials, every change recorded; and the Workspace time zone its days and hours are in.
import { inWorkspace } from "../adapters/schedule-repo";
import { lockPace, paceEverSet, paceOf, setWorkspaceZone, workspaceZone, writePace } from "../adapters/mailbox-repo";
import type { MailboxPace } from "../domain/mailbox";

export type PaceRefusal = "not_found" | "forbidden" | "bad_pace";

const validPace = (p: MailboxPace) =>
  Number.isInteger(p.dailyLimit) && p.dailyLimit >= 1 && p.dailyLimit <= 500 && Number.isInteger(p.sendFrom) && Number.isInteger(p.sendUntil) && p.sendFrom >= 0 && p.sendFrom < p.sendUntil && p.sendUntil <= 1440;

/** A Mailbox's pace as set, without a new Mailbox's ramp, and the Workspace time zone it is read in, or null when there is no such Mailbox. */
export function mailboxPace(workspaceId: string, credentialId: string) {
  return inWorkspace(workspaceId, (tx) => paceOf(tx, credentialId, false)).then((r) => r ?? null);
}

/**
 * Sets a Mailbox's pace. The Member who connected it may set the first values; after that, and for
 * anyone else, it needs `credential.manage`.
 */
export function setMailboxPace(workspaceId: string, credentialId: string, next: MailboxPace, who: { userId: string; mayManage: boolean }, at = new Date()): Promise<{ ok: true } | { ok: false; reason: PaceRefusal }> {
  if (!validPace(next)) return Promise.resolve({ ok: false, reason: "bad_pace" });
  return inWorkspace(workspaceId, async (tx) => {
    const found = await lockPace(tx, credentialId);
    if (!found) return { ok: false, reason: "not_found" } as const;
    const firstByConnector = found.createdBy === who.userId && !(await paceEverSet(tx, credentialId));
    if (!who.mayManage && !firstByConnector) return { ok: false, reason: "forbidden" } as const;
    await writePace(tx, workspaceId, credentialId, found.pace, next, who.userId, at);
    return { ok: true } as const;
  });
}

const isZone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
};

export const timeZoneOf = (workspaceId: string) => inWorkspace(workspaceId, (tx) => workspaceZone(tx, workspaceId));

/** The Workspace's time zone, an IANA name. Changing it moves nothing already planned. */
export function setTimeZone(workspaceId: string, timeZone: string): Promise<{ ok: true } | { ok: false; reason: "bad_time_zone" }> {
  if (!isZone(timeZone)) return Promise.resolve({ ok: false, reason: "bad_time_zone" });
  return inWorkspace(workspaceId, async (tx) => {
    await setWorkspaceZone(tx, workspaceId, timeZone);
    return { ok: true } as const;
  });
}
