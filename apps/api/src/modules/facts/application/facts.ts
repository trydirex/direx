// SPDX-License-Identifier: AGPL-3.0-only
// A person's direct edits, and the writes a proposal applies. Each write takes the fact's
// row lock, so a version number can't be used twice.
import { createHash } from "node:crypto";
import type { Actor } from "../../ledger";
import {
  advanceFact,
  inWorkspace,
  insertFact,
  insertVersion,
  liveInSlot,
  lockFact,
  lockLiveInSlot,
  retireFact,
  type FactsTx,
} from "../adapters/repo";
import { MAX_FACT_CHARS, sameWords, subjectOf, type Confidence, type Field, type Source } from "../domain/slots";

export type NewValue = { value: string; source: Source; confidence: Confidence };
export type SetInput = NewValue & { field: Field; subject?: string; actor: Actor; expectedVersion?: number };
export type SetResult = { ok: true; id: string; version: number } | { ok: false; reason: "blank_value" | "value_too_long" | "stale_version" | "not_found" };

const digestOf = (value: string) => createHash("sha256").update(value).digest("hex");

export async function addVersion(tx: FactsTx, workspaceId: string, id: string, version: number, v: NewValue, actor: Actor, now: Date) {
  await insertVersion(tx, workspaceId, { factId: id, version, ...v, digest: digestOf(v.value) }, actor, now);
  await advanceFact(tx, id, version, now);
}

/** Fills an empty slot. Undefined when someone else filled it first. */
export async function fillSlot(tx: FactsTx, workspaceId: string, field: Field, subject: string, v: NewValue, actor: Actor, now: Date) {
  const row = await insertFact(tx, workspaceId, field, subject, now);
  if (row) await insertVersion(tx, workspaceId, { factId: row.id, version: 1, ...v, digest: digestOf(v.value) }, actor, now);
  return row;
}

const byOf = (actor: Actor) => ("userId" in actor ? actor.userId : null);

export function factWrites({ now }: { now: () => Date }) {
  return {
    /** A person decides by editing: a new fact, or a new version of the one in this slot. */
    set(workspaceId: string, a: SetInput): Promise<SetResult> {
      const value = a.value.trim();
      if (!value) return Promise.resolve({ ok: false, reason: "blank_value" });
      if (value.length > MAX_FACT_CHARS) return Promise.resolve({ ok: false, reason: "value_too_long" });
      const v = { value, source: a.source, confidence: a.confidence };
      const subject = subjectOf(a.field, a.subject, value);
      return inWorkspace(workspaceId, async (tx): Promise<SetResult> => {
        const at = now();
        const current = await lockLiveInSlot(tx, a.field, subject);
        if (a.expectedVersion !== undefined && current?.currentVersion !== a.expectedVersion) return { ok: false, reason: "stale_version" };
        if (current) {
          // Saving what is already there, from the same source, changes nothing, so it adds no version.
          const was = await liveInSlot(tx, a.field, subject);
          if (was && sameWords(was.value, value) && was.source.kind === a.source.kind && was.source.label === a.source.label && was.confidence === a.confidence) {
            return { ok: true, id: current.id, version: current.currentVersion };
          }
          await addVersion(tx, workspaceId, current.id, current.currentVersion + 1, v, a.actor, at);
          return { ok: true, id: current.id, version: current.currentVersion + 1 };
        }
        const row = await fillSlot(tx, workspaceId, a.field, subject, v, a.actor, at);
        return row ? { ok: true, id: row.id, version: 1 } : { ok: false, reason: "stale_version" };
      });
    },

    retire(workspaceId: string, id: string, actor: Actor): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
      return inWorkspace(workspaceId, async (tx) => {
        const row = await lockFact(tx, id);
        if (!row || row.retiredAt) return { ok: false, reason: "not_found" as const };
        await retireFact(tx, id, byOf(actor), now());
        return { ok: true as const };
      });
    },
  };
}

export { byOf };
