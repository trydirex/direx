// SPDX-License-Identifier: AGPL-3.0-only
// The door's proposal intake against the database, with fake owning modules that make real Items: the
// token's name, the untrusted warning and no take-over reach the module; a replay answers the same and
// a changed body is refused; kinds and input are checked; caps count per token, then per Workspace.
import { expect, test, vi } from "vitest";
import { proposalItemCount, seedItemIn, seedWorkspace } from "./fixtures/members";
import { createProposals, createTokens, type Made, type ProposalCaps } from "./index";

import { itemsWorld } from "../items/fixtures/items";
import * as repo from "./adapters/repo";

const tokens = createTokens({ maxDays: null });
const AHEAD = new Date(Date.now() + 86_400_000).toISOString();

async function space() {
  const w = crypto.randomUUID();
  const owner = crypto.randomUUID();
  await seedWorkspace(w, owner);
  async function caller(kinds: string[] = ["fact_proposal", "draft"], name = "Zapier") {
    const r = await tokens.create(w, { name, days: 7, readers: [], kinds }, owner);
    if (!r.ok) throw new Error(r.reason);
    return (await tokens.verify(w, r.token))!;
  }
  return { w, caller };
}

/** An intake whose modules make a real Item each time, all of them still waiting until a test decides one. */
function world(w: string, o: { caps?: ProposalCaps; fact?: () => Promise<Made>; waiting?: Parameters<typeof createProposals>[0]["waiting"] } = {}) {
  const calls: unknown[][] = [];
  const waiting = new Set<string>();
  const made = async (tx: Parameters<typeof seedItemIn>[0]): Promise<Made> => {
    const itemId = await seedItemIn(tx, w);
    waiting.add(itemId);
    return { ok: true, itemId };
  };
  const proposals = createProposals({
    entries: {
      fact: async (tx, _w, p) => (calls.push(["fact", p]), o.fact ? o.fact() : made(tx)),
      draft: async (tx, _w, p, actor, warnings) => (calls.push(["draft", p, actor, warnings]), made(tx)),
    },
    waiting: o.waiting ?? (async (_tx, ids) => ids.filter((id) => waiting.has(id)).length),
    maxFactChars: 1000,
    caps: o.caps,
  });
  return { proposals, calls, waiting };
}

const fact = (idempotencyKey: string, value = "Marketing software") => ({ idempotencyKey, field: "what_you_sell", value });

test("a fact reaches its module in the token's name, untrusted and never taking over; a replay answers the same", async () => {
  const { w, caller } = await space();
  const c = await caller();
  const { proposals, calls } = world(w);
  const first = await proposals.propose(c, "fact_proposal", fact("k1"));
  expect(first).toEqual({ ok: true, itemId: expect.any(String) });
  expect(calls).toEqual([
    [
      "fact",
      {
        field: "what_you_sell",
        value: "Marketing software",
        confidence: "medium",
        source: { kind: "document", label: 'External token "Zapier"' },
        actor: { system: `external_token:${c.tokenId}` },
        warnings: [{ code: "untrusted_source", text: `Sent through the External token "Zapier". Direx hasn't checked it.` }],
        takeOver: false,
      },
    ],
  ]);
  expect(await proposals.propose(c, "fact_proposal", fact("k1"))).toEqual(first);
  expect(calls).toHaveLength(1);
  expect(await proposals.propose(c, "fact_proposal", fact("k1", "Something else"))).toEqual({ ok: false, reason: "idempotency_conflict" });
  // Keys are per token: another token's k1 is its own proposal.
  const other = await proposals.propose(await caller(undefined, "n8n"), "fact_proposal", fact("k1"));
  expect(other).toEqual({ ok: true, itemId: expect.any(String) });
  expect(other).not.toEqual(first);
});

test("a draft reaches Posts with its time as a date, the actor and the warning", async () => {
  const { w, caller } = await space();
  const c = await caller();
  const { proposals, calls } = world(w);
  const r = await proposals.propose(c, "draft", { idempotencyKey: "d1", connection: "testnet", credentialId: crypto.randomUUID(), text: "Hello", at: AHEAD });
  expect(r).toEqual({ ok: true, itemId: expect.any(String) });
  const [, p, actor, warnings] = calls[0]!;
  expect(p).toMatchObject({ connection: "testnet", networkId: null, text: "Hello", followUps: [], at: new Date(AHEAD) });
  expect(actor).toEqual({ system: `external_token:${c.tokenId}` });
  expect(warnings).toEqual([{ code: "untrusted_source", text: expect.stringContaining('"Zapier"') }]);
});

test("a module's refusal comes back: a waiting proposal by its Item, anything else as refused with its code, and nothing is recorded", async () => {
  const { w, caller } = await space();
  const c = await caller();
  const waitingOne = world(w, { fact: async () => ({ ok: false, reason: "already_waiting", itemId: "item-1" }) });
  expect(await waitingOne.proposals.propose(c, "fact_proposal", fact("a1"))).toEqual({ ok: false, reason: "already_waiting", itemId: "item-1" });
  const refusing = world(w, { fact: async () => ({ ok: false, reason: "blank_value" }) });
  expect(await refusing.proposals.propose(c, "fact_proposal", fact("a2"))).toEqual({ ok: false, reason: "refused", code: "blank_value" });
  // Nothing was recorded, so the key is free for the next try.
  const fresh = world(w);
  expect(await fresh.proposals.propose(c, "fact_proposal", fact("a1"))).toEqual({ ok: true, itemId: expect.any(String) });
});

