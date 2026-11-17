// SPDX-License-Identifier: AGPL-3.0-only
// A plugin effect dispatched through the real ledger, including a plugin killed while
// the provider call is in flight.
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { createBoss } from "../../jobs/boss";
import { approverIdFromSession, createLedger, oneKey } from "../ledger/index";
import { behaveManifest } from "./fixtures/manifest";
import { loadPlugins } from "./index";

const dir = join(import.meta.dirname, "fixtures");
const W = crypto.randomUUID();
const SEND = "com.example.behave/behave.send";
const approver = approverIdFromSession("00000000-0000-4000-8000-000000000001");
const person = { userId: approver as string };

const logs: string[] = [];
const plugins = loadPlugins({
  sources: [{ mode: "process", manifest: behaveManifest, entry: join(dir, "behave.ts"), dir }],
  credentials: async (ws) => ({ accessToken: `tok-${ws}`, expiresAt: "2026-11-02T10:00:00Z" }),
  confinement: "external",
  log: (l) => logs.push(l),
});
const boss = createBoss();
await boss.start();
const ledger = createLedger({ boss, signingKeys: oneKey({ id: "test", secret: "t".repeat(32) }), effects: plugins.effects });
await ledger.ensureQueue();
afterAll(async () => {
  await plugins.close({ force: true });
  await boss.stop({ graceful: false, close: true });
});

async function approved(input: unknown): Promise<string> {
  const { spec } = await plugins.prepare(W, SEND, input);
  const { action } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability: SEND, dedupe: "blind", spec, actor: person });
  await ledger.submitForApproval(W, action.id, person);
  const r = await ledger.approve(W, action.id, { approverId: approver, draftVersion: 1, snapshot: [] });
  if (!r.ok) throw new Error(`approve: ${r.reason}`);
  return action.id;
}

test("an approved Action is sent through an out-of-process plugin", async () => {
  const id = await approved({ do: "sent" });
  await ledger.run(W, id);
  expect(await ledger.getAction(W, id)).toMatchObject({ state: "sent", providerRef: `ws=${W} token=tok-${W}` });
});

test("killing the plugin mid-send holds the Action as an unknown outcome, and a blind effect is not sent again", async () => {
  const marker = crypto.randomUUID();
  const id = await approved({ do: "hang", marker });
  const run = ledger.run(W, id);
  for (let i = 0; i < 500 && !logs.some((l) => l.includes(`MARK ${marker}`)); i++) await new Promise((r) => setTimeout(r, 10));
  const proc = plugins.processes().find((p) => p.workspaceId === W)!;
  process.kill(proc.pid, "SIGKILL");
  await run;
  expect(await ledger.getAction(W, id)).toMatchObject({ state: "held", holdReason: "outcome_unknown" });

  await ledger.run(W, id);
  expect(await ledger.getAction(W, id)).toMatchObject({ state: "held", holdReason: "outcome_unknown" });
  expect(logs.filter((l) => l.includes(`MARK ${marker}`))).toHaveLength(1);
});
