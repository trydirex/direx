// SPDX-License-Identifier: AGPL-3.0-only
import { MAX_EFFECT_TIMEOUT_MS } from "@direx/plugin-sdk";
import { socialManifest } from "../http";

export const xManifest = socialManifest({ id: "com.trydirex.x", connection: "x", hosts: ["api.x.com"], publish: { dedupe: "blind", media: "read", timeoutMs: MAX_EFFECT_TIMEOUT_MS } });
