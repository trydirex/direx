// SPDX-License-Identifier: AGPL-3.0-only
// Test support for the schedule: a ledger with the schedule's check, and Actions that
// carry a Touch in their spec.
import type { EffectCapability } from "@direx/plugin-sdk";
import { approver, fakeEffect, person, testLedger } from "../../ledger/test-effects";
import type { createLedger } from "../../ledger";
import { touchCheck, type TouchClass } from "../index";

export { approver, fakeEffect, person };
export const EMAIL = "test.email";
type Ledger = ReturnType<typeof createLedger>;

/** A ledger whose Dispatcher runs touchCheck, with a fake email effect that reaches a Person. */
export async function scheduleLedger(effects: Record<string, EffectCapability> = { [EMAIL]: fakeEffect("blind", { reachesPerson: true }).capability }, resolvers?: Parameters<typeof createLedger>[0]["resolvers"]) {
  const clock = { at: new Date("2026-11-02T09:00:00Z") };
  const check = touchCheck({ effects, now: () => clock.at });
  const t = await testLedger({ effects, checks: [check], now: () => clock.at, resolvers });
  return { ...t, clock };
}

/** A draft Action that reaches personId in this class. */
export async function touchAction(ledger: Ledger, workspaceId: string, personId: string, touchClass: TouchClass, spec: object = {}) {
  const { action } = await ledger.createAction(workspaceId, {
    idempotencyKey: crypto.randomUUID(),
    capability: EMAIL,
    dedupe: "blind",
    spec: { to: "dana@example.com", body: "hello", touch: { personId, touchClass }, ...spec },
    actor: person,
  });
  return action.id;
}

/** Submits and approves an Action for dueAt. */
export async function approveFor(ledger: Ledger, workspaceId: string, actionId: string, dueAt: Date) {
  await ledger.submitForApproval(workspaceId, actionId, person);
  const r = await ledger.approve(workspaceId, actionId, { approverId: approver, draftVersion: 1, snapshot: [], dueAt });
  if (!r.ok) throw new Error(`approve: ${r.reason}`);
}
