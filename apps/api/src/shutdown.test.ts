// SPDX-License-Identifier: AGPL-3.0-only
// The stop sequence with fake server and worker, and a real Bun server for in-flight requests.
import { expect, test } from "vitest";
import { DRAIN_DEADLINE_MS, onStopSignal, type Drainable } from "./shutdown";

function fakes(drainMs: number | "never") {
  const calls: string[] = [];
  const codes: number[] = [];
  const handlers = new Map<string, () => void>();
  const worker: Drainable = {
    drain: async (ms) => {
      calls.push(`drain ${ms}`);
      if (drainMs === "never") return new Promise(() => {});
      await Bun.sleep(drainMs);
    },
    close: async () => void calls.push("close"),
  };
  const server = { stop: async (force?: boolean) => void calls.push(`server.stop ${String(force)}`) };
  return { calls, codes, handlers, worker, server, exit: (c: number) => void codes.push(c), on: (s: string, h: () => void) => void handlers.set(s, h) };
}

test("the deadline is the longest effect timeout plus 30 seconds", () => {
  expect(DRAIN_DEADLINE_MS).toBe(330_000);
});

test("both signals are handled; idle, it exits at once after closing", async () => {
  const f = fakes(0);
  const stop = onStopSignal({ worker: f.worker, server: f.server, exit: f.exit, on: f.on });
  expect([...f.handlers.keys()]).toEqual(["SIGTERM", "SIGINT"]);
  const t = Date.now();
  await stop();
  expect(Date.now() - t).toBeLessThan(500);
  expect(f.calls).toEqual(["server.stop false", "drain 330000", "server.stop true", "close"]);
  expect(f.codes).toEqual([0]);
});

test("it waits for work in flight, then closes", async () => {
  const f = fakes(300);
  const stop = onStopSignal({ worker: f.worker, server: f.server, deadlineMs: 5_000, exit: f.exit, on: f.on });
  const t = Date.now();
  await stop();
  expect(Date.now() - t).toBeGreaterThanOrEqual(290);
  expect(f.calls.at(-1)).toBe("close");
  expect(f.codes).toEqual([0]);
});

test("at the deadline it force-closes and exits, even if the drain never ends", async () => {
  const f = fakes("never");
  const stop = onStopSignal({ worker: f.worker, server: f.server, deadlineMs: 200, exit: f.exit, on: f.on });
  const t = Date.now();
  await stop();
  expect(Date.now() - t).toBeLessThan(1_000);
  expect(f.calls).toEqual(["server.stop false", "drain 200", "server.stop true", "close"]);
  expect(f.codes).toEqual([0]);
});

test("a second signal exits at once with 1", async () => {
  const f = fakes(300);
  onStopSignal({ worker: f.worker, deadlineMs: 5_000, exit: f.exit, on: f.on });
  f.handlers.get("SIGTERM")!();
  f.handlers.get("SIGINT")!();
  expect(f.codes).toEqual([1]);
  await expect.poll(() => f.codes, { timeout: 2_000 }).toEqual([1, 0]);
});

test("a failing drain or close is logged and the process still exits", async () => {
  const codes: number[] = [];
  const worker: Drainable = { drain: async () => Promise.reject(new Error("drain")), close: async () => Promise.reject(new Error("close")) };
  await onStopSignal({ worker, exit: (c) => void codes.push(c), on: () => {} })();
  expect(codes).toEqual([0]);
});

test("a request accepted before the stop gets its answer; after the stop, none is taken", async () => {
  let started!: () => void;
  const inFlight = new Promise<void>((r) => (started = r));
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      started();
      await Bun.sleep(500);
      return new Response("done");
    },
  });
  const url = `http://localhost:${server.port}/`;
  const codes: number[] = [];
  const stop = onStopSignal({ server, worker: { drain: async () => {}, close: async () => {} }, deadlineMs: 5_000, exit: (c) => void codes.push(c), on: () => {} });
  const answer = fetch(url).then((r) => r.text());
  await inFlight;
  const stopped = stop();
  expect(await answer).toBe("done");
  await stopped;
  await expect(fetch(url)).rejects.toThrow();
  expect(codes).toEqual([0]);
});
