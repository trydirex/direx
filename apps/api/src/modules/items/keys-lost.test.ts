// SPDX-License-Identifier: AGPL-3.0-only
// Actions held because another root key wrapped their Workspace's data key: one notice for the
// Workspace, and approving it resumes every one of them through the claim again.
import { expect, test } from "vitest";
import type { EffectCapability } from "@direx/plugin-sdk";
import { seedMember } from "../identity/fixtures/member";
import { KeysUnavailable, oneKey, type SigningKeys } from "../ledger/index";
import { fakeEffect, person, scheduledAction, testKey, testLedger } from "../ledger/test-effects";
import { createItems, KEYS_LOST_KIND } from "./index";

const W = crypto.randomUUID();
await seedMember(W, person.userId);
const effects: Record<string, EffectCapability> = {};
const keys = { lost: false };
const real = oneKey(testKey);
const signingKeys: SigningKeys = async (ws) => {
  if (keys.lost) throw new KeysUnavailable("data key was wrapped by another root key", true);
  return real(ws);
};
const { ledger } = await testLedger({ effects, signingKeys, onKeysLost: (tx, ws) => items.openKeysLostIn(tx, ws).then(() => undefined) });
const PROBE = "test.probe";
const items = createItems({ ledger, actionPermission: (capability) => (capability === PROBE ? "credential.connect" : undefined) });
const who = { approverId: person.userId as never, may: () => true, steppedUp: true };

async function scheduled() {
  const cap = `test.${crypto.randomUUID()}`;
  const fake = fakeEffect("blind");
  effects[cap] = fake.capability;
  return { id: await scheduledAction(ledger, W, cap, "blind"), fake };
}
const notices = async () => (await items.list(W, { needsYou: true, offset: 0, limit: 100 })).items.filter((i) => i.kind === KEYS_LOST_KIND);

test("held Actions give the Workspace one notice, and approving it resumes each through the claim, sending once the keys are back", async () => {
  const a = await scheduled();
  const b = await scheduled();
  keys.lost = true;
  await ledger.run(W, a.id);
  await ledger.run(W, b.id);
  const [notice, ...more] = await notices();
  expect(more).toEqual([]);
  expect(notice!.title).toContain("another root key");

  // Still lost: resuming holds them again, and the Workspace is told again.
  expect(await items.approve(W, notice!.id, notice!.revision, who)).toMatchObject({ ok: true });
  expect((await ledger.getAction(W, a.id))!.state).toBe("scheduled");
  await ledger.run(W, a.id);
  expect((await ledger.getAction(W, a.id))!).toMatchObject({ state: "held", holdReason: "keys_unavailable" });
  const [again] = await notices();
  expect(again!.id).not.toBe(notice!.id);

  keys.lost = false;
  expect(await items.approve(W, again!.id, again!.revision, who)).toMatchObject({ ok: true });
  await ledger.run(W, a.id);
  await ledger.run(W, b.id);
  expect(a.fake.calls).toHaveLength(1);
  expect(b.fake.calls).toHaveLength(1);
  expect(await notices()).toEqual([]);
});

test("resuming them all needs a recent sign-in, and leaves an Action whose capability needs its own permission for its own Item", async () => {
  const probe = fakeEffect("blind");
  effects[PROBE] = probe.capability;
  const p = await scheduledAction(ledger, W, PROBE, "blind");
  const a = await scheduled();
  keys.lost = true;
  await ledger.run(W, p);
  await ledger.run(W, a.id);
  const [notice] = await notices();
  expect(await items.approve(W, notice!.id, notice!.revision, { ...who, steppedUp: false })).toEqual({ ok: false, reason: "step_up_required" });
  expect(await items.applyByGrant(W, notice!.id, { userId: person.userId, as: "advance" })).toEqual({ ok: false, reason: "forbidden" });
  keys.lost = false;
  expect(await items.approve(W, notice!.id, notice!.revision, who)).toMatchObject({ ok: true });
  expect((await ledger.getAction(W, a.id))!.state).toBe("scheduled");
  expect((await ledger.getAction(W, p))!).toMatchObject({ state: "held", holdReason: "keys_unavailable" });
});
