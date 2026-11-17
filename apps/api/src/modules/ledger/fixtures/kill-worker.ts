// SPDX-License-Identifier: AGPL-3.0-only
// A real worker process for the SIGKILL test. Its one effect records the call in the
// MARKER file and never returns, so the test can kill it mid-call.
import { appendFileSync } from "node:fs";
import { testWorker } from "../../../compose/fixtures/worker";
import { oneKey } from "../index";
import { testKey } from "../test-effects";

const marker = process.env.MARKER;
if (!marker) throw new Error("MARKER is not set");

await testWorker({
  signingKeys: oneKey(testKey),
  effects: {
    "test.kill": {
      dedupe: "blind",
      reachesPerson: false,
      execute: () => {
        appendFileSync(marker, "called\n");
        return new Promise(() => {});
      },
    },
  },
});
