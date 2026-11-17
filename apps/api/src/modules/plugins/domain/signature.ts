// SPDX-License-Identifier: AGPL-3.0-only
// The signature header of an hmac_sha256 webhook: lowercase hex, with or without a
// "sha256=" prefix. Anything else is no signature at all.

export function parseSignatureHeader(value: string | undefined): string | null {
  if (!value) return null;
  const hex = value.trim().replace(/^sha256=/i, "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** Header lookup ignores case, as HTTP does. */
export function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
  return undefined;
}
