// SPDX-License-Identifier: AGPL-3.0-only
// Anything Direx learned by itself waits as an Item. It becomes a fact only when a person
// approves it, and only against the version it was made for.
import type { Actor } from "../../ledger";
import { warn, type ItemKind, type Items, type Warning } from "../../items";
import { inWorkspace, liveInSlot, lockFact, lockLiveInSlot, lockProposalSlot, openProposals, retireFact, type FactsTx } from "../adapters/repo";
import { MAX_FACT_CHARS, sameWords, saysTheSame, subjectOf, type Confidence, type Field, type Source } from "../domain/slots";
import { addVersion, byOf, fillSlot, type NewValue } from "./facts";

export type ProposeInput = {
  field: Field;
  subject?: string;
  value: string;
  source: Source;
  confidence: Confidence;
  /** The run that made this read something untrusted. */
  untrustedInput?: boolean;
  actor: Actor;
  /**
   * Off for a caller that must not revise an Item someone else made, such as the door (ADR 0032 rule
   * 004): a slot with a proposal already waiting is refused, naming it. On, as for agents, a new
   * reading takes the waiting one over.
   */
  takeOver?: boolean;
  /** Warnings the caller adds, with their own codes. */
  warnings?: readonly Warning[];
};

type Payload = NewValue & { field: Field; subject: string; factId?: string; baseVersion?: number };
const valueOf = (p: Payload): NewValue => ({ value: p.value, source: p.source, confidence: p.confidence });
const TARGET_CHANGED = { ok: false, reason: "target_changed" } as const;
const OK = { ok: true } as const;
const EDITED = { ok: false, reason: "edited_since" } as const;
/** The slot still holds the Fact this proposal made: its first version, with these words. */
async function unedited(tx: FactsTx, p: Payload) {
  const f = await liveInSlot(tx, p.field, p.subject);
  return f && f.currentVersion === 1 && f.value === p.value ? OK : EDITED;
}

/** The Item kinds this module applies. Registered when items is built, so items never imports facts. */
export function factKinds(now: () => Date = () => new Date()): Record<string, ItemKind> {
  return {
    fact_proposal: {
      permission: "item.approve",
      async apply(tx: FactsTx, item, actor) {
        const p = item.payload as Payload;
        if (await lockLiveInSlot(tx, p.field, p.subject)) return TARGET_CHANGED;
        return (await fillSlot(tx, item.workspaceId, p.field, p.subject, valueOf(p), actor, now())) ? OK : TARGET_CHANGED;
      },
      // Approving filled an empty slot, so undoing retires that Fact, as Brand's Remove does, while no
      // one has edited it since. Retired, not deleted: Brand's history keeps it.
      undo: {
        permission: "item.approve",
        check: (item) => inWorkspace(item.workspaceId, (tx) => unedited(tx, item.payload as Payload)),
        apply: (item, actor) =>
          inWorkspace(item.workspaceId, async (tx) => {
            const p = item.payload as Payload;
            const row = await lockLiveInSlot(tx, p.field, p.subject);
            const still = row && (await unedited(tx, p));
            if (!row || !still?.ok) return still ?? EDITED;
            await retireFact(tx, row.id, byOf(actor), now());
            return OK;
          }),
      },
    },
    fact_conflict: {
      permission: "item.approve",
      async apply(tx: FactsTx, item, actor, choice) {
        if (choice !== "keep" && choice !== "use_new" && choice !== "remove") return { ok: false, reason: "choice_required" };
        const p = item.payload as Payload;
        const row = await lockFact(tx, p.factId!);
        if (!row || row.retiredAt || row.currentVersion !== p.baseVersion) return TARGET_CHANGED;
        if (choice === "use_new") await addVersion(tx, item.workspaceId, row.id, row.currentVersion + 1, valueOf(p), actor, now());
        if (choice === "remove") await retireFact(tx, row.id, byOf(actor), now());
        return OK;
      },
    },
  };
}

const LABEL: Record<Field, string> = {
  what_you_sell: "What you sell",
  who_buys: "Who buys",
  tone: "Tone",
  price: "Prices",
  claim: "Approved claims",
  never_say: "Never say",
  competitor: "Competitors",
};

/** What `propose` answers: the Item waiting for a person, null when Brand already says it, or why not. */
export type ProposeResult =
  | { ok: true; item: NonNullable<Awaited<ReturnType<Items["view"]>>> | null }
  | { ok: false; reason: "blank_value" | "value_too_long"; itemId?: undefined }
  | { ok: false; reason: "already_waiting"; itemId: string };

