// SPDX-License-Identifier: MIT

// Files an effect sends, such as a post's video. A spec names each file by id and hash under its
// top-level `media`, and nowhere else, so the host knows which files the approval covers without
// knowing the spec's shape. At execute the host hands a capability whose manifest grants
// media: "read" a short-lived link to each, and never the bytes themselves.
import { createHash } from "node:crypto";
import { z } from "zod";

export const mediaRef = z.strictObject({
  mediaId: z.string().uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
  contentType: z.string().min(1),
});
/** One approved file. The hash is what the approval binds. */
export type MediaRef = z.infer<typeof mediaRef>;

export const mediaLink = mediaRef.omit({ mediaId: true }).extend({ url: z.string().url() });
/** Where to read one file, for this call only. The link stops working after a few minutes. */
export type MediaLink = z.infer<typeof mediaLink>;

/** The files a spec names, or none. Anything malformed under `media` names none. */
export function mediaRefs(spec: unknown): MediaRef[] {
  const raw = (spec as { media?: unknown } | null)?.media;
  return z.array(mediaRef).safeParse(raw).data ?? [];
}

/** The bytes read are not the ones approved, so nothing may be posted with them. */
export class MediaMismatch extends Error {}

/**
 * Reads a file in parts of `partBytes` (the last may be shorter), holding one part at a time. It
 * throws MediaMismatch after the last part if the length or hash differs from the link's, so a
 * caller that uploads each part and only then creates the post never posts other bytes.
 */
export async function* streamParts(link: MediaLink, partBytes: number, fetchFn: typeof fetch = fetch): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const res = await fetchFn(link.url);
  if (!res.ok || !res.body) throw new Error(`reading the file failed with ${res.status}`);
  const hash = createHash("sha256");
  let total = 0;
  let part = new Uint8Array(partBytes);
  let filled = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk);
    total += chunk.byteLength;
    if (total > link.bytes) throw new MediaMismatch("the file is longer than the one approved");
    let at = 0;
    while (at < chunk.byteLength) {
      const n = Math.min(partBytes - filled, chunk.byteLength - at);
      part.set(chunk.subarray(at, at + n), filled);
      filled += n;
      at += n;
      if (filled === partBytes) {
        yield part;
        part = new Uint8Array(partBytes);
        filled = 0;
      }
    }
  }
  if (total !== link.bytes || hash.digest("hex") !== link.sha256) throw new MediaMismatch("the file is not the one approved");
  if (filled) yield part.subarray(0, filled);
}
