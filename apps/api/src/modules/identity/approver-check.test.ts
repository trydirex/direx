// SPDX-License-Identifier: AGPL-3.0-only
// The approver check through the real Dispatcher: an approval stands only while its
// approver may still approve in that Workspace.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { approverIdFromSession, type createLedger } from "../ledger/index";
import { fakeEffect, testLedger } from "./fixtures/member";
import { approverMayApprove } from "./index";
import { testIdentity } from "./test-auth";

const { call, signIn, createOrg, addMember } = testIdentity();
const effect = fakeEffect("blind");
const { ledger } = await testLedger({ effects: { "test.post": effect.capability }, checks: [approverMayApprove()] });

async function approvedBy(l: ReturnType<typeof createLedger>, w: string, userId: string) {
  const actor = { userId };
  const { action } = await l.createAction(w, { idempotencyKey: crypto.randomUUID(), capability: "test.post", dedupe: "blind", spec: { body: "hi" }, actor });
  await l.submitForApproval(w, action.id, actor);
  const r = await l.approve(w, action.id, { approverId: approverIdFromSession(userId), draftVersion: 1, snapshot: [] });
  if (!r.ok) throw new Error(`approve: ${r.reason}`);
  return action.id;
}

test("a Marketer's approval is sent; demoted or removed after approving, it is held", async () => {
  const owner = await signIn();
  const w = (await createOrg(owner)).workspace.id;
  const kept = await addMember(owner, w, "marketer");
  const demoted = await addMember(owner, w, "marketer");
  const removed = await addMember(owner, w, "marketer");
  const ids = { kept: await approvedBy(ledger, w, kept.userId), demoted: await approvedBy(ledger, w, demoted.userId), removed: await approvedBy(ledger, w, removed.userId) };

  expect((await call(`/api/w/${w}/members/${demoted.userId}`, owner, { method: "PATCH", body: { role: "contributor" } })).status).toBe(200);
  expect((await call(`/api/w/${w}/members/${removed.userId}`, owner, { method: "DELETE" })).status).toBe(200);
  for (const id of Object.values(ids)) await ledger.run(w, id);

  expect(await ledger.getAction(w, ids.kept)).toMatchObject({ state: "sent" });
  expect(await ledger.getAction(w, ids.demoted)).toMatchObject({ state: "held", holdReason: "approver_permission_lost" });
  expect(await ledger.getAction(w, ids.removed)).toMatchObject({ state: "held", holdReason: "approver_permission_lost" });
  expect(effect.calls).toHaveLength(1);
});

test("outside tests, only the ledger and identity turn a user id into an ApproverId", () => {
  const src = join(import.meta.dirname, "../..");
  const offenders = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts") && !/\.test\.ts$|test-effects\.ts$|(^|\/)fixtures\//.test(f))
    .filter((f) => !/^modules\/(ledger|identity)\//.test(f))
    .filter((f) => readFileSync(join(src, f), "utf8").includes("approverIdFromSession"));
  expect(offenders).toEqual([]);
});
