// SPDX-License-Identifier: AGPL-3.0-only
import { MAX_EFFECT_TIMEOUT_MS } from "@direx/plugin-sdk";
import { socialManifest } from "../http";

export const blueskyManifest = socialManifest({ id: "com.trydirex.bluesky", connection: "bluesky", auth: "basic", hosts: ["bsky.social", "video.bsky.app"], publish: { dedupe: "queryable", media: "read", timeoutMs: MAX_EFFECT_TIMEOUT_MS } });
