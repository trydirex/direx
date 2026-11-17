// SPDX-License-Identifier: AGPL-3.0-only
// The one byte form of a signed document: JSON with object keys sorted at every level and no
// whitespace, so a signer and every install sign and hash the same bytes.

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A signed document without its signatures: what is signed and hashed. */
export function unsigned<T extends { signatures: unknown }>(doc: T): Omit<T, "signatures"> {
  const { signatures: _, ...rest } = doc;
  return rest;
}
