// SPDX-License-Identifier: AGPL-3.0-only
// Who a Facebook login is and which Pages it manages, and publishing as a Page. Page tokens are fetched at
// call time, used in that call and never passed on.
import { accessToken, definePlugin, MediaMismatch, streamParts, type ExecuteResult, type MediaLink, type QueryOutput } from "@direx/plugin-sdk";
import { getJson, healthOf, send, SocialHttpError, socialHttp, tokenOf, VIDEO_WAIT, type SocialPluginOptions } from "../http";
import { held, isRefused, later, MB, notAPost, notConnected, policyBlocked, postSpec, preparePost, rateLimited, type Processing, type Refused, runFollowUps, sent, tokenRejected, untilProcessed, videoOf, type VideoRules } from "../post";
import { facebookManifest } from "./manifest";

/** Expired or invalid token. Meta's other codes cover throttling and permissions, which a reconnect won't fix. */
const DEAD = [190, 102];
/** One page of a person's Pages. Someone who runs more than this sees the first 100. */
const PAGE_LIMIT = 100;
const RECONNECT_CODES = [...DEAD, 492, 10, 3];
const RECONNECT_SUBCODES = [458, 459, 460, 463, 464, 467];
const THROTTLED = [4, 17, 32, 341, 613, 80001];
const BAD_POST: Record<number, string> = { 100: "Facebook refused the text", 506: "Facebook says this is a duplicate post", 1609005: "Facebook refused a link in the post" };

const API_VERSION = "v26.0";
/** Reels take MP4 of 3 to 90 seconds; Meta's Reels page gives no size limit, so this is Direx's [DEFAULT]. */
export const FACEBOOK_VIDEO: VideoRules = { network: "Facebook Reels", types: ["video/mp4"], maxBytes: 1000 * MB };
/** Meta's resumable upload takes a file in any number of parts, each sent with its offset. */
const PART = 8 * 1024 * 1024;

/** Meta states no HTTP status for its errors, so the code decides. Null: not one this plugin can read. */
function refusalOf(code: unknown, subcode: unknown): Refused | null {
  if (typeof code !== "number") return null;
  if (RECONNECT_CODES.includes(code) || (code >= 200 && code <= 299) || (typeof subcode === "number" && RECONNECT_SUBCODES.includes(subcode))) return tokenRejected(`Facebook refused the login or its permission (code ${code})`);
  if (THROTTLED.includes(code)) return rateLimited(`Facebook's rate limit (code ${code})`);
  if (code === 368) return policyBlocked("Facebook is blocking this action under its policies (code 368)");
  return BAD_POST[code] ? held(BAD_POST[code]) : null;
}