test("a token proposes only the kinds it chose, with input that fits", async () => {
  const { w, caller } = await space();
  const { proposals, calls } = world(w);
  expect(await proposals.propose(await caller(["draft"]), "fact_proposal", fact("x1"))).toEqual({ ok: false, reason: "kind_not_allowed" });
  const c = await caller();
  for (const bad of [
    { ...fact("x2"), field: "never_say" },
    { ...fact("x3"), value: "x".repeat(1001) },
    { ...fact("x4"), value: "   " },
    { ...fact("x5"), extra: true },
    { idempotencyKey: "x6", connection: "testnet", text: "Hi", at: "tomorrow" },
  ]) {
    const kind = "connection" in bad ? "draft" : "fact_proposal";
    expect(await proposals.propose(c, kind, bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "invalid_input" });
  }
  expect(calls).toHaveLength(0);
});

test("caps count a day's proposals per token, then per Workspace", async () => {
  const { w, caller } = await space();
  const { proposals } = world(w, { caps: { perTokenDay: 2, perTokenWaiting: 10, perWorkspaceDay: 3, perWorkspaceWaiting: 10 } });
  const a = await caller();
  const b = await caller(undefined, "n8n");
  expect((await proposals.propose(a, "fact_proposal", fact("c1", "One"))).ok).toBe(true);
  expect((await proposals.propose(a, "fact_proposal", fact("c2", "Two"))).ok).toBe(true);
  expect(await proposals.propose(a, "fact_proposal", fact("c3", "Three"))).toEqual({ ok: false, reason: "proposal_cap" });
  expect((await proposals.propose(b, "fact_proposal", fact("c4", "Four"))).ok).toBe(true);
  expect(await proposals.propose(b, "fact_proposal", fact("c5", "Five"))).toEqual({ ok: false, reason: "proposal_cap" });
});

test("caps count what still waits, per token, then per Workspace, and a decision frees a place", async () => {
  const { w, caller } = await space();
  const { proposals, waiting } = world(w, { caps: { perTokenDay: 10, perTokenWaiting: 1, perWorkspaceDay: 10, perWorkspaceWaiting: 2 } });
  const a = await caller();
  const first = await proposals.propose(a, "fact_proposal", fact("w1", "One"));
  expect(await proposals.propose(a, "fact_proposal", fact("w2", "Two"))).toEqual({ ok: false, reason: "proposal_cap" });
  if (first.ok) waiting.delete(first.itemId!);
  expect((await proposals.propose(a, "fact_proposal", fact("w2", "Two"))).ok).toBe(true);
  const b = await caller(undefined, "n8n");
  expect((await proposals.propose(b, "fact_proposal", fact("w3", "Three"))).ok).toBe(true);
  // Two wait across the Workspace now (a's second and b's first), so a third token is over its cap.
  expect(await proposals.propose(await caller(undefined, "Make"), "fact_proposal", fact("w4", "Four"))).toEqual({ ok: false, reason: "proposal_cap" });
});


test("successful no-Item results replay even after the owner would give a different answer", async () => {
  const { w, caller } = await space();
  const c = await caller();
  const first = world(w, { fact: async () => ({ ok: true, itemId: null }) });
  expect(await first.proposals.propose(c, "fact_proposal", fact("noop"))).toEqual({ ok: true, itemId: null });
  const retry = world(w);
  expect(await retry.proposals.propose(c, "fact_proposal", fact("noop"))).toEqual({ ok: true, itemId: null });
  expect(retry.calls).toHaveLength(0);
  expect(await retry.proposals.propose(c, "fact_proposal", fact("noop", "Changed"))).toEqual({ ok: false, reason: "idempotency_conflict" });
});

test("more simultaneous proposals than pool connections complete and replay once", async () => {
  const { w, caller } = await space();
  const c = await caller();
  const { items } = await itemsWorld();
  const { proposals, calls } = world(w, { waiting: items.waitingAmongIn });
  const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => proposals.propose(c, "fact_proposal", fact(`parallel-${i}`))));
  expect(answers[0]).toEqual({ ok: true, itemId: expect.any(String) });
  expect(answers.every((answer) => answer.ok)).toBe(true);
  expect(await proposals.propose(c, "fact_proposal", fact("parallel-0"))).toEqual(answers[0]);
  expect(calls).toHaveLength(12);
});


test.each(["record", "after_record"])("owner writes roll back on %s failure and a retry creates only one Item", async (failure) => {
  const { w, caller } = await space();
  const c = await caller();
  const { proposals } = world(w);
  const insert = repo.insertProposal;
  const fault = vi.spyOn(repo, "insertProposal").mockImplementationOnce(async (...args) => {
    if (failure === "after_record") await insert(...args);
    throw new Error("injected recording failure");
  });
  try {
    await expect(proposals.propose(c, "fact_proposal", fact("retry"))).rejects.toThrow("injected recording failure");
  } finally {
    fault.mockRestore();
  }
  expect(await proposalItemCount(w)).toBe(0);
  const retried = await proposals.propose(c, "fact_proposal", fact("retry"));
  expect(retried).toEqual({ ok: true, itemId: expect.any(String) });
  expect(await proposals.propose(c, "fact_proposal", fact("retry"))).toEqual(retried);
  expect(await proposalItemCount(w)).toBe(1);
});
