// SPDX-License-Identifier: AGPL-3.0-only
// Files in an S3-compatible bucket, through the client built into Bun. Reads are short-lived links,
// so video bytes go from the bucket to the browser without passing through the API.
import { checkKey, type Store } from "./store";

export type S3Config = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };

const FORM = "media.s3 must look like https://<access key>:<secret>@<host>/<bucket>?region=<region>";
/** A read link lives 15 minutes [DEFAULT]: long enough to start a video, short enough not to pass around. */
const LINK_SECONDS = 15 * 60;
/** 8 MiB parts [DEFAULT]; S3 wants at least 5 MiB, and a 2 GiB file stays well under 10,000 parts. */
const PART_BYTES = 8 * 1024 * 1024;

/** Reads the media.s3 system secret. Errors name the expected form and never echo the value. */
export function parseS3Url(value: string): S3Config {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(FORM);
  }
  const bucket = u.pathname.replace(/^\/|\/$/g, "");
  if (!["https:", "http:"].includes(u.protocol) || !u.username || !u.password || !bucket || bucket.includes("/")) throw new Error(FORM);
  return {
    endpoint: `${u.protocol}//${u.host}`,
    bucket,
    region: u.searchParams.get("region") ?? "auto",
    accessKeyId: decodeURIComponent(u.username),
    secretAccessKey: decodeURIComponent(u.password),
  };
}

export function s3Store(config: S3Config): Store {
  const client = new Bun.S3Client(config);
  return {
    async put(key, body) {
      const writer = client.file(checkKey(key)).writer({ partSize: PART_BYTES });
      try {
        for await (const chunk of body) await writer.write(chunk);
        await writer.end();
      } catch (e) {
        // ponytail: an unfinished multipart upload may keep its parts until a bucket lifecycle rule clears them.
        await Promise.resolve(writer.end(e as Error)).catch(() => undefined);
        await client.unlink(key).catch(() => undefined);
        throw e;
      }
    },
    async read(key) {
      return { kind: "url", url: client.presign(checkKey(key), { expiresIn: LINK_SECONDS }) };
    },
    remove(key) {
      return client.unlink(checkKey(key));
    },
  };
}
