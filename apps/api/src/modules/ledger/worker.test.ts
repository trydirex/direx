// SPDX-License-Identifier: AGPL-3.0-only
// A worker process killed with SIGKILL during the provider call loses no Action and
// calls the provider only once.
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { seedMember } from "../identity/fixtures/member";
import { approver, fakeEffect, person, scheduledAction, testLedger } from "./test-effects";

const W = crypto.randomUUID();
// The real worker runs the approver check, so the test approver must be a member of W.
await seedMember(W, approver);
const fake = fakeEffect("blind");
const TIMEOUT = 30_000;
const { clock, ledger } = await testLedger({ effects: { "test.kill": fake.capability, "test.slow": fake.capability, "test.hang": fake.capability }, executeTimeoutMs: TIMEOUT });

/** The SIGTERM fixture, started and ready to claim, in the worker role a split cloud deploy runs (ADR 0027 rule 002). */
async function drainWorker(deadlineMs = 10_000) {
  const marker = join(mkdtempSync(join(tmpdir(), "direx-drain-")), "calls");
  const proc = Bun.spawn([process.execPath, join(import.meta.dirname, "fixtures", "drain-worker.ts")], {
    env: { ...process.env, MARKER: marker, DEADLINE_MS: String(deadlineMs), DIREX_ROLE: "worker" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  let out = "";
  while (!out.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the drain worker exited before it was ready: ${await new Response(proc.stderr).text()}`);
    out += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  void proc.stdout.pipeTo(new WritableStream());
  return { proc, marker, calls: () => (existsSync(marker) ? readFileSync(marker, "utf8") : "") };
}

test("SIGKILL during the provider call: the Action is held as unknown, never sent twice", { timeout: 30_000 }, async () => {
  clock.at = new Date(); // the subprocess works jobs by the real clock
  const id = await scheduledAction(ledger, W, "test.kill", "blind");
  const marker = join(mkdtempSync(join(tmpdir(), "direx-kill-")), "calls");

  const worker = Bun.spawn([process.execPath, join(import.meta.dirname, "fixtures", "kill-worker.ts")], {
    env: { ...process.env, MARKER: marker },
    stdout: "ignore",
    stderr: "pipe",
  });
  await expect.poll(() => existsSync(marker), { timeout: 15_000, interval: 100 }).toBe(true);
  worker.kill("SIGKILL");
  await worker.exited;

  const dispatching = (await ledger.getAction(W, id))!;
  expect(dispatching.state).toBe("dispatching");

  // A restarted worker after the recovery deadline.
  clock.at = new Date(dispatching.dispatchStartedAt!.getTime() + TIMEOUT + 60_001);
  await ledger.run(W, id);
  expect(await ledger.getAction(W, id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", nextAttemptAt: null });
  expect(readFileSync(marker, "utf8")).toBe("called\n");
  expect(fake.calls).toHaveLength(0);
});

test("SIGTERM during the provider call: the call finishes, the Action is sent once, and nothing new is claimed", { timeout: 30_000 }, async () => {
  clock.at = new Date();
  const w = await drainWorker();
  const id = await scheduledAction(ledger, W, "test.slow", "blind");
  await expect.poll(w.calls, { timeout: 15_000, interval: 100 }).toBe("called\n");
  w.proc.kill("SIGTERM");
  // Approved after the stop began: it must wait for the next process.
  const later = await scheduledAction(ledger, W, "test.slow", "blind");
  const before = (await ledger.getAction(W, later))!.state;

  expect(await w.proc.exited).toBe(0);
  expect((await ledger.getAction(W, id))!.state).toBe("sent");
  expect((await ledger.getAction(W, later))!.state).toBe(before);
  expect(w.calls()).toBe("called\n");
  expect(fake.calls).toHaveLength(0);
  // So the next test's worker doesn't find it waiting.
  expect(await ledger.cancel(W, later, person)).toMatchObject({ ok: true });
});

test("SIGTERM with nothing in flight exits at once", { timeout: 30_000 }, async () => {
  const w = await drainWorker();
  const t = Date.now();
  w.proc.kill("SIGTERM");
  expect(await w.proc.exited).toBe(0);
  expect(Date.now() - t).toBeLessThan(2_000);
});

test("SIGTERM past the deadline: the process exits anyway, and recovery holds the Action as after SIGKILL", { timeout: 30_000 }, async () => {
  clock.at = new Date();
  const w = await drainWorker(2_000);
  const id = await scheduledAction(ledger, W, "test.hang", "blind");
  await expect.poll(w.calls, { timeout: 15_000, interval: 100 }).toBe("called\n");
  const t = Date.now();
  w.proc.kill("SIGTERM");
  expect(await w.proc.exited).toBe(0);
  expect(Date.now() - t).toBeGreaterThanOrEqual(1_900);
  expect(Date.now() - t).toBeLessThan(6_000);

  const dispatching = (await ledger.getAction(W, id))!;
  expect(dispatching.state).toBe("dispatching");
  clock.at = new Date(dispatching.dispatchStartedAt!.getTime() + TIMEOUT + 60_001);
  await ledger.run(W, id);
  expect(await ledger.getAction(W, id)).toMatchObject({ state: "held", holdReason: "outcome_unknown", nextAttemptAt: null });
  expect(fake.calls).toHaveLength(0);
});
