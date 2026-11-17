// SPDX-License-Identifier: AGPL-3.0-only
import { MAX_EFFECT_TIMEOUT_MS } from "@direx/plugin-sdk";
import { socialManifest } from "../http";

export const facebookManifest = socialManifest({ id: "com.trydirex.facebook", connection: "facebook", hosts: ["graph.facebook.com", "rupload.facebook.com"], publish: { dedupe: "blind", media: "read", timeoutMs: MAX_EFFECT_TIMEOUT_MS } });
