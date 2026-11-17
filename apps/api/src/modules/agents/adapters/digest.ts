// SPDX-License-Identifier: AGPL-3.0-only
// Digests for the run record: what was read, never the text.
import { createHash } from "node:crypto";

export const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Order matters: the same parts read in another order are a different context. */
export const aggregateDigest = (parts: readonly { digest: string }[]): string => digestOf(parts.map((p) => p.digest).join("\n"));
