// SPDX-License-Identifier: AGPL-3.0-only
// Test only: startWorker with every feature port a test leaves out taken from the ports createApp
// builds, the same ones runServer hands the worker. So a test reaches the handlers production runs,
// not fakes (ADR 0027 rule 003).
import { createApp } from "../../main";
import { startWorker, type WorkerOptions } from "../../worker";

type Worker = Awaited<ReturnType<typeof startWorker>>;

export async function testWorker(opts: Partial<WorkerOptions>): Promise<Worker> {
  // The server's modules read the worker back through this getter, as in runServer.
  let worker: Worker | undefined;
  const { ports } = createApp({ worker: () => worker });
  worker = await startWorker({ ...ports, ...opts });
  return worker;
}
