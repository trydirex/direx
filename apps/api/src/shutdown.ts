// SPDX-License-Identifier: AGPL-3.0-only
// How a Direx process stops (ADR 0027 rule 004). On SIGTERM or SIGINT it stops taking requests
// and jobs, waits for what it already started, and exits once that has settled or the deadline
// has passed. Work still running at the deadline is left as a SIGKILL would leave it, for ledger
// recovery. A second signal exits at once.
import { MAX_EFFECT_TIMEOUT_MS } from "@direx/plugin-sdk";

// ponytail: one fixed deadline, the longest an effect may declare plus margin; compute it from loaded effects if self-host without social plugins needs faster stops.
export const DRAIN_DEADLINE_MS = MAX_EFFECT_TIMEOUT_MS + 30_000;

/** What a stop drains: stops claiming jobs and waits up to `ms` for those running, then closes. */
export type Drainable = { drain: (ms: number) => Promise<void>; close: () => Promise<void> };
/** Bun's server: `stop(false)` refuses new connections and waits for open ones; `stop(true)` drops them. */
export type Stoppable = { stop: (closeActiveConnections?: boolean) => Promise<void> | void };

type Options = {
  worker: Drainable;
  server?: Stoppable;
  deadlineMs?: number;
  exit?: (code: number) => void;
  on?: (signal: "SIGTERM" | "SIGINT", handler: () => void) => void;
};

/** Installs the stop on SIGTERM and SIGINT, and returns it so a test can call it without a signal. */
export function onStopSignal({ worker, server, deadlineMs = DRAIN_DEADLINE_MS, exit = (code) => process.exit(code), on = (s, h) => process.on(s, h) }: Options) {
  let stopping = false;
  const stop = async () => {
    if (stopping) return exit(1);
    stopping = true;
    const started = Date.now();
    console.log(`direx: stopping; waiting up to ${Math.round(deadlineMs / 1000)} s for work in flight`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => (timer = setTimeout(() => resolve("deadline"), deadlineMs)));
    const settled = Promise.all([server?.stop(false), worker.drain(deadlineMs)]).then(
      () => "settled" as const,
      (e: unknown) => (console.error("direx: a drain failed:", e), "settled" as const),
    );
    const how = await Promise.race([settled, deadline]);
    clearTimeout(timer);
    try {
      await server?.stop(true);
      await worker.close();
    } catch (e) {
      console.error("direx: closing failed:", e);
    }
    console.log(`direx: stopped after ${((Date.now() - started) / 1000).toFixed(1)} s${how === "deadline" ? ", at the deadline" : ""}`);
    exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) on(signal, () => void stop());
  return stop;
}
