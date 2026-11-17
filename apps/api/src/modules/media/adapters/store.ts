// SPDX-License-Identifier: AGPL-3.0-only
// Where a file's bytes live. Disk on self-host, object storage on cloud; the rest of the module sees only this.

/** Disk hands back the file, so a video seeks; object storage hands back a short-lived link. */
export type Stored = { kind: "file"; file: Blob } | { kind: "url"; url: string };

export type Store = {
  /** Writes the whole stream, or nothing: a stream that fails leaves no bytes behind. */
  put(key: string, body: ReadableStream<Uint8Array>): Promise<void>;
  read(key: string): Promise<Stored>;
  /** Removing what isn't there is not an error, so a sweep can run again. */
  remove(key: string): Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A storage key is built from ids only, never from anything a person typed. */
export function mediaKey(workspaceId: string, mediaId: string): string {
  if (!UUID.test(workspaceId) || !UUID.test(mediaId)) throw new Error("media: a key is a Workspace id and a media id");
  return `${workspaceId}/${mediaId}`;
}

/** Refuses anything that isn't a key mediaKey made, before a store touches a path. */
export function checkKey(key: string): string {
  const parts = key.split("/");
  if (parts.length !== 2) throw new Error("media: not a media key");
  return mediaKey(parts[0]!, parts[1]!);
}
