// SPDX-License-Identifier: AGPL-3.0-only
// A link that opens one file for a few minutes with no sign-in, for a plugin publishing an approved
// post. The token is the proof: it names the Workspace, the file and the end, signed together.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Long enough to upload a large video, short enough that a leaked link soon stops working [DEFAULT]. */
export const LINK_MS = 15 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sign = (secret: string, workspaceId: string, mediaId: string, until: number) =>
  createHmac("sha256", secret).update(`media-link\n${workspaceId}\n${mediaId}\n${until}`).digest("base64url");

export function linkToken(secret: string, workspaceId: string, mediaId: string, now: Date): string {
  const until = Math.floor((now.getTime() + LINK_MS) / 1000);
  return `${workspaceId}.${mediaId}.${until}.${sign(secret, workspaceId, mediaId, until)}`;
}

/** The file a token opens, or null for one that is malformed, altered or past its end. */
export function readLinkToken(secret: string, token: string, now: Date): { workspaceId: string; mediaId: string } | null {
  const [workspaceId, mediaId, until, mac, ...rest] = token.split(".");
  if (rest.length || !workspaceId || !mediaId || !mac || !UUID.test(workspaceId) || !UUID.test(mediaId) || !/^\d{1,12}$/.test(until ?? "")) return null;
  const expected = Buffer.from(sign(secret, workspaceId, mediaId, Number(until)));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return Number(until) * 1000 > now.getTime() ? { workspaceId, mediaId } : null;
}
