// SPDX-License-Identifier: AGPL-3.0-only
// The one byte range a player asked for, inclusive at both ends.

export type ByteRange = { start: number; end: number };

/** Null means serve the whole file: no header, several ranges, or one that doesn't parse. */
export function byteRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  const m = header && /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const last = Number(m[2]);
    return last === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(0, size - last), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size) return "unsatisfiable";
  return end < start ? null : { start, end };
}
