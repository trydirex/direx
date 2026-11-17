// SPDX-License-Identifier: AGPL-3.0-only
// The status write-back sweep (ADR 0025 rule 006). For each source with a live yes, each imported
// row whose post's state has a mapped option it doesn't show yet gets one new generation: a ledger
// Action approved in the granter's name, with the grant bound. A newer generation cancels an older
// one not yet out, and the Dispatcher Blocks an older one as superseded. Sent writes are recorded
// on the row, so the next sweep and the import know what Direx itself wrote.
import { storedSpec } from "@direx/plugin-sdk/host";
import { z } from "zod";
import type { Actor, Ledger, SnapshotEntry } from "../../ledger/index";
import { inWorkspace, postUrl, recordWritten, rowByKey, rowsWithWrites, setWrite, sourceById, sources, type DocsTx, type SourceRow } from "../adapters/repo";
import { stateOfWrite, writeBackProblem, writeStateOf, type WriteBack } from "../domain/write-back";
import { bindingIn, stopIn, WRITE_KEY } from "./grant";
import { reader, type ReadDeps } from "./read";

const ACTOR: Actor = { system: "docs" };
/** A write-back held this long is cancelled, so none waits on anyone (rule 007) [DEFAULT]. */
export const HELD_FOR_MS = 24 * 60 * 60_000;
const PENDING = ["draft", "needs_approval", "scheduled", "claimed", "held"];

export type WriteBackDeps = ReadDeps & {
  ledger: () => Pick<Ledger, "createActionIn" | "submitForApproval" | "approve" | "getAction" | "cancel" | "cancelPendingByIds">;
  prepare: (workspaceId: string, capability: string, input: unknown) => Promise<{ spec: unknown }>;
  capabilityVersion: (capability: string) => string | null | undefined;
  /** The post's visible state, as the Calendar shows it. */
  postOf: (workspaceId: string, itemId: string) => Promise<{ state: string } | undefined>;
  now?: () => Date;
};

/** Records each sent write-back on its row: the option, the state it stands for and the edit time it made. */
export async function settleIn(tx: DocsTx, source: SourceRow, at: Date): Promise<void> {
  const w = source.writeBack as WriteBack | null;
  for (const { row, action } of await rowsWithWrites(tx, source.id)) {
    if (action?.state !== "sent") continue;
    const spec = storedSpec("docs.row.update", action.spec);
    // Every write Direx prepared names its option; one that doesn't wrote nothing Direx can record.
    if (spec.optionId === undefined) continue;
    const editedAt = action.providerRef && !isNaN(Date.parse(action.providerRef)) ? new Date(action.providerRef) : null;
    if (row.writtenOptionId === spec.optionId && row.writtenEditedAt?.getTime() === editedAt?.getTime()) continue;
    await recordWritten(tx, source.id, row.externalId, { writtenState: w ? stateOfWrite(w, spec.optionId, Boolean(spec.url)) : null, writtenOptionId: spec.optionId, writtenEditedAt: editedAt, now: at });
  }
}

