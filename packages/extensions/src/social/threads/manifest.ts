// SPDX-License-Identifier: AGPL-3.0-only
import { MAX_EFFECT_TIMEOUT_MS } from "@direx/plugin-sdk";
import { socialManifest } from "../http";

export const threadsManifest = socialManifest({ id: "com.trydirex.threads", connection: "threads", hosts: ["graph.threads.com"], publish: { dedupe: "blind", media: "read", timeoutMs: MAX_EFFECT_TIMEOUT_MS } });
