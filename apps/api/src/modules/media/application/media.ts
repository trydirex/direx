// SPDX-License-Identifier: AGPL-3.0-only
// Keeping a person's video: upload streamed to the store with its size and hash, read back, and deleted.
// An upload is never held in memory; past the cap the stream is cut and nothing is kept.
import { insertMedia, liveMedia, liveSources, markBytesRemoved, markDeleted, MEDIA_MAX_BYTES, sweepDue, type MediaRow } from "../adapters/repo";
import { mediaKey, type Store, type Stored } from "../adapters/store";
import type { MediaLink, MediaRef } from "@direx/plugin-sdk";
import { linkToken, readLinkToken } from "./link-token";
import { isImage, SNIFF_BYTES, sniff } from "../domain/sniff";

export type MediaKind = "source" | "clip";
/** The largest image a post may carry: 10 MB [DEFAULT]. Networks take less; each plugin checks its own. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export type MediaView = Pick<MediaRow, "id" | "contentType" | "bytes" | "fileName" | "createdAt"> & { kind: MediaKind };
export type UploadRefusal = "not_supported" | "too_large";

/** Clipping takes minutes, so a source older than this has done its job [DEFAULT]. Clips never age out. */
export const SOURCE_DAYS = 7;

export type Upload = {
  workspaceId: string;
  userId: string;
  kind: MediaKind;
  /** As sent, possibly percent-encoded; cleaned here. */
  fileName: string | undefined;
  /** The Content-Length, when the client sent one, so an upload that is too large is refused unread. */
  declaredBytes: number | undefined;
  body: ReadableStream<Uint8Array> | null;
};

export type MediaDeps = {
  store: () => Store;
  now: () => Date;
  /** Only tests change this. */
  maxBytes?: number;
  /** For links a plugin reads a file through: this deployment's address and the key that signs them. */
  links?: { baseUrl: () => string; secret: () => string };
};

class TooLarge extends Error {}

// The table allows only these two kinds.
const view = (r: MediaRow): MediaView => ({ id: r.id, kind: r.kind as MediaKind, contentType: r.contentType, bytes: r.bytes, fileName: r.fileName, createdAt: r.createdAt });

