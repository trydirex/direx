// SPDX-License-Identifier: AGPL-3.0-only
// The module's parts put together, apart from index.ts so routes can name the type.
import { APPROVAL_TTL_MS, type Ledger } from "../../ledger";
import { countWaiting, decisionsOf, inWorkspace, needsYouSummary, stepEditPhrases, stepReasons, type ItemsTx } from "../adapters/repo";
import { reviewRates } from "../domain/rates";
import { changes } from "./changes";
import { followLater, LATE_KIND, lateSends } from "./late";
import { decisions, type DescribeChange, type EditOf, type OnApplied } from "./decide";
import { itemStore, type AppearanceFor, type ItemKind, type RecipientFor, type RuleApproval } from "./items";
import { moves, type MoveStep } from "./move";

/** One notice per Workspace while its Actions are held because another root key wrapped its data key. */
export const KEYS_LOST_KIND = "keys_lost";
const KEYS_LOST_TITLE =
  "Emails and posts here are held: this Workspace's keys were set up under another root key, and only whoever runs this Direx can restore it. Once they have, approve this to send them";

/**
 * Approving it resumes every Action held for its keys, each through the claim again, in the approval's
 * own transaction. It sends many at once, so it needs a recent sign-in, which also keeps any grant from
 * applying it. An Action whose capability needs its own permission is left for its own Item.
 */
const keysLostKind = (ledger: Ledger, actionPermission: ((capability: string) => string | undefined) | undefined): Record<string, ItemKind> => ({
  [KEYS_LOST_KIND]: {
    permission: "item.approve",
    bulk: false,
    stepUp: true,
    async apply(tx, item, actor) {
      await ledger.resumeAllHeldIn(tx, item.workspaceId, "keys_unavailable", actor, (capability) => actionPermission?.(capability) !== undefined);
      return { ok: true };
    },
  },
});

export function createItems(deps: { ledger: Ledger; kinds?: Record<string, ItemKind>; now?: () => Date; onMoveStep?: (step: MoveStep) => void | Promise<void>; describeChange?: DescribeChange; onSubmitted?: (workspaceId: string, itemId: string) => Promise<void>; onApproved?: (workspaceId: string, itemId: string) => Promise<void>; onApplied?: OnApplied; ruleApprovalBy?: (workspaceId: string, actionId: string) => Promise<RuleApproval | null>; recipient?: RecipientFor; appearance?: AppearanceFor; actionPermission?: (capability: string) => string | undefined; mayGrant?: (tx: ItemsTx, userId: string) => Promise<boolean>; editOf?: EditOf }) {
  const now = deps.now ?? (() => new Date());
  const late = lateSends({ ledger: deps.ledger, now, settleGroupIn: (...a) => store.settleGroupIn(...a), actionPermission: deps.actionPermission });
  const kinds = { ...keysLostKind(deps.ledger, deps.actionPermission), ...late.kind, ...deps.kinds };
  const store = itemStore({ ledger: deps.ledger, kinds, now, onSubmitted: deps.onSubmitted, ruleApprovalBy: deps.ruleApprovalBy, recipient: deps.recipient, appearance: deps.appearance });
  // The late notice refreshes after its own approval commits, then whatever the caller wired runs.
  const onApplied: OnApplied = async (workspaceId, item) => {
    if (item.kind === LATE_KIND) await inWorkspace(workspaceId, (tx) => late.afterApplied(tx, workspaceId, item.id));
    await deps.onApplied?.(workspaceId, item);
  };
  return {
    ...store,
    ...decisions({ ledger: deps.ledger, kinds, now, describeChange: deps.describeChange, onApproved: deps.onApproved, onApplied, actionPermission: deps.actionPermission, mayGrant: deps.mayGrant, editOf: deps.editOf, resumeLate: (workspaceId, actionId, actor) => inWorkspace(workspaceId, (tx) => late.resumeLateIn(tx, workspaceId, actionId, actor)) }),
    ...moves({ ledger: deps.ledger, now, onStep: deps.onMoveStep }),
    /** How many of these Items, made without an Action, still wait for a person; for the door's caps. */
    waitingAmong: (workspaceId: string, itemIds: readonly string[]) => inWorkspace(workspaceId, (tx) => countWaiting(tx, itemIds)),
    /** Item state changes since a cursor, oldest first, for the door's read_changes. */
    changes,
    /** A reviewer's own pace and change rate, from decisions they made on the review page. */
    reviewRates: async (workspaceId: string, reviewerId: string) => reviewRates(await inWorkspace(workspaceId, (tx) => decisionsOf(tx, reviewerId, 100))),
    /** How many Items wait in Needs you and when the next one is due, for the review feed. */
    waitingSummary: (workspaceId: string) => inWorkspace(workspaceId, (tx) => needsYouSummary(tx, now(), APPROVAL_TTL_MS)),
    /** Every recorded edit phrase on one Campaign step's drafts, for spotting an edit a person keeps making. */
    stepEditPhrases: (workspaceId: string, campaignId: string, stepKey: string) => inWorkspace(workspaceId, (tx) => stepEditPhrases(tx, campaignId, stepKey)),
    /** Every reason given on one Campaign step's drafts, for spotting one that keeps coming up. */
    stepReasons: (workspaceId: string, campaignId: string, stepKey: string) => inWorkspace(workspaceId, (tx) => stepReasons(tx, campaignId, stepKey)),
    /** For the ledger's later hook: an email moved on from a Mailbox day already sent takes its new places. */
    followLater: (workspaceId: string, actionId: string, at: Date) => followLater(workspaceId, actionId, at, now()),
    /** For the ledger's late hook: the Workspace's late notice as things stand. */
    refreshLateIn: (tx: ItemsTx, workspaceId: string) => late.refreshIn(tx, workspaceId),
    /** For the ledger's keys-lost hook: opens the Workspace's notice, or leaves the open one as it is. */
    openKeysLostIn: (tx: ItemsTx, workspaceId: string) =>
      store.settleGroupIn(tx, workspaceId, { kind: KEYS_LOST_KIND, groupKey: `${KEYS_LOST_KIND}:${workspaceId}`, actor: { system: "ledger" }, next: { payload: {}, details: { title: KEYS_LOST_TITLE, workArea: "outreach", warnings: [] } } }),
  };
}
export type Items = ReturnType<typeof createItems>;
