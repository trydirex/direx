// SPDX-License-Identifier: AGPL-3.0-only
// Valid output becomes proposals, and each goes through its owner's sink. A proposal is written
// down first and handed over second, outside any lock, so a crash in between is finished by the
// retry, which lands on the same key. A run that has ended accepts no more.
import { digestOf } from "../adapters/digest";
import * as repo from "../adapters/repo";
import { inWorkspace, type RunRow } from "../adapters/repo";
import type { AgentDefinition, Proposal, ProposalKind } from "../definitions/define";
import { offerTarget } from "../domain/offers";
import { isIncomplete, type RunStatus } from "../domain/states";

export const INCOMPLETE_WARNING = "came from a run that stopped before finishing";

/** A page Direx read for the run, held in memory for the sink and never stored. */
export type ReadPage = { label: "home" | "about"; url: string; text: string };
/** What produced the output, so a draft can record it. */
export type Producer = { agent: string; definitionVersion: number; promptDigest: string; routeHash: string; lessons?: string };
/** `userId` is set only when a person uses a kept draft, so a sink can say who saved it. */
export type SinkContext = { runId: string; input: unknown; tainted: boolean; pagesRead: readonly { url: string; at: Date }[]; pages: readonly ReadPage[]; producer: Producer; userId?: string };
/**
 * A code is why this proposal was refused. A null item means it was taken without one, such as a
 * plan's draft, which a person submits later. Such a sink must be safe to call twice, since nothing
 * marks it finished for a retry to see.
 */
export type SinkResult = { ok: true; itemId: string | null } | { ok: false; code: string };
export type Sink = (workspaceId: string, proposal: Proposal, context: SinkContext) => Promise<SinkResult>;

/**
 * One draft sink from each module's sinks by output key. Two modules naming one key fails at startup;
 * a key nobody names is refused, never handed to a default, so no draft lands where it doesn't belong.
 */
export function sinkByOutputKey(...byKey: Readonly<Record<string, Sink>>[]): Sink {
  const sinks = new Map<string, Sink>();
  for (const [key, sink] of byKey.flatMap((m) => Object.entries(m))) {
    if (sinks.has(key)) throw new Error(`agents: two sinks for the output key ${key}`);
    sinks.set(key, sink);
  }
  return (workspaceId, proposal, context) => sinks.get(proposal.outputKey)?.(workspaceId, proposal, context) ?? Promise.resolve({ ok: false, code: "no_sink" });
}
export type WarnItem = (workspaceId: string, itemId: string) => Promise<void>;

export type ProposalsDeps = {
  definitions: Readonly<Record<string, AgentDefinition<never>>>;
  sinks: Partial<Record<ProposalKind, Sink>>;
  warnItem: WarnItem;
  now: () => Date;
};

export function createProposals(d: ProposalsDeps) {
  return async function accept(run: RunRow, token: number, output: unknown, routeHash: string, pages: readonly ReadPage[] = []): Promise<void> {
    const producer: Producer = { agent: run.agent, definitionVersion: run.definitionVersion, promptDigest: run.promptDigest, routeHash, ...(run.lessonDigest && { lessons: run.lessonDigest }) };
    const seen = new Set<string>();
    for (const p of d.definitions[run.agent]!.proposals(output as never)) {
      const argumentsDigest = digestOf(JSON.stringify(p.body));
      const event = (tx: repo.RunTx, e: Pick<repo.NewEvent, "kind" | "outcome">) => repo.appendEvent(tx, run, { ...e, name: p.kind, argumentsDigest }, d.now());

      if (seen.has(p.outputKey)) {
        await inWorkspace(run.workspaceId, (tx) => event(tx, { kind: "rejection", outcome: "duplicate_key" }));
        continue;
      }
      seen.add(p.outputKey);

      const opened = await inWorkspace(run.workspaceId, async (tx) => {
        const live = await repo.lockRun(tx, run.id);
        if (!live || live.version !== token || live.status !== "running") return null;
        const row = await repo.recordProposal(tx, { workspaceId: run.workspaceId, runId: run.id, outputKey: p.outputKey, kind: p.kind, routeHash, at: d.now() });
        const parts = await repo.partsOf(tx, run.id);
        return { live, row, pagesRead: parts.filter((x) => x.kind === "web_page").map((x) => ({ url: x.refId, at: x.at })) };
      });
      if (!opened) return;
      if (opened.row.itemId || opened.row.rejectionCode) continue;

      const sink = d.sinks[p.kind];
      const result: SinkResult = sink
        ? await sink(run.workspaceId, p, { runId: run.id, input: opened.live.input, tainted: opened.live.tainted, pagesRead: opened.pagesRead, pages, producer })
        : { ok: false, code: "no_sink" };

      const status = await inWorkspace(run.workspaceId, async (tx) => {
        // A draft that lost to a person's save is kept for them to use or dismiss.
        const target = !result.ok && result.code === "target_changed" ? offerTarget(p.kind, opened.live.input) : null;
        if (target) await repo.openOffer(tx, run.id, p.outputKey, { ...target, body: p.body, at: d.now() });
        else if (!result.ok) await repo.settleProposal(tx, run.id, p.outputKey, { rejectionCode: result.code });
        else if (result.itemId) await repo.settleProposal(tx, run.id, p.outputKey, { itemId: result.itemId });
        await event(tx, result.ok ? { kind: "proposal", outcome: "ok" } : { kind: "rejection", outcome: result.code });
        return (await repo.readRun(tx, run.id))!.status as RunStatus;
      });
      // The run ended during the hand-over, so its end didn't see this Item.
      if (result.ok && result.itemId && isIncomplete(status)) await d.warnItem(run.workspaceId, result.itemId);
    }
  };
}
