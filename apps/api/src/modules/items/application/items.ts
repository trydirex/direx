// SPDX-License-Identifier: AGPL-3.0-only
// Creating, revising and reading Items. An Action is always created and revised through its
// Item, so no Action exists that a person can't see.
import type { DedupeClass } from "@direx/plugin-sdk";
import type { Actor, Ledger } from "../../ledger";
import { reserveMailboxIn } from "../../schedule";
import {
  addOwnWarning,
  inWorkspace,
  insertActionItem,
  insertOwnItem,
  listItemEvents,
  listItems,
  lockLiveGroup,
  lockOwnItem,
  moveOwnState,
  itemIdByAction,
  readItem,
  readWrittenFrom,
  reviseOwnContent,
  setItemWarnings,
  setOwnTriage,
  updateActionDetails,
  type ItemRow,
  type ItemsTx,
  type JoinedItem,
  type ListFilter,
  type NewDetails,
} from "../adapters/repo";
import { reasonLabel } from "../domain/reasons";
import { visibleState, type LedgerState, type OwnState, type VisibleState } from "../domain/state";
import { sameWarning, type Warning } from "../domain/warnings";
import { toView, type ItemView } from "./view";

/**
 * A later module's Item kind. apply runs in the state change's transaction, so the two can't
 * split. choice is for a kind whose approval has more than one answer.
 */
