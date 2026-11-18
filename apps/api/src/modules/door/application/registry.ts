// SPDX-License-Identifier: AGPL-3.0-only
// The door's readers, registered once (ADR 0032 rules 002 and 003): the only source of its HTTP
// routes, its OpenAPI document and later its MCP tools. Built at start, it stops the start when the
// reads and the catalogue disagree: a name in one and not the other, or a reader whose disclosure
// says personal when the catalogue doesn't, or the other way round.
import type { DoorRead } from "../../core-reads/index";
import type { z } from "zod";
import { DOOR_KINDS, DOOR_READERS, type DoorKind, type DoorReader } from "../domain/catalogue";
import type { TokenCaller } from "../domain/tokens";
import { ProposalOutput, type ProposalResult } from "./proposals";

export type Registration = DoorRead & { name: DoorReader };

export function registerReaders(reads: Readonly<Record<string, DoorRead>>): Registration[] {
  const names = Object.keys(DOOR_READERS) as DoorReader[];
  const missing = names.filter((n) => !Object.hasOwn(reads, n));
  const extra = Object.keys(reads).filter((n) => !(names as string[]).includes(n));
  if (missing.length || extra.length) throw new Error(`door: the readers don't match DOOR_READERS (missing: ${missing.join(", ") || "none"}; not in the catalogue: ${extra.join(", ") || "none"})`);
  const wrong = names.filter((n) => (reads[n]!.disclosure === "personal") !== DOOR_READERS[n].personal);
  if (wrong.length) throw new Error(`door: ${wrong.join(", ")} disagree with DOOR_READERS on whether they are personal`);
  return names.map((name) => ({ ...reads[name]!, name }));
}

/** One per proposal kind (ADR 0032 rule 004), beside the readers: its name, input and output, and the intake's call. */
export type ProposalRegistration = { name: DoorKind; description: string; input: z.ZodType; output: z.ZodType; propose: (caller: TokenCaller, input: unknown) => Promise<ProposalResult> };

const KIND_WORDS: Record<DoorKind, string> = {
  fact_proposal:
    "Suggest a fact for Brand: what you sell, who buys, tone, price or a claim. It waits for a person as \"Add this?\" and is used for nothing until they accept it. A retry with the same idempotencyKey and body gets the same Item.",
  draft:
    "Suggest a text post for the Calendar on a connected account, at a time in the future. It waits for a person's approval and goes out only if they approve it. A retry with the same idempotencyKey and body gets the same Item.",
};

/** The proposal kinds as registrations; stops the start when the intake lacks one of `DOOR_KINDS`. */
export function registerProposals(p: { inputs: Readonly<Record<string, z.ZodType>>; propose: (caller: TokenCaller, kind: DoorKind, input: unknown) => Promise<ProposalResult> }): ProposalRegistration[] {
  const missing = DOOR_KINDS.filter((k) => !Object.hasOwn(p.inputs, k));
  if (missing.length) throw new Error(`door: no proposal intake for ${missing.join(", ")}`);
  return DOOR_KINDS.map((name) => ({ name, description: KIND_WORDS[name], input: p.inputs[name]!, output: ProposalOutput, propose: (caller, input) => p.propose(caller, name, input) }));
}
