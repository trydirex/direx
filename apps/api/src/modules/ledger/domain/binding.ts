// SPDX-License-Identifier: AGPL-3.0-only
// What an approval binds, as canonical JSON. Hashing and
// signing need node:crypto, so they live in application/signing.ts.

/** One thing the effect touches: a cited fact, the template, the capability, the connection. */
export type SnapshotEntry = { kind: string; id: string; version: string };

export type Binding = {
  actionId: string;
  draftVersion: number;
  specHash: string;
  snapshot: SnapshotEntry[];
  approverId: string;
  approvedAt: string;
  /** Set only on an approval made by a standing rule. Older approvals have no such field and still verify. */
  standingRuleId?: string | undefined;
  /** Set only by an agent-written rule: a digest of the drafter and the check record behind the words. Never a snapshot entry. */
  producerDigest?: string | undefined;
};

/**
 * Sorted keys, no whitespace, so the same value always gives the same bytes, however
 * jsonb reordered it. Only plain JSON values are allowed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error("canonicalJson: not a plain object");
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  throw new Error(`canonicalJson: unsupported ${typeof value}`);
}

export function bindingBytes(b: Binding): string {
  return canonicalJson(b);
}

/** Snapshot entries whose live version differs or is gone. Empty means unchanged. */
export function changedEntries(snapshot: SnapshotEntry[], live: (string | null)[]): SnapshotEntry[] {
  return snapshot.filter((e, i) => live[i] !== e.version);
}