export type ItemKind = {
  permission: string;
  /** Refuses stale source data inside creation, after locking a replacement group. */
  canCreate?: (tx: ItemsTx, payload: unknown) => Promise<boolean>;
  /** The permission for this one Item, when it depends on what the Item asks for, such as an Ask start needing its button's permission. */
  permissionOf?: (item: ItemRow) => string;
  /** False when only a person's own approval may apply it, never a grant given earlier. */
  grant?: boolean;
  apply: (tx: ItemsTx, item: ItemRow, actor: Actor, choice?: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Approval leaves it Scheduled, because a person still has something to do by hand. */
  waitsForPerson?: boolean;
  /** Approving it needs a recent sign-in. */
  stepUp?: boolean;
  /** False when it must be read and approved on its own, never with "approve all clean". */
  bulk?: boolean;
  /** False when a person must pick one of its answers: Dismiss is refused, so nothing is left waiting on it. */
  dismiss?: boolean;
  /**
   * Reverses what applying it did, with an action a person could take by hand, while nothing has changed
   * since. check says whether it still can; apply checks again and does it, as the person undoing.
   */
  undo?: { permission: string; check: (item: ItemRow) => Promise<Undone>; apply: (item: ItemRow, actor: Actor) => Promise<Undone> };
};
export type Undone = { ok: true } | { ok: false; reason: string };

export type TimelineEntry = { at: Date; from: VisibleState | null; to: VisibleState; reason: string | null; actor: { kind: "person" | "agent" | "system"; id: string }; dispatchGapMs?: number | null };

/** What is known about an email's recipient beyond the email, for whoever approves it. Never part of the Action. */
/** `spans` splits the email into words that match its step's email and words that don't; null when there's nothing to compare with. */
export type RecipientNotes = { signals: { type: string; quote: string; pageUrl: string; observedOn: string }[]; roleAddress: boolean; guessedAddress: boolean; spans?: { text: string; kind: "same" | "added" }[] | null };
export type RecipientFor = (workspaceId: string, spec: unknown, itemId: string) => Promise<RecipientNotes | null>;

/** Who turned on the rule that approved an Action, and which drafter wrote it when no one read it. */
export type RuleApproval = { by: string; writtenBy: string | null };
/** How an Item shows as what it will be: the Mailbox an email goes from, or the account and network a
    post goes out as. Read when the Item is viewed, never part of the Action. */
export type Appearance =
  | { kind: "email"; from: string }
  | { kind: "post"; account: string | null; network: string; link: { url: string; title: string | null; description: string | null; site: string; image: boolean } | null };
/** How an Item's content will appear where it goes; `content` is what the Item carries, so a post's text can be read. */
export type AppearanceFor = (workspaceId: string, a: { itemId: string; workArea: string | null; credentialId: string | null; content: unknown }) => Promise<Appearance | null>;
export type ItemsDeps = { ledger: Ledger; kinds: Record<string, ItemKind>; now: () => Date; onSubmitted?: ((workspaceId: string, itemId: string) => Promise<void>) | undefined; ruleApprovalBy?: ((workspaceId: string, actionId: string) => Promise<RuleApproval | null>) | undefined; recipient?: RecipientFor | undefined; appearance?: AppearanceFor | undefined };

const actorOf = (e: { actorUserId: string | null; actorAgentRunId: string | null; actorSystem: string | null }): TimelineEntry["actor"] =>
  e.actorUserId ? { kind: "person", id: e.actorUserId } : e.actorAgentRunId ? { kind: "agent", id: e.actorAgentRunId } : { kind: "system", id: e.actorSystem! };

const STEP_GROUP = /^campaign:([^:]+):step:(.+)$/;
export type WrittenFrom = {
  run: { id: string; agent: string; at: Date } | null;
  planId: string | null;
  step: { campaignId: string; stepKey: string } | null;
  facts: { id: string; version: number; text: string }[];
  /** The Lessons its Run was given, as it read them. */
  lessons: { id: string; text: string }[];
  /** Its Run was given the Workspace's Tone. */
  voice: boolean;
};
/** What a draft was written from, as recorded, or null when nothing was: a person's own Item has no source to show. */
async function writtenFrom(workspaceId: string, item: ItemRow): Promise<WrittenFrom | null> {
  const cited = ((item.snapshot ?? []) as { kind: string; id: string; version: string }[]).filter((e) => e.kind === "fact").map((e) => ({ id: e.id, version: Number(e.version) }));
  const read = await inWorkspace(workspaceId, (tx) => readWrittenFrom(tx, item.id, cited));
  const m = item.groupKey ? STEP_GROUP.exec(item.groupKey) : null;
  const step = m ? { campaignId: m[1]!, stepKey: m[2]! } : null;
  if (!read.run && !step && !read.facts.length) return null;
  return { run: read.run, planId: read.planId, step, facts: read.facts.map((f) => ({ id: f.id, version: f.version, text: f.value })), lessons: read.lessons, voice: read.voice };
}

type SettleGroup = { kind: string; groupKey: string; actor: Actor; next: { payload: unknown; details: Omit<NewDetails, "groupKey">; decideBy?: Date } | null };

export function itemStore({ ledger, kinds, now, onSubmitted, ruleApprovalBy, recipient, appearance }: ItemsDeps) {
  async function settleGroupIn(tx: ItemsTx, workspaceId: string, a: SettleGroup) {
    if (!kinds[a.kind]) throw new Error(`items: unknown kind ${a.kind}`);
    const live = await lockLiveGroup(tx, workspaceId, a.kind, a.groupKey);
    if (a.next && live.length === 1 && live[0]!.title === a.next.details.title) {
      // The same words, but the date it's due by can still move, as when a launch moves.
      if (a.next.decideBy) await setOwnTriage(tx, live[0]!.id, { decideBy: a.next.decideBy });
      return { ok: true, changed: false, itemId: live[0]!.id } as const;
    }
    for (const old of live) await moveOwnState(tx, old, "cancelled", a.actor, now());
    let itemId: string | null = null;
    if (a.next) {
      const row = await insertOwnItem(tx, workspaceId, { kind: a.kind, state: "needs_approval", payload: a.next.payload, ...a.next.details, groupKey: a.groupKey }, a.actor, now());
      if (a.next.decideBy) await setOwnTriage(tx, row.id, { decideBy: a.next.decideBy });
      itemId = row.id;
    }
    return { ok: true, changed: live.length > 0 || a.next !== null, itemId } as const;
  }

  const shown = (row: JoinedItem) => toView(row, kinds[row.item.kind]?.bulk !== false);
  const view = async (workspaceId: string, id: string): Promise<ItemView | undefined> => {
    const row = await inWorkspace(workspaceId, (tx) => readItem(tx, id));
    return row && shown(row);
  };

  // A failure here leaves it waiting for a person, which is the safe outcome.
  const announceSubmitted = async (workspaceId: string, itemId: string) => {
    await onSubmitted?.(workspaceId, itemId).catch((e) => console.error("items: onSubmitted failed", itemId, e));
  };

  type NewActionItem = { idempotencyKey: string; capability: string; dedupe: DedupeClass; spec: unknown; credentialId?: string | null; actor: Actor; details: NewDetails };
  /** The Action and its Item in the caller's transaction, so neither exists without the other. `created` is false for a repeat of the same key. */
  async function createActionItemIn(tx: ItemsTx, workspaceId: string, a: NewActionItem) {
    const { action, created } = await ledger.createActionIn(tx, workspaceId, a);
    const row = await insertActionItem(tx, workspaceId, action.id, action.draftVersion, a.details, now());
    // An email planned for a time takes its place on its Mailbox's day with it. The planner chose the
    // time from unlocked counts; ponytail: one that lost a race to the last place stays without one,
    // and its approval refuses it until it is moved.
    if (created && a.details.plannedAt) await reserveMailboxIn(tx, workspaceId, action.id, a.details.plannedAt, now());
    return { item: shown((await readItem(tx, row.id))!), created };
  }

  async function reviseActionItemIn(tx: ItemsTx, workspaceId: string, itemId: string, a: { spec: unknown; actor: Actor; details: Partial<NewDetails> & { warnings: Warning[] } }) {
    const row = await readItem(tx, itemId);
    if (!row?.item.actionId) return { ok: false, reason: "not_found" } as const;
    const r = await ledger.reviseActionIn(tx, workspaceId, row.item.actionId, a);
    if (!r.ok) return r;
    await updateActionDetails(tx, row.item.actionId, r.action.draftVersion, a.details, now());
    return { ok: true, item: shown((await readItem(tx, itemId))!) } as const;
  }

  /** `announce` says the caller owes `announceSubmitted` once its transaction commits. */
  async function submitItemIn(tx: ItemsTx, workspaceId: string, itemId: string, actor: Actor) {
    const row = await readItem(tx, itemId);
    if (!row) return { ok: false, reason: "not_found" } as const;
    if (row.item.actionId) {
      const r = await ledger.submitForApprovalIn(tx, workspaceId, row.item.actionId, actor);
      if (!r.ok) return r;
      return { ok: true, item: shown((await readItem(tx, itemId))!), announce: true } as const;
    }
    const own = await lockOwnItem(tx, itemId);
    if (own?.state !== "draft") return { ok: false, reason: "wrong_state" } as const;
    const next = await moveOwnState(tx, own, "needs_approval", actor, now());
    return next === "stale" ? ({ ok: false, reason: "stale" } as const) : ({ ok: true, item: toView({ item: next, action: null }), announce: false } as const);
  }

  async function setTriageIn(tx: ItemsTx, id: string, t: { decideBy?: Date | null; snoozedUntil?: Date | null }) {
    const row = await readItem(tx, id);
    if (!row) return false;
    if (t.decideBy === undefined && t.snoozedUntil === undefined) return true;
    if (row.item.actionId) return ledger.setTriageIn(tx, row.item.actionId, t);
    await setOwnTriage(tx, id, t);
    return true;
  }

  return {
    view,

    /** For a module that records what an Item belongs to only after it was submitted. */
    announceSubmitted,

    async createActionItem(workspaceId: string, a: NewActionItem, also?: (tx: ItemsTx, itemId: string, actionId: string) => Promise<void>): Promise<ItemView> {
      return (await inWorkspace(workspaceId, async (tx) => {
        const made = await createActionItemIn(tx, workspaceId, a);
        if (also) await also(tx, made.item.id, (await readItem(tx, made.item.id))!.item.actionId!);
        return made;
      })).item;
    },
    createActionItemIn,

    reviseActionItem: (workspaceId: string, itemId: string, a: Parameters<typeof reviseActionItemIn>[3]) => inWorkspace(workspaceId, (tx) => reviseActionItemIn(tx, workspaceId, itemId, a)),
    reviseActionItemIn,

    /** What a person should read changed, though the draft didn't, so any approval stands. */
    setWarnings: (workspaceId: string, itemId: string, warnings: Warning[]) =>
      inWorkspace(workspaceId, async (tx) => {
        await setItemWarnings(tx, itemId, warnings, now());
      }),

    /** The ledger Action behind an Item, for a module that records what the Item belongs to. */
    actionIdOf: (workspaceId: string, itemId: string) => inWorkspace(workspaceId, async (tx) => (await readItem(tx, itemId))?.item.actionId ?? null),
    /** The Item showing a ledger Action, for a module that found the Action first. */
    itemIdForAction: (workspaceId: string, actionId: string) => inWorkspace(workspaceId, (tx) => itemIdByAction(tx, actionId)),

    /** New content for a non-Action Item not yet finished. An approval it had is void, as for an Action. */
    async reviseOwnItem(workspaceId: string, itemId: string, a: { payload: unknown; details: NewDetails; actor: Actor }) {
      return inWorkspace(workspaceId, async (tx) => {
        const own = await lockOwnItem(tx, itemId);
        if (!own || own.state === "applied" || own.state === "cancelled") return { ok: false, reason: "wrong_state" } as const;
        await reviseOwnContent(tx, itemId, a.payload, a.details, now());
        const next = await moveOwnState(tx, { ...own, payload: a.payload }, "needs_approval", a.actor, now());
        return next === "stale" ? ({ ok: false, reason: "stale" } as const) : ({ ok: true, item: toView({ item: next, action: null }) } as const);
      });
    },

    /** A person did by hand what an approved non-Action Item was waiting for. */
    async finishOwnItem(workspaceId: string, itemId: string, actor: Actor, also: (tx: ItemsTx) => Promise<unknown>) {
      return inWorkspace(workspaceId, async (tx) => {
        const own = await lockOwnItem(tx, itemId);
        if (!own) return { ok: false, reason: "not_found" } as const;
        if (own.state !== "scheduled") return { ok: false, reason: "wrong_state" } as const;
        await also(tx);
        const next = await moveOwnState(tx, own, "applied", actor, now());
        return next === "stale" ? ({ ok: false, reason: "stale" } as const) : ({ ok: true, item: toView({ item: next, action: null }) } as const);
      });
    },

    /** A non-Action Item of a registered kind. With `replace`, it cancels any still waiting in its group first, so one stays. */
    async createItem(workspaceId: string, a: { kind: string; state?: "draft" | "needs_approval"; payload: unknown; actor: Actor; details: NewDetails; replace?: boolean }, also?: (tx: ItemsTx, itemId: string) => Promise<void>) {
      if (!kinds[a.kind]) return { ok: false, reason: "unknown_kind" } as const;
      if (a.replace && !a.details.groupKey) return { ok: false, reason: "group_key_required" } as const;
      const row = await inWorkspace(workspaceId, async (tx) => {
        const live = a.replace ? await lockLiveGroup(tx, workspaceId, a.kind, a.details.groupKey!) : [];
        if (kinds[a.kind]!.canCreate && !(await kinds[a.kind]!.canCreate!(tx, a.payload))) return null;
        for (const old of live) await moveOwnState(tx, old, "cancelled", a.actor, now());
        const made = await insertOwnItem(tx, workspaceId, { kind: a.kind, state: a.state ?? "needs_approval", payload: a.payload, ...a.details }, a.actor, now());
        if (also) await also(tx, made.id);
        return made;
      });
      if (!row) return { ok: false, reason: "superseded" } as const;
      return { ok: true, item: (await view(workspaceId, row.id))! } as const;
    },

    /**
     * Keeps at most one waiting Item in a group: `next`, or none. A waiting one with the same title is
     * left alone, so a refresh that finds nothing new changes nothing a person sees.
     */
    async settleGroup(workspaceId: string, a: SettleGroup) {
      if (!kinds[a.kind]) return { ok: false, reason: "unknown_kind" } as const;
      const { itemId: _, ...settled } = await inWorkspace(workspaceId, (tx) => settleGroupIn(tx, workspaceId, a));
      return settled;
    },

    /** `settleGroup` inside the caller's transaction, as when an Item's own approval asks for another. Returns the waiting Item. */
    settleGroupIn,

    /** Something learned after a non-Action Item was made. Only one still waiting for a person needs it. */
    async addWarning(workspaceId: string, itemId: string, warning: Warning) {
      await inWorkspace(workspaceId, async (tx) => {
        const own = await lockOwnItem(tx, itemId);
        if (!own || own.actionId || own.state !== "needs_approval" || (own.warnings as Warning[]).some((w) => sameWarning(w, warning))) return;
        await addOwnWarning(tx, own, warning, now());
      });
    },

    /** A finished draft goes to a person. */
    async submitItem(workspaceId: string, itemId: string, actor: Actor) {
      const r = await inWorkspace(workspaceId, (tx) => submitItemIn(tx, workspaceId, itemId, actor));
      if (!r.ok) return r;
      if (r.announce) await announceSubmitted(workspaceId, itemId);
      return { ok: true, item: r.announce ? (await view(workspaceId, itemId))! : r.item } as const;
    },
    submitItemIn,

    async list(workspaceId: string, f: Omit<ListFilter, "now">) {
      const r = await inWorkspace(workspaceId, (tx) => listItems(tx, { ...f, now: now() }));
      return { items: r.rows.map(shown), needsYouCount: r.needsYouCount };
    },

    /** One Item, what it would do, and its history with internal steps left out. */
    async detail(workspaceId: string, id: string) {
      const row = await inWorkspace(workspaceId, (tx) => readItem(tx, id));
      if (!row) return undefined;
      const entries: TimelineEntry[] = [];
      if (row.item.actionId) {
        for (const e of await ledger.getEvents(workspaceId, row.item.actionId)) {
          const from = e.fromState ? visibleState(e.fromState as LedgerState) : null;
          const to = visibleState(e.toState as LedgerState);
          if (from !== to) entries.push({ at: e.at, from, to, reason: e.reason && reasonLabel(e.reason, e.detail), actor: actorOf(e), dispatchGapMs: e.dispatchGapMs });
        }
      } else {
        for (const e of await inWorkspace(workspaceId, (tx) => listItemEvents(tx, id))) {
          const from = e.fromState ? visibleState(e.fromState as OwnState) : null;
          entries.push({ at: e.at, from, to: visibleState(e.toState as OwnState), reason: e.detail === "undone" ? "Undone" : null, actor: actorOf(e) });
        }
      }
      const action = row.item.actionId ? await ledger.getAction(workspaceId, row.item.actionId) : undefined;
      const rule = row.item.actionId ? ((await ruleApprovalBy?.(workspaceId, row.item.actionId)) ?? null) : null;
      // Read at view time, so it shows the latest signals and never becomes part of what is approved.
      const notes = action ? ((await recipient?.(workspaceId, action.spec, id)) ?? null) : null;
      const content = action ? action.spec : row.item.payload;
      // Whether what applying it did can still be undone; null when its kind has no undo or it isn't applied.
      const undoer = kinds[row.item.kind]?.undo;
      const undo = undoer && row.item.state === "applied" ? await undoer.check(row.item) : null;
      const shownAs = (await appearance?.(workspaceId, { itemId: id, workArea: row.item.workArea, credentialId: action?.credentialId ?? null, content })) ?? null;
      return { item: toView(row), content, timeline: entries, ruleGrantedBy: rule?.by ?? null, ruleWrittenBy: rule?.writtenBy ?? null, recipient: notes, appearance: shownAs, writtenFrom: await writtenFrom(workspaceId, row.item), undo };
    },

    setTriage: (workspaceId: string, id: string, t: Parameters<typeof setTriageIn>[2]) => inWorkspace(workspaceId, (tx) => setTriageIn(tx, id, t)),
    setTriageIn,
  };
}
