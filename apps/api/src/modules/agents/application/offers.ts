// SPDX-License-Identifier: AGPL-3.0-only
// A draft that lost to a person's save waits here until they use or dismiss it. Using it is their
// save: it goes through the same sink as on first arrival, against the revision they see, so every
// check runs again and a target that moved since refuses it.
import * as repo from "../adapters/repo";
import { inWorkspace } from "../adapters/repo";
import type { ProposalKind } from "../definitions/define";
import type { OfferTarget } from "../domain/offers";
import type { Sink, SinkContext } from "./proposals";

export type OfferKey = { runId: string; outputKey: string };
export type Offer = OfferKey & { kind: string; body: unknown; at: Date };
export type OfferResult = { ok: true } | { ok: false; code: string };

// A target the person can no longer save has nothing to offer to.
const GONE = new Set(["archived", "not_found"]);

export function createOffers(d: { sinks: Partial<Record<ProposalKind, Sink>>; now: () => Date }) {
  return {
    async read(workspaceId: string, target: OfferTarget): Promise<Offer | null> {
      const row = await inWorkspace(workspaceId, (tx) => repo.openOfferFor(tx, target));
      return row ? { runId: row.runId, outputKey: row.outputKey, kind: row.kind, body: row.body, at: row.at } : null;
    },

    async use(workspaceId: string, key: OfferKey, revision: number, userId: string): Promise<OfferResult> {
      const found = await inWorkspace(workspaceId, async (tx) => {
        const offer = await repo.lockProposal(tx, key.runId, key.outputKey);
        if (offer?.offer !== "open") return null;
        const run = (await repo.readRun(tx, key.runId))!;
        const pagesRead = (await repo.partsOf(tx, run.id)).filter((x) => x.kind === "web_page").map((x) => ({ url: x.refId, at: x.at }));
        return { offer, run, pagesRead };
      });
      if (!found) return { ok: false, code: "offer_closed" };
      const { offer, run, pagesRead } = found;
      const sink = d.sinks[offer.kind as ProposalKind];
      if (!sink) return { ok: false, code: "no_sink" };

      const input = run.input as { target: Record<string, unknown> };
      const context: SinkContext = {
        runId: run.id,
        input: { ...input, target: { ...input.target, draftRevision: revision } },
        tainted: run.tainted,
        pagesRead,
        pages: [],
        producer: { agent: run.agent, definitionVersion: run.definitionVersion, promptDigest: run.promptDigest, routeHash: offer.routeHash ?? "", ...(run.lessonDigest && { lessons: run.lessonDigest }) },
        userId,
      };
      const result = await sink(workspaceId, { kind: offer.kind as ProposalKind, outputKey: offer.outputKey, body: offer.body } as Parameters<Sink>[1], context);
      if (result.ok || GONE.has(result.code)) {
        await inWorkspace(workspaceId, (tx) => repo.closeOffer(tx, key.runId, key.outputKey, result.ok ? "used" : "dismissed", userId, d.now()));
      }
      return result.ok ? { ok: true } : result;
    },

    async dismiss(workspaceId: string, key: OfferKey, userId: string): Promise<OfferResult> {
      const closed = await inWorkspace(workspaceId, (tx) => repo.closeOffer(tx, key.runId, key.outputKey, "dismissed", userId, d.now()));
      return closed ? { ok: true } : { ok: false, code: "offer_closed" };
    },
  };
}

export type Offers = ReturnType<typeof createOffers>;
