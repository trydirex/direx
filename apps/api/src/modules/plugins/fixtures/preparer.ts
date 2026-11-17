// SPDX-License-Identifier: AGPL-3.0-only
// Entry file: the preparer plugin as a stdio worker.
import { runWorker } from "@direx/plugin-sdk";
import { preparerPlugin } from "./preparer-plugin";

await runWorker(preparerPlugin);
