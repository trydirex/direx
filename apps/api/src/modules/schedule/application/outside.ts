// SPDX-License-Identifier: AGPL-3.0-only
// Touches Direx didn't send. Recording one takes the Person group's lock first, the same lock a
// reservation takes, so a reservation running at the same moment either sees it or finished
// before it; a Touch reserved before it is caught by touchCheck at dispatch.
import { actionStates } from "../../ledger";
import { lockGroup } from "../../people";
import { groupMembers, inWorkspace, insertOutsideTouch, reservationsAround, type NewOutsideTouch, type OutsideTouchRow, type ScheduleTx } from "../adapters/schedule-repo";
import { CAPS, countedSlots } from "../domain/caps";

export type { NewOutsideTouch, OutsideTouchRow };

export async function recordOutsideTouch(tx: ScheduleTx, row: NewOutsideTouch): Promise<OutsideTouchRow> {
  await lockGroup(tx, row.personId);
  return insertOutsideTouch(tx, row);
}

/**
 * Whether Direx sent, or will send, this Person group a cold Touch within the gap of `at`. A person
 * about to send something by hand sees it as a warning; it never stops them.
 */
export function direxTouchNear(workspaceId: string, personId: string, at: Date): Promise<boolean> {
  return inWorkspace(workspaceId, async (tx) => {
    const gap = CAPS.general.minGapMs;
    const rows = await reservationsAround(tx, await groupMembers(tx, personId), new Date(at.getTime() - gap), new Date(at.getTime() + gap));
    const states = await actionStates(tx, [...new Set(rows.map((r) => r.actionId))]);
    return countedSlots(rows, "general", states, at).some((d) => Math.abs(d.getTime() - at.getTime()) < gap);
  });
}
