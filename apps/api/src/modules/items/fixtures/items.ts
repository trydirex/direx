// SPDX-License-Identifier: AGPL-3.0-only
// Test support for items: a real ledger with the schedule's check, a real Workspace, and
// Items that carry a Touch or none.
import type { EffectCapability } from "@direx/plugin-sdk";
import { appClient } from "../../../../../../test/db";
import { approverFromMember, can } from "../../identity/index";
import { seedMember } from "../../identity/fixtures/member";
import { createPerson } from "../../people";
import { EMAIL, fakeEffect, person, scheduleLedger } from "../../schedule/fixtures/schedule";
import type { TouchClass } from "../../schedule";
import { testIdentity } from "../../identity/test-auth";
import type { LedgerDeps } from "../../ledger/index";
import { testLedger } from "../../ledger/test-effects";
import { createItems, itemRoutes, type AppearanceFor, type EditOf, type ItemKind, type MoveStep, type OnApplied, type RecipientFor } from "../index";
import type { ItemsTx } from "../adapters/repo";

export { EMAIL, fakeEffect, person };
export const POST = "test.post";

/** The Action behind an Item, for driving the Dispatcher directly. */
export async function actionIdOf(workspaceId: string, itemId: string) {
  const c = await appClient();
  await c.query("select set_config('app.workspace_id', $1, false)", [workspaceId]);
  const { rows } = await c.query("select action_id from items where id = $1", [itemId]);
  await c.end();
  return rows[0].action_id as string;
}

export async function itemsWorld(opts: { kinds?: Record<string, ItemKind>; onMoveStep?: (s: MoveStep) => void; onApplied?: OnApplied; postSteps?: Parameters<typeof fakeEffect>[1]; recipient?: RecipientFor; resolvers?: LedgerDeps["resolvers"]; editOf?: EditOf; mayGrant?: (tx: ItemsTx, userId: string) => Promise<boolean> } = {}) {
  const email = fakeEffect("blind", { reachesPerson: true });
  const post = fakeEffect("blind", opts.postSteps);
  const t = await scheduleLedger({ [EMAIL]: email.capability, [POST]: post.capability }, opts.resolvers);
  const W = crypto.randomUUID();
  await seedMember(W, person.userId);
  const items = createItems({ ledger: t.ledger, kinds: opts.kinds, now: () => t.clock.at, onMoveStep: opts.onMoveStep, onApplied: opts.onApplied, recipient: opts.recipient, ...(opts.editOf && { editOf: opts.editOf }), ...(opts.mayGrant && { mayGrant: opts.mayGrant }) });
  const who = { approverId: approverFromMember(person), may: (p: string) => can("owner", p as "item.approve") };
  const hours = (h: number) => new Date(t.clock.at.getTime() + h * 3_600_000);

  const newPost = (d: { plannedAt?: Date | null; warnings?: string[]; title?: string; groupKey?: string } = {}) =>
    items.createActionItem(W, {
      idempotencyKey: crypto.randomUUID(),
      capability: POST,
      dedupe: "blind",
      spec: { body: "hello" },
      actor: person,
      details: { title: d.title ?? "A post", channel: "post", warnings: (d.warnings ?? []).map((text) => ({ code: "unspecified" as const, text })), plannedAt: d.plannedAt ?? null, groupKey: d.groupKey },
    });
  const newTouch = async (personId: string, plannedAt: Date | null, touchClass: TouchClass = "cold") =>
    items.createActionItem(W, {
      idempotencyKey: crypto.randomUUID(),
      capability: EMAIL,
      dedupe: "blind",
      spec: { to: "dana@example.com", body: "hello", touch: { personId, touchClass } },
      actor: person,
      details: { title: "An email", channel: "email", warnings: [], plannedAt },
    });
  const submit = async <V extends { id: string }>(i: V) => {
    const r = await items.submitItem(W, i.id, person);
    if (!r.ok) throw new Error(r.reason);
    return r.item;
  };
  return { ...t, W, items, who, hours, email, post, newPost, newTouch, submit, newPerson: () => createPerson(W) };
}

/** The item routes behind identity's real sign-in, on a ledger with no schedule check. */
export async function itemsApp(opts: { kinds?: Record<string, ItemKind>; resolvers?: LedgerDeps["resolvers"]; appearance?: AppearanceFor } = {}) {
  const sent = fakeEffect("blind");
  const failing = { throw: fakeEffect("blind", { steps: ["throw"] }), refused_retryable: fakeEffect("blind", { steps: ["refused_retryable"] }) };
  // The next run's outcome for a test that needs one other than sent; it stays until cleared.
  const script: { next?: keyof typeof failing } = {};
  const capability: EffectCapability = {
    dedupe: "blind",
    reachesPerson: false,
    execute: (spec, ctx) => (script.next ? failing[script.next] : sent).capability.execute(spec, ctx),
  };
  const { ledger, clock } = await testLedger({ effects: { [POST]: capability }, resolvers: opts.resolvers });
  const items = createItems({ ledger, now: () => clock.at, kinds: opts.kinds, appearance: opts.appearance });
  const identity = testIdentity();
  identity.routes.route("/", itemRoutes({ items: () => items }));
  return { ...identity, ledger, clock, items, script };
}
