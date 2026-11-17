// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import type { EffectCapability } from "@direx/plugin-sdk";
import { bindingBytes, canonicalJson, changedEntries, type Binding } from "./domain/binding";
import { combine, OK } from "./domain/check-result";
import { nextRetryAt } from "./domain/retry";
import { canTransition, isFinal } from "./domain/states";
import { sign, specHash, verify } from "./application/signing";
import { WakePayload } from "./adapters/queue";

test("a wake job carries exactly a workspace id and an Action id", () => {
  const ids = { workspaceId: crypto.randomUUID(), actionId: crypto.randomUUID() };
  expect(WakePayload.parse(ids)).toEqual(ids);
  expect(() => WakePayload.parse({ ...ids, spec: { to: "x" } })).toThrow();
  expect(() => WakePayload.parse({ workspaceId: ids.workspaceId, actionId: "not-a-uuid" })).toThrow();
});

const key = { id: "k1", secret: "x".repeat(32) };
const binding: Binding = {
  actionId: "a",
  draftVersion: 2,
  specHash: "h",
  snapshot: [{ kind: "fact", id: "f1", version: "3" }],
  approverId: "u",
  approvedAt: "2026-10-29T00:00:00.000Z",
};

test("an approval with no rule signs the same bytes as one from before rules existed", () => {
  expect(bindingBytes({ ...binding, standingRuleId: undefined })).toBe(bindingBytes(binding));
  expect(bindingBytes({ ...binding, standingRuleId: "r" })).not.toBe(bindingBytes(binding));
});

test("a producer digest is signed when set, and leaves other approvals' bytes alone", () => {
  expect(bindingBytes({ ...binding, producerDigest: undefined })).toBe(bindingBytes(binding));
  const ruled = { ...binding, standingRuleId: "r", producerDigest: "d1" };
  const sig = sign(ruled, key);
  expect(verify(ruled, sig, key)).toBe(true);
  expect(verify({ ...ruled, producerDigest: "d2" }, sig, key)).toBe(false);
  expect(verify({ ...ruled, producerDigest: undefined }, sig, key)).toBe(false);
});

test("canonical JSON ignores key order and drops undefined", () => {
  expect(canonicalJson({ b: 1, a: [true, null, "x"], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
  expect(specHash({ to: "a@b.c", body: "hi" })).toBe(specHash({ body: "hi", to: "a@b.c" }));
  expect(() => canonicalJson({ at: new Date() })).toThrow(/plain object/);
  expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/);
});

test("the signature covers every bound field", () => {
  const sig = sign(binding, key);
  expect(verify(binding, sig, key)).toBe(true);
  const tampered: Partial<Binding>[] = [
    { actionId: "b" },
    { draftVersion: 3 },
    { specHash: "other" },
    { snapshot: [{ kind: "fact", id: "f1", version: "4" }] },
    { approverId: "someone-else" },
    { approvedAt: "2026-10-30T00:00:00.000Z" },
  ];
  for (const t of tampered) expect(verify({ ...binding, ...t }, sig, key)).toBe(false);
  expect(verify(binding, sig, { id: "k1", secret: "y".repeat(32) })).toBe(false);
  expect(verify(binding, "short", key)).toBe(false);
});

test("changed snapshot entries are named; a missing live entry counts as changed", () => {
  const snap = [
    { kind: "fact", id: "f1", version: "3" },
    { kind: "template", id: "t1", version: "1" },
  ];
  expect(changedEntries(snap, ["3", "1"])).toEqual([]);
  expect(changedEntries(snap, ["4", "1"])).toEqual([snap[0]]);
  expect(changedEntries(snap, ["3", null])).toEqual([snap[1]]);
});

test("block beats hold beats ok", () => {
  expect(combine([])).toEqual(OK);
  expect(combine([OK, { kind: "hold", reason: "cap" }, { kind: "block", reason: "opt_out" }])).toEqual({
    kind: "block",
    reason: "opt_out",
  });
  expect(combine([{ kind: "hold", reason: "a" }, { kind: "hold", reason: "b" }])).toEqual({ kind: "hold", reason: "a" });
});

test("retries run at 1, 5 and 25 minutes, then stop", () => {
  const now = new Date("2026-10-29T00:00:00Z");
  expect([0, 1, 2, 3].map((n) => nextRetryAt(n, now)?.toISOString() ?? null)).toEqual([
    "2026-10-29T00:01:00.000Z",
    "2026-10-29T00:05:00.000Z",
    "2026-10-29T00:25:00.000Z",
    null,
  ]);
});

test("a dispatching Action can't be cancelled, and sent, blocked and cancelled are final", () => {
  expect(canTransition("dispatching", "cancelled")).toBe(false);
  expect(canTransition("claimed", "cancelled")).toBe(true);
  expect(["sent", "blocked", "cancelled"].every((s) => isFinal(s as "sent"))).toBe(true);
});

test("a queryable effect without reconcile, or any effect without reachesPerson, does not compile", () => {
  const execute: EffectCapability["execute"] = async () => ({ kind: "sent" });
  // @ts-expect-error reconcile is required for queryable
  const bad: EffectCapability = { dedupe: "queryable", execute, reachesPerson: false };
  // @ts-expect-error dedupe is required
  const noDedupe: EffectCapability = { execute, reachesPerson: false };
  // @ts-expect-error every effect says whether it reaches a Person
  const noReach: EffectCapability = { dedupe: "blind", execute };
  expect([bad, noDedupe, noReach]).toHaveLength(3);
});
