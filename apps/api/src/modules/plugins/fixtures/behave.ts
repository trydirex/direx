// SPDX-License-Identifier: AGPL-3.0-only
// Entry file: the behave plugin as a stdio worker.
import { runWorker } from "@direx/plugin-sdk";
import { behavePlugin } from "./behave-plugin";

await runWorker(behavePlugin);
