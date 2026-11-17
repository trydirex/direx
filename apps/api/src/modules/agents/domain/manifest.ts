// SPDX-License-Identifier: AGPL-3.0-only
// Pure: what a run records about what it read. Digests only, never the text.

export type ManifestPart = { kind: string; refId: string; version: string | null; digest: string; trust: "trusted" | "untrusted"; truncated: boolean };
