// SPDX-License-Identifier: AGPL-3.0-only
// The Gmail plugin through the real ledger and the host: a send that is cut off is
// found and settled without a second send, one that never happened waits for a person,
// and each reply is handed off once across full and history reads.
import { createGmailPlugin, gmailManifest } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { afterAll, expect, test } from "vitest";
import { createBoss } from "../../jobs/boss";
import { approverIdFromSession, createLedger, oneKey } from "../ledger/index";
import { loadPlugins, type TriggerEvent } from "./index";

const W = crypto.randomUUID();
const approver = approverIdFromSession("00000000-0000-4000-8000-000000000001");
const person = { userId: approver as string };
const clock = { at: new Date("2026-11-02T09:00:00Z") };
const handed: TriggerEvent[] = [];

const fake = startFakeGmail();
const boss = createBoss();
await boss.start();
await boss.createQueue("plugins.poll");
const plugins = loadPlugins({
  sources: [{ mode: "in_process", plugin: createGmailPlugin({ baseUrl: fake.url, timeoutMs: 300, now: () => clock.at.getTime() }) }],
  credentials: async () => ({ accessToken: fake.token, expiresAt: "2026-11-02T10:00:00Z" }),
  confinement: "none",
  log: () => {},
  boss,
  now: () => clock.at,
  onEvent: async (_tx, e) => void handed.push(e),
});
const SEND = Object.keys(plugins.effects)[0]!;
const ledger = createLedger({ boss, signingKeys: oneKey({ id: "test", secret: "t".repeat(32) }), effects: plugins.effects, now: () => clock.at });
await ledger.ensureQueue();
afterAll(async () => {
  fake.stop();
  await boss.stop({ graceful: false, close: true });
});

async function approved(subject: string): Promise<string> {
  const { spec } = await plugins.prepare(W, SEND, { to: ["kim@example.com"], subject, text: "Hi Kim" });
  const { action } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: SEND, dedupe: "queryable", spec, actor: person });
  await ledger.submitForApproval(W, action.id, person);
  const r = await ledger.approve(W, action.id, { approverId: approver, draftVersion: 1, snapshot: [] });
  if (!r.ok) throw new Error(`approve: ${r.reason}`);
  return action.id;
}

const get = (id: string) => ledger.getAction(W, id).then((a) => a!);
async function nextRetry(id: string) {
  const a = await get(id);
  if (!a.nextAttemptAt) throw new Error("no retry scheduled");
  clock.at = a.nextAttemptAt;
  await ledger.run(W, id);
}

test("an approved email is sent once, with the Gmail id on the Action", async () => {
  const before = fake.calls.send;
  const id = await approved("Hello");
  await ledger.run(W, id);
  const a = await get(id);
  expect(a).toMatchObject({ state: "sent", correlationKey: expect.stringMatching(/^<gmail-\d+@mail\.gmail\.com>$/) });
  expect(a.providerRef).toMatch(/^m\d+$/);
  expect(fake.calls.send - before).toBe(1);
});

test("a send Gmail took but never answered is found by reconcile and settled as sent, with no second send", async () => {
  const before = fake.calls.send;
  const id = await approved("Cut off");
  fake.sendScript.push("accept_then_hang");
  await ledger.run(W, id);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown" });
  await nextRetry(id);
  expect(await get(id)).toMatchObject({ state: "sent" });
  expect(fake.calls.send - before).toBe(1);
});

test("a send that never reached Gmail is never resent on its own: after 1, 5 and 25 minutes a person decides", async () => {
  const before = fake.calls.send;
  const id = await approved("Lost");
  fake.sendScript.push("hang");
  await ledger.run(W, id);
  for (let i = 0; i < 3; i++) await nextRetry(id);
  expect(await get(id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", nextAttemptAt: null });
  expect(fake.calls.send - before).toBe(1);
});

test("replies are handed off once each, across a full read and a history read", async () => {
  const poll = () => plugins.runPoll({ workspaceId: W, pluginId: gmailManifest.id, trigger: "email.received" });
  const a = fake.deliver({ from: "kim@example.com", subject: "Re: Hello", text: "Tuesday works" });
  expect(await poll()).toBe("handed_off");
  const b = fake.deliver({ from: "lee@example.com", subject: "Re: Hello", text: "Not now" });
  clock.at = new Date(clock.at.getTime() + 60_000);
  expect(await poll()).toBe("handed_off");
  clock.at = new Date(clock.at.getTime() + 24 * 60 * 60 * 1000);
  expect(await poll()).toBe("handed_off");
  expect(handed.filter((e) => e.workspaceId === W).map((e) => e.eventId)).toEqual([a, b]);
});