export function proposals({ items }: { items: () => Items }) {
  /**
   * What one proposal should do, given what its slot holds: answer at once, or make an Item (or take a
   * waiting one over). `propose` and `proposeIn` hold the same slot lock through their Item write and commit.
   */
  async function decide(tx: FactsTx, workspaceId: string, a: ProposeInput) {
    const value = a.value.trim();
    if (!value) return { to: "refuse", answer: { ok: false, reason: "blank_value" } } as const;
    // What Direx reads is capped by its own definitions; a competitor's page quote can run longer.
    if (a.source.kind === "person" && value.length > MAX_FACT_CHARS) return { to: "refuse", answer: { ok: false, reason: "value_too_long" } } as const;
    const subject = subjectOf(a.field, a.subject, value);
    await lockProposalSlot(tx, workspaceId, a.field, subject);
    const seen = {
      current: await liveInSlot(tx, a.field, subject),
      waiting: await openProposals(tx, a.field, subject),
    };
    const first = seen.waiting[0];
    if (a.takeOver === false && first) return { to: "refuse", answer: { ok: false, reason: "already_waiting", itemId: first.id } } as const;
    // A person's new words are a real edit. Only what Direx read can be a mere rewording.
    const same = (other: string) => (a.source.kind === "person" ? sameWords(other, value) : saysTheSame(a.field, other, value));
    if (seen.current && same(seen.current.value)) return { to: "unchanged" } as const;
    // One decision per slot at a time: another read that words it differently takes over the one
    // waiting, so the person is asked once and sees the latest finding.
    const kind = seen.current ? "fact_conflict" : "fact_proposal";
    const sameWaiting = seen.waiting.find((w) => same(w.value));
    if (sameWaiting) return { to: "same", itemId: sameWaiting.id } as const;
    const waiting = a.source.kind === "person" ? undefined : seen.waiting.find((w) => w.kind === kind);

    const warnings: string[] = [];
    if (a.confidence === "low") warnings.push("low confidence");
    if (a.untrustedInput) warnings.push("came from content Direx doesn't trust");
    const payload: Payload = {
      field: a.field,
      subject,
      value,
      source: a.source,
      confidence: a.confidence,
      ...(seen.current && { factId: seen.current.id, baseVersion: seen.current.currentVersion }),
    };
    const c = seen.current;
    if (c) warnings.push(`Two values don't match: "${c.value}" from ${c.source.label}, and "${value}" from ${a.source.label}`);
    const details = { title: c ? `${LABEL[a.field]}: needs a decision` : `Add to ${LABEL[a.field]}${a.subject ? ` (${a.subject})` : ""}: "${value}"${a.source.kind === "person" ? "" : `, from ${a.source.label}`}`, workArea: "Brand", warnings: [...warnings.map((w) => warn("unspecified", w)), ...(a.warnings ?? [])] };
    return { to: "make", make: { kind, payload, details }, waiting: waiting?.id } as const;
  }

  return {
    /** The Item waiting for a person, or null when Brand already says this. */
    async propose(workspaceId: string, a: ProposeInput): Promise<ProposeResult> {
      const r = await inWorkspace(workspaceId, async (tx) => {
        const d = await decide(tx, workspaceId, a);
        if (d.to === "refuse") return d.answer;
        if (d.to === "unchanged") return { ok: true, itemId: null } as const;
        if (d.to === "same") return { ok: true, itemId: d.itemId } as const;
        if (d.waiting) {
          const revised = await items().reviseOwnItemIn(tx, d.waiting, { ...d.make, actor: a.actor });
          if (revised.ok) return { ok: true, itemId: d.waiting } as const;
        }
        const made = await items().createItemIn(tx, workspaceId, { ...d.make, actor: a.actor });
        if (!made.ok) throw new Error(`facts: ${made.reason}: the item kinds aren't registered`);
        return made;
      });
      if (!r.ok) return r;
      return { ok: true, item: r.itemId === null ? null : (await items().view(workspaceId, r.itemId))! } as const;
    },

    /**
     * `propose` inside the caller's transaction, for a caller that records the Item with something of its
     * own, as the door does (ADR 0032 rule 004). It never takes a waiting proposal over. Returns the Item's id.
     */
    async proposeIn(tx: FactsTx, workspaceId: string, a: ProposeInput & { takeOver: false }) {
      const d = await decide(tx, workspaceId, a);
      if (d.to === "refuse") return d.answer;
      if (d.to === "unchanged") return { ok: true, itemId: null } as const;
      if (d.to === "same") return { ok: true, itemId: d.itemId } as const;
      const r = await items().createItemIn(tx, workspaceId, { ...d.make, actor: a.actor });
      if (!r.ok) throw new Error(`facts: ${r.reason}: the item kinds aren't registered`);
      return { ok: true, itemId: r.itemId } as const;
    },
  };
}
