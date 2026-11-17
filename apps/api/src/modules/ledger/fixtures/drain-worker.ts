// SPDX-License-Identifier: AGPL-3.0-only
// A real worker process for the SIGTERM tests. `test.slow` records the call in the MARKER file
// and is sent 2 seconds later (SLOW_MS to change it); `test.hang` records it and never returns. The
// stop runs with the deadline in DEADLINE_MS, so a test can reach it quickly.
import { appendFileSync } from "node:fs";
import type { EffectCapability } from "@direx/plugin-sdk";
import { onStopSignal } from "../../../shutdown";
import { testWorker } from "../../../compose/fixtures/worker";
import { oneKey } from "../index";
import { testKey } from "../test-effects";

const marker = process.env.MARKER;
if (!marker) throw new Error("MARKER is not set");
const called = () => appendFileSync(marker, "called\n");
const blind = (execute: EffectCapability["execute"]): EffectCapability => ({ dedupe: "blind", reachesPerson: false, execute });

const worker = await testWorker({
  signingKeys: oneKey(testKey),
  effects: {
    "test.slow": blind(async () => {
      called();
      await Bun.sleep(Number(process.env.SLOW_MS ?? 2_000));
      return { kind: "sent" };
    }),
    "test.hang": blind(() => {
      called();
      return new Promise(() => {});
    }),
  },
});
onStopSignal({ worker, deadlineMs: Number(process.env.DEADLINE_MS ?? 10_000) });
console.log("ready");
