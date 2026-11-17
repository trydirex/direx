// SPDX-License-Identifier: AGPL-3.0-only
// Two plugins on two apps, because LinkedIn's Community Management product must sit on an app with no
// other products. The Page app only reads.
import { MAX_EFFECT_TIMEOUT_MS } from "@direx/plugin-sdk";
import { socialManifest } from "../http";

export const linkedinManifest = socialManifest({ id: "com.trydirex.linkedin", connection: "linkedin", hosts: ["api.linkedin.com", "www.linkedin.com"], publish: { dedupe: "blind", media: "read", timeoutMs: MAX_EFFECT_TIMEOUT_MS } });
export const linkedinPageManifest = socialManifest({ id: "com.trydirex.linkedin-page", connection: "linkedin_page", hosts: ["api.linkedin.com"] });
