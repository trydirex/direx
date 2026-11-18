// SPDX-License-Identifier: AGPL-3.0-only
// One call through the door, after its token and caps have passed: the same steps for an HTTP route
// and an MCP tool (ADR 0032 rule 002), so neither face can do what the other doesn't. The reader
// must be one the token chose, the input its schema accepts, and the answer only the fields its
// output names. Each ending leaves one request row; a read that throws is recorded and thrown on.
import { ZodError } from "zod";
import type { TokenCaller } from "../domain/tokens";
import type { ProposalRefusal } from "./proposals";
import type { ProposalRegistration, Registration } from "./registry";
import type { DoorOutcome, Requests } from "./requests";

export type Refusal = "reader_not_allowed" | "invalid_input" | "bad_cursor";
export type Invoked = { ok: true; value: Record<string, unknown> } | { ok: false; refusal: Refusal };

export async function invoke(requests: Pick<Requests, "record">, caller: TokenCaller, reg: Registration, input: unknown): Promise<Invoked> {
  const record = (outcome: DoorOutcome) => requests.record(caller.workspaceId, caller.tokenId, reg.name, outcome);
  const refuse = async (refusal: Refusal): Promise<Invoked> => {
    await record(refusal);
    return { ok: false, refusal };
  };
  if (!caller.readers.includes(reg.name)) return refuse("reader_not_allowed");
  try {
    const r = await reg.read(caller.workspaceId, input);
    if (!r.ok) return refuse("bad_cursor");
    const value = reg.output.parse(r.value) as Record<string, unknown>;
    await record("ok");
    return { ok: true, value };
  } catch (e) {
    if (e instanceof ZodError) return refuse("invalid_input");
    await record("error");
    throw e;
  }
}

export type Proposed = { ok: true; value: { itemId: string | null } } | { ok: false; refusal: ProposalRefusal; itemId?: string; code?: string };

/** A proposal through either face, after the token and caps: one request row with how it ended (rule 011). */
export async function proposeVia(requests: Pick<Requests, "record">, caller: TokenCaller, reg: ProposalRegistration, input: unknown): Promise<Proposed> {
  const record = (outcome: DoorOutcome) => requests.record(caller.workspaceId, caller.tokenId, reg.name, outcome);
  let r;
  try {
    r = await reg.propose(caller, input);
  } catch (e) {
    await record("error");
    throw e;
  }
  await record(r.ok ? "ok" : r.reason);
  if (r.ok) return { ok: true, value: { itemId: r.itemId } };
  return { ok: false, refusal: r.reason, ...(r.itemId && { itemId: r.itemId }), ...(r.code && { code: r.code }) };
}
