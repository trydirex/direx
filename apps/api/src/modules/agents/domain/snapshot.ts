// SPDX-License-Identifier: AGPL-3.0-only
// Pure: how much of one page's text is kept.

/** What is kept of one page's text, in bytes. */
export const MAX_SNAPSHOT_BYTES = 200 * 1024;

export function capped(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_SNAPSHOT_BYTES) return text;
  // A cut through a multi-byte character decodes to a replacement character, which is dropped.
  return new TextDecoder().decode(bytes.subarray(0, MAX_SNAPSHOT_BYTES)).replace(/�$/, "");
}
