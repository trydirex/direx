// SPDX-License-Identifier: AGPL-3.0-only
// What an upload is, from its first bytes. A browser's Content-Type is a guess at best, so it decides nothing.

export type VideoType = "video/mp4" | "video/quicktime" | "video/webm";
/** The images a post may carry. No SVG: it can carry script. */
export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type Sniffed = { ok: true; contentType: VideoType | ImageType } | { ok: false; reason: "not_supported" };

/** How many bytes sniff needs to see. */
export const SNIFF_BYTES = 12;

const EBML = [0x1a, 0x45, 0xdf, 0xa3];
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

export const isImage = (contentType: string) => contentType.startsWith("image/");

export function sniff(first: Uint8Array): Sniffed {
  if (first.length < SNIFF_BYTES) return { ok: false, reason: "not_supported" };
  if (first[0] === 0x89 && ascii(first, 1, 4) === "PNG") return { ok: true, contentType: "image/png" };
  if (first[0] === 0xff && first[1] === 0xd8 && first[2] === 0xff) return { ok: true, contentType: "image/jpeg" };
  if (ascii(first, 0, 4) === "GIF8") return { ok: true, contentType: "image/gif" };
  if (ascii(first, 0, 4) === "RIFF" && ascii(first, 8, 12) === "WEBP") return { ok: true, contentType: "image/webp" };
  // ponytail: any EBML file reads as WebM, Matroska included; the clip engine refuses what it can't decode.
  if (EBML.every((v, i) => first[i] === v)) return { ok: true, contentType: "video/webm" };
  if (ascii(first, 4, 8) !== "ftyp") return { ok: false, reason: "not_supported" };
  // An ISO media file names its brand right after ftyp; "qt  " is QuickTime, which iPhones record.
  return { ok: true, contentType: ascii(first, 8, 12) === "qt  " ? "video/quicktime" : "video/mp4" };
}
