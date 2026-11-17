// SPDX-License-Identifier: AGPL-3.0-only
// What every surface sees of an Item: one state, one reason, in one shape.
import type { JoinedItem } from "../adapters/repo";
import { reasonLabel } from "../domain/reasons";
import { canMove, detailsStale, isClean, visibleState, type OwnState, type VisibleState } from "../domain/state";
import type { Warning } from "../domain/warnings";

export type ItemView = {
  id: string;
  kind: string;
  state: VisibleState;
  reason: string | null;
  reasonCode: string | null;
  /** The approve request sends this back: what the person actually saw. */
  revision: number;
  title: string;
  workArea: string | null;
  channel: string | null;
  groupKey: string | null;
  groupLabel: string | null;
  /** The approved send time once there is one, otherwise the planned one. */
  at: Date | null;
  warnings: Warning[];
  clean: boolean;
  movable: boolean;
  decideBy: Date | null;
  snoozedUntil: Date | null;
  createdAt: Date;
};

/** `bulk` false: the kind is approved one at a time, so it never counts as clean for approve-all. */
export function toView({ item, action }: JoinedItem, bulk = true): ItemView {
  const raw = action ? action.state : (item.state as OwnState);
  const reasonCode = action?.holdReason ?? action?.blockReason ?? null;
  const warnings = item.warnings as Warning[];
  return {
    id: item.id,
    kind: item.kind,
    state: visibleState(raw),
    reason: reasonCode ? reasonLabel(reasonCode, action?.reasonDetail) : raw === "needs_approval" ? item.ruleNote : null,
    reasonCode,
    revision: action ? action.draftVersion : item.version,
    title: item.title,
    workArea: item.workArea,
    channel: item.channel,
    groupKey: item.groupKey,
    groupLabel: item.groupLabel,
    at: action?.dueAt ?? item.plannedAt,
    warnings,
    clean: bulk && isClean(warnings, action ? detailsStale(item.describedDraftVersion!, action.draftVersion) : false),
    movable: canMove(raw, reasonCode),
    decideBy: action?.decideBy ?? item.decideBy,
    snoozedUntil: action?.snoozedUntil ?? item.snoozedUntil,
    createdAt: item.createdAt,
  };
}