/** A name that isn't valid percent-encoding is kept as sent. */
function decoded(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** What a person sees as the file's name: decoded, without control characters, at most 255 characters. */
export function cleanFileName(raw: string | undefined): string {
  const clean = Array.from(decoded(raw ?? "").replace(/\p{Cc}/gu, "").trim()).slice(0, 255).join("");
  return clean || "upload";
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export function createMedia(deps: MediaDeps) {
  const max = deps.maxBytes ?? MEDIA_MAX_BYTES;

  async function upload(u: Upload): Promise<{ ok: true; media: MediaView } | { ok: false; reason: UploadRefusal }> {
    if (u.declaredBytes !== undefined && u.declaredBytes > max) return { ok: false, reason: "too_large" };
    if (!u.body) return { ok: false, reason: "not_supported" };
    const reader = u.body.getReader();
    const head: Uint8Array[] = [];
    let seen = 0;
    let ended = false;
    while (seen < SNIFF_BYTES) {
      const r = await reader.read();
      if (r.done) {
        ended = true;
        break;
      }
      head.push(r.value);
      seen += r.value.length;
    }
    const first = concat(head);
    const type = sniff(first);
    if (!type.ok) {
      await reader.cancel();
      return { ok: false, reason: "not_supported" };
    }
    // An image is a post's picture, not footage: it gets a far smaller cap.
    const limit = isImage(type.contentType) ? Math.min(max, IMAGE_MAX_BYTES) : max;
    if (u.declaredBytes !== undefined && u.declaredBytes > limit) {
      await reader.cancel();
      return { ok: false, reason: "too_large" };
    }

    const hasher = new Bun.CryptoHasher("sha256");
    let bytes = 0;
    const counted = (chunk: Uint8Array) => {
      bytes += chunk.length;
      if (bytes > limit) throw new TooLarge();
      hasher.update(chunk);
      return chunk;
    };
    // Everything goes through pull: a throw there errors the stream, where one in start would escape it.
    let pending: Uint8Array | null = first;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (pending) {
          const chunk = pending;
          pending = null;
          return c.enqueue(counted(chunk));
        }
        const r = ended ? { done: true as const } : await reader.read();
        if (r.done) return c.close();
        c.enqueue(counted(r.value));
      },
      cancel: (reason) => reader.cancel(reason),
    });

    const id = crypto.randomUUID();
    const key = mediaKey(u.workspaceId, id);
    const store = deps.store();
    try {
      await store.put(key, body);
    } catch (e) {
      if (!(e instanceof TooLarge) && bytes <= limit) throw e;
      // Stops reading the rest of an upload that is already refused.
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too_large" };
    }
    try {
      const row = await insertMedia({
        id,
        workspaceId: u.workspaceId,
        kind: u.kind,
        contentType: type.contentType,
        bytes,
        sha256: hasher.digest("hex"),
        storageKey: key,
        fileName: cleanFileName(u.fileName),
        uploadedBy: u.userId,
        createdAt: deps.now(),
      });
      return { ok: true, media: view(row) };
    } catch (e) {
      // No row, so no bytes either.
      await store.remove(key);
      throw e;
    }
  }

  /** The file and where its bytes are, or null when there is no live file with this id here. */
  async function read(workspaceId: string, id: string): Promise<{ media: MediaView; stored: Stored } | null> {
    const row = await liveMedia(workspaceId, id);
    if (!row) return null;
    return { media: view(row), stored: await deps.store().read(row.storageKey) };
  }

  /** What a post records to bind this file: its id, hash, size and type. Null when there is no live file. */
  async function ref(workspaceId: string, id: string): Promise<(MediaRef & { fileName: string }) | null> {
    const row = await liveMedia(workspaceId, id);
    return row ? { mediaId: row.id, sha256: row.sha256, bytes: row.bytes, contentType: row.contentType, fileName: row.fileName } : null;
  }

  /**
   * A short-lived link to the approved file, for a plugin publishing it. Null when the file was deleted
   * or its row no longer matches what was approved, so the post waits for a person instead.
   */
  async function link(workspaceId: string, r: MediaRef): Promise<MediaLink | null> {
    const row = await liveMedia(workspaceId, r.mediaId);
    if (!row || row.sha256 !== r.sha256 || row.bytes !== r.bytes) return null;
    const stored = await deps.store().read(row.storageKey);
    const at = (): string => {
      if (stored.kind === "url") return stored.url;
      if (!deps.links) throw new Error("media: links need the deployment's address and a signing key");
      return `${deps.links.baseUrl()}/api/media-links/${linkToken(deps.links.secret(), workspaceId, row.id, deps.now())}`;
    };
    return { url: at(), sha256: row.sha256, bytes: row.bytes, contentType: row.contentType };
  }

  /** The file a link token opens, while the token and the file both last. */
  async function readLink(token: string): Promise<{ media: MediaView; stored: Stored } | null> {
    const t = deps.links && readLinkToken(deps.links.secret(), token, deps.now());
    return t ? read(t.workspaceId, t.mediaId) : null;
  }

  /** Marks a file deleted; its bytes go at the next sweep. */
  const remove = (workspaceId: string, id: string): Promise<boolean> => markDeleted(workspaceId, id, deps.now());

  /**
   * The daily sweep: sources older than SOURCE_DAYS are deleted, and every deleted file loses its bytes.
   * A file the store can't remove is logged and left for the next run; the others carry on.
   */
  async function sweep(): Promise<{ removed: number; failed: number }> {
    const at = deps.now();
    const store = deps.store();
    let removed = 0;
    let failed = 0;
    for (const f of await sweepDue(at, SOURCE_DAYS)) {
      try {
        await store.remove(f.storageKey);
        await markBytesRemoved(f.workspaceId, f.id, at);
        removed++;
      } catch (e) {
        failed++;
        console.error(`media: sweep could not remove ${f.storageKey}, trying again next run:`, e);
      }
    }
    return { removed, failed };
  }

  /** The newest uploaded videos, their ids and file names. */
  const sources = (workspaceId: string, limit = 20) => liveSources(workspaceId, limit);

  return { upload, read, ref, link, readLink, remove, sweep, sources };
}

export type Media = ReturnType<typeof createMedia>;