export function createFacebookPlugin(o: SocialPluginOptions & { uploadUrl?: string } = {}) {
  const h = socialHttp(o, `https://graph.facebook.com/${API_VERSION}`);
  const rupload = o.uploadUrl ?? `https://rupload.facebook.com/video-upload/${API_VERSION}`;

  /** A Meta error on a call before anything is published: a refusal it names, or worth a retry. */
  const before = (r: { status: number; body: Record<string, unknown> | null }, what: string): Refused => {
    const error = r.body?.error as { code?: unknown; error_subcode?: unknown } | undefined;
    return refusalOf(error?.code, error?.error_subcode) ?? (r.status >= 400 && r.status < 500 ? held(`Facebook refused ${what}`) : later(`Facebook answered ${r.status} to ${what}`));
  };

  /**
   * Uploads the approved video as a Reel. Nothing is published until `publishReel`, so any failure
   * here is safe to retry, except bytes that aren't the ones approved.
   */
  async function uploadReel(pageId: string, page: string, link: MediaLink): Promise<string | Refused> {
    const start = await send(h, `/${encodeURIComponent(pageId)}/video_reels`, { headers: { authorization: `Bearer ${page}` }, form: { upload_phase: "start" } });
    const videoId = start.body?.video_id;
    if (start.status >= 300 || typeof videoId !== "string") return before(start, "the Reel upload");
    let offset = 0;
    try {
      for await (const part of streamParts(link, PART, h.fetch)) {
        const r = await h.fetch(`${rupload}/${encodeURIComponent(videoId)}`, {
          method: "POST",
          headers: { authorization: `OAuth ${page}`, offset: String(offset), file_size: String(link.bytes) },
          body: part,
          signal: AbortSignal.timeout(h.timeoutMs),
        });
        if (!r.ok) return later(`Facebook answered ${r.status} to an upload part`);
        offset += part.length;
      }
    } catch (e) {
      if (e instanceof MediaMismatch) return held("the video is not the one approved, so it was not posted");
      return later("the video upload to Facebook failed");
    }
    return videoId;
  }

  /** Meta's three phases, read as one: published, still working, or failed with its message. */
  async function reelStatus(videoId: string, page: string): Promise<Processing> {
    type Phase = { status?: string; errors?: { message?: string }[] };
    const s = await getJson<{ status?: { video_status?: string; processing_phase?: Phase; publishing_phase?: Phase } }>(h, `/${encodeURIComponent(videoId)}?fields=status`, page).catch(() => null);
    const st = s?.status;
    const failed = [st?.processing_phase, st?.publishing_phase].find((p) => p?.status === "error");
    if (st?.video_status === "error" || failed) return { state: "failed", detail: failed?.errors?.[0]?.message ?? "no reason given" };
    return st?.publishing_phase?.status === "complete" ? { state: "ready" } : { state: "processing" };
  }
  const me = (token: string) => getJson<{ id: string; name?: string }>(h, "/me?fields=id,name", token);

  /** Nothing can have posted yet, so every failure here is a definite refusal. */
  async function pageToken(token: string, pageId: string): Promise<string | Refused> {
    try {
      const pages = await getJson<{ data?: { id: string; access_token?: string }[] }>(h, `/me/accounts?fields=id,access_token&limit=${PAGE_LIMIT}`, token);
      return pages.data?.find((p) => p.id === pageId)?.access_token ?? held("this login no longer manages that Page");
    } catch (e) {
      return (e instanceof SocialHttpError && e.status < 500 && refusalOf(e.networkCode, undefined)) || later("could not read this login's Pages");
    }
  }

  async function write(path: string, token: string, message: string): Promise<{ id: string } | Refused> {
    const r = await send(h, path, { headers: { authorization: `Bearer ${token}` }, form: { message } });
    // A 5xx stays unknown even with a code in it: that is the safe reading on a write.
    if (r.status >= 500) throw new SocialHttpError(r.status);
    const error = r.body?.error as { code?: unknown; error_subcode?: unknown } | undefined;
    if (!error && r.status < 300 && typeof r.body?.id === "string") return { id: r.body.id };
    const refusal = refusalOf(error?.code, error?.error_subcode);
    if (refusal) return refusal;
    // Codes 1 and 2 are "temporary" in Meta's docs, and land here with everything unrecognised.
    throw new SocialHttpError(r.status);
  }

  return definePlugin({
    manifest: facebookManifest,
    effects: {
      "social.publish": {
        prepare: async (input) => preparePost(input, { needsTarget: true, maxFollowUps: Number.MAX_SAFE_INTEGER, video: FACEBOOK_VIDEO }),

        async execute(raw, ctx): Promise<ExecuteResult> {
          const token = accessToken(ctx.credential);
          if (!token) return notConnected();
          const spec = postSpec(raw);
          if (!spec?.target) return notAPost();
          const page = await pageToken(token, spec.target);
          if (typeof page !== "string") return page;
          const video = videoOf(spec);
          if (video) {
            const link = ctx.media?.[video.mediaId];
            if (!link) return held("the approved video was not handed to this post");
            const videoId = await uploadReel(spec.target, page, link);
            if (typeof videoId !== "string") return videoId;
            // From here the Reel is published once Facebook has processed it.
            const done = await send(h, `/${encodeURIComponent(spec.target)}/video_reels`, { headers: { authorization: `Bearer ${page}` }, form: { upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED", description: spec.text } });
            if (done.status >= 500) throw new SocialHttpError(done.status);
            if (done.status >= 300 || done.body?.success !== true) return before(done, "the Reel");
            const ready = await untilProcessed(() => reelStatus(videoId, page), o.videoWait ?? VIDEO_WAIT, "Facebook");
            // ponytail: still processing at the end reads as sent, since Facebook publishes it by itself. A Reel that fails after that shows only on Facebook.
            if (ready !== true && !ready.retryable) return ready;
            const followUps = await runFollowUps(spec.followUps, async (text) => {
              const r = await write(`/${encodeURIComponent(videoId)}/comments`, page, text);
              return isRefused(r) ? r : {};
            });
            return sent(videoId, `https://www.facebook.com/reel/${videoId}`, followUps);
          }
          const post = await write(`/${encodeURIComponent(spec.target)}/feed`, page, spec.text);
          if (isRefused(post)) return post;
          const id = encodeURIComponent(post.id);
          const url = await getJson<{ permalink_url?: unknown }>(h, `/${id}?fields=permalink_url`, page).then((r) => (typeof r.permalink_url === "string" ? r.permalink_url : undefined), () => undefined);
          const followUps = await runFollowUps(spec.followUps, async (text) => {
            const r = await write(`/${id}/comments`, page, text);
            return isRefused(r) ? r : {};
          });
          return sent(post.id, url, followUps);
        },
      },
    },
    queries: {
      "social.identity": async (_input, ctx): Promise<QueryOutput<"social.identity">> => {
        const token = tokenOf(ctx.credential);
        const [u, permissions, pages] = await Promise.all([
          me(token),
          getJson<{ data?: { permission: string; status: string }[] }>(h, "/me/permissions", token),
          getJson<{ data?: { id: string; name: string }[] }>(h, `/me/accounts?fields=id,name&limit=${PAGE_LIMIT}`, token),
        ]);
        return {
          accountId: u.id,
          accountLabel: u.name ?? "Facebook account",
          scopes: (permissions.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission),
          targets: (pages.data ?? []).map((p) => ({ id: p.id, name: p.name, type: "page" })),
        };
      },
      "social.health": async (_input, ctx) => healthOf(() => me(tokenOf(ctx.credential)), [401], DEAD),
    },
  });
}