export function createWriteBack(deps: WriteBackDeps) {
  const now = deps.now ?? (() => new Date());
  const { connection, ask } = reader(deps);

  /** Submits and approves a write-back in its granter's name; a rerun picks up where it stopped. */
  async function approve(workspaceId: string, actionId: string, binding: { approverId: Parameters<Ledger["approve"]>[2]["approverId"]; snapshot: SnapshotEntry[] }) {
    const ledger = deps.ledger();
    let action = await ledger.getAction(workspaceId, actionId);
    if (action?.state === "draft") {
      const submitted = await ledger.submitForApproval(workspaceId, actionId, ACTOR);
      action = submitted.ok ? submitted.action : undefined;
    }
    if (action?.state !== "needs_approval") return false;
    return (await ledger.approve(workspaceId, actionId, { approverId: binding.approverId, draftVersion: action.draftVersion, snapshot: binding.snapshot })).ok;
  }

  /** One source's pass: settles what was sent, then writes each row's newest mapped state once. */
  async function source(workspaceId: string, sourceId: string): Promise<{ written: number; stopped?: string }> {
    const at = now();
    const found = await inWorkspace(workspaceId, async (tx) => {
      const s = await sourceById(tx, sourceId);
      if (!s) return null;
      await settleIn(tx, s, at);
      return { s, binding: await bindingIn(tx, s) };
    });
    if (!found?.binding) return { written: 0 };
    const { s, binding } = found;
    const w = s.writeBack as WriteBack;
    const stop = async (reason: string) => {
      await inWorkspace(workspaceId, (tx) => stopIn(tx, deps.ledger(), sourceId, { stoppedBy: null, reason, at }));
      return { written: 0, stopped: reason };
    };
    // Another key on the connection than the one the yes was for: the yes ends (rule 001).
    const c = await connection(workspaceId);
    if (!c || c.credentialId !== s.credentialId) return stop("credential_changed");
    const capability = c.provider.write;
    if (!c.provider.rows || !capability) return { written: 0 };
    // The options still exist in the database (rule 003); a failed read waits for the next pass.
    const schema = await ask(workspaceId, c, c.provider.rows, { sourceId: s.externalId });
    if (!schema.ok) return { written: 0 };
    if (writeBackProblem(w, schema.out.columns)) return stop("mapping_no_longer_fits");
    const version = deps.capabilityVersion(capability);
    const snapshot: SnapshotEntry[] = [...binding.snapshot, ...(version ? [{ kind: "capability", id: capability, version }] : [])];

    let written = 0;
    for (const { row, action: a } of await inWorkspace(workspaceId, (tx) => rowsWithWrites(tx, sourceId))) {
      // Held is shown on the source, then cancelled: at once when late, otherwise after a day (rule 007).
      if (a?.state === "held" && a.holdReason !== "outcome_unknown" && (a.holdReason === "late" || at.getTime() - a.updatedAt.getTime() >= HELD_FOR_MS)) {
        await deps.ledger().cancel(workspaceId, a.id, ACTOR);
        continue;
      }
      const post = await deps.postOf(workspaceId, row.itemId);
      const state = post && writeStateOf(post.state);
      const optionId = state && w.options[state];
      if (!optionId) continue;
      const url = state === "sent" && w.urlPropertyId ? await inWorkspace(workspaceId, (tx) => postUrl(tx, row.itemId)) : null;
      if (row.writtenOptionId === optionId && (!url || row.writtenState === "sent")) continue;
      // This state is already on its way, or ended Blocked or cancelled, which the source shows: not again.
      if (a && a.state !== "sent" && storedSpec("docs.row.update", a.spec).optionId === optionId) continue;
      // A newer state supersedes a write not yet out.
      if (a && PENDING.includes(a.state)) await deps.ledger().cancel(workspaceId, a.id, ACTOR);
      const input = { pageId: row.externalId, statusPropertyId: w.statusPropertyId, statusType: w.statusType, optionId, lastOptionId: row.writtenOptionId, ...(url && { urlPropertyId: w.urlPropertyId, url }) };
      const spec = await deps.prepare(workspaceId, capability, input).then((p) => p.spec, () => null);
      if (!spec) continue;
      const actionId = await inWorkspace(workspaceId, async (tx) => {
        const locked = await rowByKey(tx, sourceId, row.externalId, true);
        // Another pass moved this row on meanwhile.
        if (!locked || locked.generation !== row.generation) return null;
        const generation = row.generation + 1;
        const { action } = await deps.ledger().createActionIn(tx, workspaceId, { idempotencyKey: `${WRITE_KEY}:${sourceId}:${row.externalId}:${generation}`, capability, dedupe: "queryable", spec, credentialId: s.credentialId, actor: ACTOR });
        await setWrite(tx, sourceId, row.externalId, { generation, writeActionId: action.id, now: at });
        return action.id;
      });
      if (actionId && (await approve(workspaceId, actionId, { approverId: binding.approverId, snapshot }))) written++;
    }
    return { written };
  }

  return {
    source,
    /** Every source of the Workspace with a write-back mapping. */
    async workspace(workspaceId: string): Promise<number> {
      let written = 0;
      for (const s of await inWorkspace(workspaceId, sources)) if (s.writeBack) written += (await source(workspaceId, s.id)).written;
      return written;
    },
  };
}
export type WriteBackSweep = ReturnType<typeof createWriteBack>;
