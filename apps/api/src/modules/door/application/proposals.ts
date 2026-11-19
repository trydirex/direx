// SPDX-License-Identifier: AGPL-3.0-only
// What an outside caller may suggest through the door (ADR 0032 rules 004 and 006): a fact for Brand or
// a post for the Calendar, made by the module that owns it, in the token's name, marked as untrusted, and
// always waiting for a person. The owning modules are reached through functions passed in, so the door
// imports neither. A retry with the same key and body answers as the first did; the same key with
// another body is refused. Caps are counted per token, then per Workspace, under one lock with the record.
import { createHash } from "node:crypto";
import { z } from "zod";
import { warn, type Warning } from "../../items/index";
import * as repo from "../adapters/repo";
import type { DoorKind } from "../domain/catalogue";
import type { TokenCaller } from "../domain/tokens";

const DAY_MS = 86_400_000;
// ponytail: "still waiting" counts the Items of the last 30 days' proposals, so the lookup stays bounded;
// an older Item still waiting no longer counts. Widen the window if pilots leave proposals that long.
const WAITING_WINDOW_MS = 30 * DAY_MS;

export type ProposalCaps = { perTokenDay: number; perTokenWaiting: number; perWorkspaceDay: number; perWorkspaceWaiting: number };
/** The door-proposals spec's caps (founder, 2026-11-16). */
export const PROPOSAL_CAPS: ProposalCaps = { perTokenDay: 50, perTokenWaiting: 20, perWorkspaceDay: 200, perWorkspaceWaiting: 100 };

const Key = z.string().min(1).max(200);
/** The fields agents may propose; never `never_say` or `competitor`. */
const FACT_FIELDS = ["what_you_sell", "who_buys", "tone", "price", "claim"] as const;
const factInput = (maxChars: number) =>
  z.strictObject({
    idempotencyKey: Key,
    field: z.enum(FACT_FIELDS),
    subject: z.string().max(200).optional(),
    value: z.string().trim().min(1).max(maxChars),
    confidence: z.enum(["low", "medium", "high"]).default("medium"),
  });
const DraftInput = z.strictObject({
  idempotencyKey: Key,
  connection: z.string().min(1).max(100),
  credentialId: z.uuid().nullish(),
  networkId: z.string().min(1).max(200).nullish(),
  text: z.string().min(1).max(10_000),
  followUps: z.array(z.string().min(1).max(10_000)).max(20).optional(),
  at: z.iso.datetime(),
});

export type ProposalActor = { system: string };
export type FactProposal = {
  field: (typeof FACT_FIELDS)[number];
  subject?: string;
  value: string;
  confidence: "low" | "medium" | "high";
  source: { kind: "document"; label: string };
  actor: ProposalActor;
  warnings: readonly Warning[];
  /** The door never revises an Item someone else made: a slot with one waiting is refused. */
  takeOver: false;
};
export type DraftProposal = { connection: string; credentialId: string | null; networkId: string | null; text: string; followUps: string[]; at: Date };
/** What an owning module answers: the Item it made (null when there was nothing to make), or its refusal. */
export type Made = { ok: true; itemId: string | null } | { ok: false; reason: string; itemId?: string };
/** Facts use this transaction; Calendar drafts retain their existing separate transactions. */
export type ProposalEntries = {
  fact: (tx: repo.ProposalTx, workspaceId: string, p: FactProposal) => Promise<Made>;
  draft: (tx: repo.ProposalTx, workspaceId: string, p: DraftProposal, actor: ProposalActor, warnings: readonly Warning[]) => Promise<Made>;
};

/** What a proposal answers: the Item it made, or null when there was nothing to make. */
export const ProposalOutput = z.object({ itemId: z.uuid().nullable() });

export type ProposalRefusal = "kind_not_allowed" | "invalid_input" | "idempotency_conflict" | "proposal_cap" | "already_waiting" | "refused";
export type ProposalResult = { ok: true; itemId: string | null } | { ok: false; reason: ProposalRefusal; itemId?: string; code?: string };

const digestOf = (body: unknown) => createHash("sha256").update(JSON.stringify(body)).digest("hex");

