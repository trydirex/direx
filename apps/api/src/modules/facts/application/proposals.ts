// SPDX-License-Identifier: AGPL-3.0-only
// Anything Direx learned by itself waits as an Item. It becomes a fact only when a person
// approves it, and only against the version it was made for.
import type { Actor } from "../../ledger";
import { warn, type ItemKind, type Items, type Warning } from "../../items";
import { inWorkspace, liveInSlot, lockFact, lockLiveInSlot, openProposals, retireFact, type FactsTx } from "../adapters/repo";
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

export function proposals({ items }: { items: () => Items }) {
  return {
    /** The Item waiting for a person, or null when Brand already says this. */
    async propose(workspaceId: string, a: ProposeInput) {
      const value = a.value.trim();
      if (!value) return { ok: false, reason: "blank_value" } as const;
      // What Direx reads is capped by its own definitions; a competitor's page quote can run longer.
      if (a.source.kind === "person" && value.length > MAX_FACT_CHARS) return { ok: false, reason: "value_too_long" } as const;
      const subject = subjectOf(a.field, a.subject, value);
      const seen = await inWorkspace(workspaceId, async (tx) => ({
        current: await liveInSlot(tx, a.field, subject),
        waiting: await openProposals(tx, a.field, subject),
      }));
      const first = seen.waiting[0];
      if (a.takeOver === false && first) return { ok: false, reason: "already_waiting", itemId: first.id } as const;
      // A person's new words are a real edit. Only what Direx read can be a mere rewording.
      const same = (other: string) => (a.source.kind === "person" ? sameWords(other, value) : saysTheSame(a.field, other, value));
      if (seen.current && same(seen.current.value)) return { ok: true, item: null } as const;
      // One decision per slot at a time: another read that words it differently takes over the one
      // waiting, so the person is asked once and sees the latest finding.
      const kind = seen.current ? "fact_conflict" : "fact_proposal";
      const sameWaiting = seen.waiting.find((w) => same(w.value));
      if (sameWaiting) return { ok: true, item: (await items().view(workspaceId, sameWaiting.id))! } as const;
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
      if (waiting) {
        const revised = await items().reviseOwnItem(workspaceId, waiting.id, { payload, details, actor: a.actor });
        if (revised.ok) return { ok: true, item: (await items().view(workspaceId, waiting.id))! } as const;
      }
      const r = await items().createItem(workspaceId, { kind, payload, actor: a.actor, details });
      if (!r.ok) throw new Error(`facts: ${r.reason}: the item kinds aren't registered`);
      return { ok: true, item: r.item } as const;
    },
  };
}
