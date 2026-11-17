// SPDX-License-Identifier: AGPL-3.0-only
// Who an X login is, and publishing a post. Every read here is billed per call, about $0.01, so the daily
// sweep skips it and publishing reads nothing back.
import { accessToken, definePlugin, MediaMismatch, streamParts, type ExecuteResult, type MediaLink, type QueryOutput } from "@direx/plugin-sdk";
import { getJson, healthOf, send, SocialHttpError, socialHttp, tokenOf, VIDEO_WAIT, type SocialHttp, type SocialPluginOptions } from "../http";
import { findLinks, graphemes, held, isEmoji, later, MB, notAPost, notConnected, postSpec, preparePost, rateLimited, sent, tokenRejected, untilProcessed, videoOf, type Processing, type Refused, type VideoRules } from "../post";
import { xManifest } from "./manifest";

const LIMIT = 280;
/** X takes far more, but one upload must fit in the five minutes a publish may take [DEFAULT]. */
export const X_VIDEO: VideoRules = { network: "X", types: ["video/mp4"], maxBytes: 512 * MB };
/** X's docs cap each appended segment at 5 MB. */
const SEGMENT = 4 * 1024 * 1024;

type ProcessingInfo = { state?: string; error?: { message?: string } } | undefined;
const processingOf = (info: ProcessingInfo): Processing => {
  if (!info || info.state === "succeeded") return { state: "ready" };
  if (info.state === "failed") return { state: "failed", detail: info.error?.message ?? "no reason given" };
  return { state: "processing" };
};

/** Uploads the approved video in segments and waits for X to process it. Nothing is posted yet. */
async function uploadVideo(h: SocialHttp, token: string, link: MediaLink, wait: SocialPluginOptions["videoWait"]): Promise<string | Refused> {
  const auth = { authorization: `Bearer ${token}` };
  const init = await send(h, "/2/media/upload/initialize", { headers: auth, json: { media_type: link.contentType, total_bytes: link.bytes, media_category: "tweet_video" } });
  if (init.status === 401) return tokenRejected("X refused the token");
  if (init.status === 403) return held("X refused the video upload; this connection or app may not have media access");
  if (init.status === 429) return rateLimited("X's rate limit");
  const id = (init.body?.data as { id?: unknown } | undefined)?.id;
  if (init.status >= 300 || typeof id !== "string") return init.status === 400 ? held("X refused the video") : later(`X answered ${init.status} to the upload`);
  let index = 0;
  try {
    for await (const part of streamParts(link, SEGMENT, h.fetch)) {
      const form = new FormData();
      form.set("segment_index", String(index));
      form.set("media", new Blob([part]));
      const r = await h.fetch(`${h.baseUrl}/2/media/upload/${encodeURIComponent(id)}/append`, { method: "POST", headers: auth, body: form, signal: AbortSignal.timeout(h.timeoutMs) });
      if (!r.ok) return later(`X answered ${r.status} to an upload part`);
      index++;
    }
  } catch (e) {
    if (e instanceof MediaMismatch) return held("the video is not the one approved, so it was not posted");
    return later("the video upload to X failed");
  }
  const done = await send(h, `/2/media/upload/${encodeURIComponent(id)}/finalize`, { headers: auth });
  if (done.status >= 300) return done.status === 400 ? held("X refused the uploaded video") : later(`X answered ${done.status} when finishing the upload`);
  let info = (done.body?.data as { processing_info?: ProcessingInfo } | undefined)?.processing_info;
  const status = async (): Promise<Processing> => {
    const now = processingOf(info);
    if (now.state !== "processing") return now;
    const r = await send(h, `/2/media/upload?${new URLSearchParams({ command: "STATUS", media_id: id })}`, { method: "GET", headers: auth });
    info = (r.body?.data as { processing_info?: ProcessingInfo } | undefined)?.processing_info;
    // An answer with no processing state yet is read as still working, not as done.
    return r.status < 300 && info ? processingOf(info) : { state: "processing" };
  };
  const ready = await untilProcessed(status, wait ?? VIDEO_WAIT, "X");
  return ready === true ? id : ready;
}
const URL_WEIGHT = 23;

const isLatinOrPunctuation = (cp: number) => cp <= 0x24f || (cp >= 0x1e00 && cp <= 0x1eff) || (cp >= 0x2000 && cp <= 0x206f);
const weigh = (text: string) => graphemes(text).reduce((sum, g) => sum + (isEmoji(g) ? 2 : [...g].reduce((n, c) => n + (isLatinOrPunctuation(c.codePointAt(0)!) ? 1 : 2), 0)), 0);

// ponytail: X's docs give weights by kind of character, not ranges, and name twitter-text for exact counts. This overcounts some scripts, such as Cyrillic, if X weighs them as 1. twitter-text is the upgrade once a dependency is agreed.
export function xCount(raw: string): number {
  const text = raw.normalize("NFC");
  let used = 0;
  let at = 0;
  for (const l of findLinks(text)) {
    used += weigh(text.slice(at, l.start)) + URL_WEIGHT;
    at = l.end;
  }
  return used + weigh(text.slice(at));
}

export function createXPlugin(o: SocialPluginOptions = {}) {
  const h = socialHttp(o, "https://api.x.com");
  const me = (token: string) => getJson<{ data: { id: string; username: string; name?: string } }>(h, "/2/users/me", token);
  return definePlugin({
    manifest: xManifest,
    effects: {
      "social.publish": {
        prepare: async (input) => preparePost(input, { maxFollowUps: 0, count: (text) => ({ used: xCount(text), limit: LIMIT }), video: X_VIDEO }),

        async execute(raw, ctx): Promise<ExecuteResult> {
          const token = accessToken(ctx.credential);
          if (!token) return notConnected();
          const spec = postSpec(raw);
          if (!spec) return notAPost();
          const video = videoOf(spec);
          let mediaId: string | undefined;
          if (video) {
            const link = ctx.media?.[video.mediaId];
            if (!link) return held("the approved video was not handed to this post");
            const up = await uploadVideo(h, token, link, o.videoWait);
            if (typeof up !== "string") return up;
            mediaId = up;
          }
          const r = await send(h, "/2/tweets", { headers: { authorization: `Bearer ${token}` }, json: { text: spec.text, ...(mediaId && { media: { media_ids: [mediaId] } }) } });
          const id = (r.body?.data as { id?: unknown } | undefined)?.id;
          if (r.status < 300 && typeof id === "string") return sent(id, `https://x.com/i/status/${id}`, []); // A real post confirms this form. The one with a username needs a billed read.
          if (r.status === 400) return held("X refused the text");
          if (r.status === 401) return tokenRejected("X refused the token");
          if (r.status === 403) return held("X refused this post or this app's access");
          // Waiting minutes doesn't fix a spending cap, so a person looks at it.
          if (r.status === 429) return String(r.body?.type).includes("usage-capped") ? held("X's usage cap is reached") : rateLimited("X's rate limit");
          throw new SocialHttpError(r.status);
        },
      },
    },
    queries: {
      "social.identity": async (_input, ctx): Promise<QueryOutput<"social.identity">> => {
        const { data } = await me(tokenOf(ctx.credential));
        return { accountId: data.id, accountLabel: `@${data.username}`, accountType: "user" };
      },
      // A 403 here is about the app's access, not this token.
      "social.health": async (_input, ctx) => healthOf(() => me(tokenOf(ctx.credential))),
    },
  });
}