export function createProposals(d: {
  entries: ProposalEntries;
  /** How many of these Items still wait for a person (`Items.waitingAmongIn`). */
  waiting: (tx: repo.ProposalTx, itemIds: readonly string[]) => Promise<number>;
  /** A fact's value is capped where a person's typed value is (`MAX_FACT_CHARS`). */
  maxFactChars: number;
  caps?: ProposalCaps;
  now?: () => Date;
}) {
  const caps = d.caps ?? PROPOSAL_CAPS;
  const now = d.now ?? (() => new Date());
  const FactInput = factInput(d.maxFactChars);

  /** Per token first, then per Workspace: a day's proposals, then those still waiting. */
  async function overCap(tx: Parameters<typeof repo.proposalsSince>[0], tokenId: string) {
    const at = now().getTime();
    const recent = await repo.proposalsSince(tx, new Date(at - WAITING_WINDOW_MS));
    const today = recent.filter((p) => p.createdAt.getTime() > at - DAY_MS);
    const mine = recent.filter((p) => p.tokenId === tokenId);
    if (today.filter((p) => p.tokenId === tokenId).length >= caps.perTokenDay) return true;
    if ((await d.waiting(tx, mine.flatMap((p) => p.itemId ? [p.itemId] : []))) >= caps.perTokenWaiting) return true;
    if (today.length >= caps.perWorkspaceDay) return true;
    return (await d.waiting(tx, recent.flatMap((p) => p.itemId ? [p.itemId] : []))) >= caps.perWorkspaceWaiting;
  }

  return {
    /** Each kind's input, for the door's document and its MCP tools. */
    inputs: { fact_proposal: FactInput, draft: DraftInput } as const,

    async propose(caller: TokenCaller, kind: DoorKind, raw: unknown): Promise<ProposalResult> {
      if (!caller.kinds.includes(kind)) return { ok: false, reason: "kind_not_allowed" };
      const parsed = kind === "fact_proposal" ? FactInput.safeParse(raw) : DraftInput.safeParse(raw);
      if (!parsed.success) return { ok: false, reason: "invalid_input" };
      const { idempotencyKey, ...body } = parsed.data;
      const digest = digestOf(body);
      const workspaceId = caller.workspaceId;
      const actor = { system: `external_token:${caller.tokenId}` };
      const warnings = [warn("untrusted_source", `Sent through the External token "${caller.name}". Direx hasn't checked it.`)];

      for (;;) {
        const result = await repo.inWorkspace(workspaceId, async (tx): Promise<ProposalResult | null> => {
          if (!await repo.tryLockProposals(tx, workspaceId, kind === "draft")) return null;
          const seen = await repo.findProposal(tx, caller.tokenId, idempotencyKey);
          if (seen) return seen.bodyDigest === digest && seen.kind === kind ? { ok: true, itemId: seen.itemId } : { ok: false, reason: "idempotency_conflict" };
          if (await overCap(tx, caller.tokenId)) return { ok: false, reason: "proposal_cap" };

          let made: Made;
          if (kind === "fact_proposal") {
            const f = body as Omit<z.infer<typeof FactInput>, "idempotencyKey">;
            made = await d.entries.fact(tx, workspaceId, { ...f, source: { kind: "document", label: `External token "${caller.name}"` }, actor, warnings, takeOver: false });
          } else {
            const p = body as Omit<z.infer<typeof DraftInput>, "idempotencyKey">;
            made = await d.entries.draft(tx, workspaceId, { connection: p.connection, credentialId: p.credentialId ?? null, networkId: p.networkId ?? null, text: p.text, followUps: p.followUps ?? [], at: new Date(p.at) }, actor, warnings);
          }
          if (!made.ok) return made.reason === "already_waiting" ? { ok: false, reason: "already_waiting", ...(made.itemId && { itemId: made.itemId }) } : { ok: false, reason: "refused", code: made.reason };
          // Record every successful result, including a no-Item result.
          await repo.insertProposal(tx, { workspaceId, tokenId: caller.tokenId, idempotencyKey, bodyDigest: digest, kind, itemId: made.itemId, createdAt: now() });
          return { ok: true, itemId: made.itemId };
        });
        if (result) return result;
        // The transaction and its connection have been released before backing off.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

export type Proposals = ReturnType<typeof createProposals>;
