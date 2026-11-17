// SPDX-License-Identifier: AGPL-3.0-only
// Who a LinkedIn login is, what it can post to, whether it still works, and publishing as a member.
// Written from LinkedIn's docs.
import { accessToken, definePlugin, MediaMismatch, streamParts, type ExecuteResult, type MediaLink, type QueryOutput } from "@direx/plugin-sdk";
import { getJson, healthOf, send, SocialHttpError, socialHttp, tokenOf, VIDEO_WAIT, type SocialHttp, type SocialPluginOptions } from "../http";
import { held, imagesOf, later, MB, notAPost, notConnected, postSpec, preparePost, rateLimited, sent, tokenRejected, untilProcessed, videoOf, type ImageRules, type Processing, type Refused, type VideoRules } from "../post";
import { linkedinManifest, linkedinPageManifest } from "./manifest";

// ponytail: LinkedIn retires a version about a year after release, so this needs bumping. A retired
// version fails every Page call, which shows as a failed health check rather than a false reconnect.
export const LINKEDIN_VERSION = "202610";
/** LinkedIn promises a version at least a year, and 202511 sunsets on 2026-11-16. A test fails 60 days before this. */
export const LINKEDIN_VERSION_SUNSET = "2027-10-01";
/** LinkedIn's help page gives this. Its API docs name no number. */
const LIMIT = 3000;
/** One page of a person's Pages. Someone who runs more than this sees the first 100. */
const PAGE_LIMIT = 100;
const API = "https://api.linkedin.com";
const marketing = { "X-Restli-Protocol-Version": "2.0.0", "Linkedin-Version": LINKEDIN_VERSION };

/** LinkedIn's Videos API page. Its help pages say 5 GB; the smaller figure is the one the API documents. */
export const LINKEDIN_VIDEO: VideoRules = { network: "LinkedIn", types: ["video/mp4"], maxBytes: 500 * MB };
/** LinkedIn's Images API page: JPG, GIF and PNG, and a pixel limit rather than a byte one, so Direx's own cap
    stands. A post takes 2 to 20 as multiImage; Direx offers up to 4. */
export const LINKEDIN_IMAGE: ImageRules = { network: "LinkedIn", types: ["image/jpeg", "image/png", "image/gif"], maxBytes: 10 * MB, max: 4 };

/** Uploads one approved image, returning its URN. Nothing is posted yet, so a failure here is safe to retry, except bytes that aren't the ones approved. */
async function uploadImage(h: SocialHttp, token: string, owner: string, link: MediaLink): Promise<string | Refused> {
  const init = await send(h, "/rest/images?action=initializeUpload", { headers: { authorization: `Bearer ${token}`, ...marketing }, json: { initializeUploadRequest: { owner } } });
  if (init.status === 401 || init.status === 403) return tokenRejected("LinkedIn refused the token or its permission");
  if (init.status === 429) return rateLimited("LinkedIn's rate limit");
  const value = init.body?.value as { image?: string; uploadUrl?: string } | undefined;
  if (init.status >= 300 || !value?.image || !value.uploadUrl) return init.status === 400 || init.status === 422 ? held("LinkedIn refused the image") : later(`LinkedIn answered ${init.status} to the upload`);
  try {
    // One part the size of the file: read whole, with its hash checked against the approved one.
    for await (const part of streamParts(link, Math.max(1, link.bytes), h.fetch)) {
      const r = await h.fetch(value.uploadUrl, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, body: part, signal: AbortSignal.timeout(h.timeoutMs) });
      if (!r.ok) return later(`LinkedIn answered ${r.status} to the image upload`);
    }
  } catch (e) {
    if (e instanceof MediaMismatch) return held("an image is not the one approved, so it was not posted");
    return later("the image upload to LinkedIn failed");
  }
  return value.image;
}

/** LinkedIn hands out one upload URL per 4 MiB part. */
const PART = 4 * 1024 * 1024;

/**
 * Uploads the approved video and waits for LinkedIn to finish with it, returning its URN. Nothing is
 * posted yet, so any failure here is safe to retry, except bytes that aren't the ones approved.
 */
async function uploadVideo(h: SocialHttp, token: string, owner: string, link: MediaLink, wait: SocialPluginOptions["videoWait"]): Promise<string | Refused> {
  const auth = { authorization: `Bearer ${token}`, ...marketing };
  const init = await send(h, "/rest/videos?action=initializeUpload", { headers: auth, json: { initializeUploadRequest: { owner, fileSizeBytes: link.bytes, uploadCaptions: false, uploadThumbnail: false } } });
  if (init.status === 401 || init.status === 403) return tokenRejected("LinkedIn refused the token or its permission");
  if (init.status === 429) return rateLimited("LinkedIn's rate limit");
  const value = init.body?.value as { video?: string; uploadToken?: string; uploadInstructions?: { uploadUrl: string; firstByte: number; lastByte: number }[] } | undefined;
  if (init.status >= 300 || !value?.video || !value.uploadInstructions?.length) return init.status === 400 || init.status === 422 ? held("LinkedIn refused the video") : later(`LinkedIn answered ${init.status} to the upload`);
  const parts = value.uploadInstructions;
  const etags: string[] = [];
  try {
    for await (const part of streamParts(link, PART, h.fetch)) {
      const at = parts[etags.length];
      if (!at || at.lastByte - at.firstByte + 1 !== part.length) return later("LinkedIn's upload parts did not match the file");
      const r = await h.fetch(at.uploadUrl, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: part, signal: AbortSignal.timeout(h.timeoutMs) });
      const etag = r.headers.get("etag");
      if (!r.ok || !etag) return later(`LinkedIn answered ${r.status} to an upload part`);
      etags.push(etag);
    }
  } catch (e) {
    if (e instanceof MediaMismatch) return held("the video is not the one approved, so it was not posted");
    return later("the video upload to LinkedIn failed");
  }
  const done = await send(h, "/rest/videos?action=finalizeUpload", { headers: auth, json: { finalizeUploadRequest: { video: value.video, uploadToken: value.uploadToken ?? "", uploadedPartIds: etags } } });
  if (done.status >= 300) return later(`LinkedIn answered ${done.status} when finishing the upload`);
  const status = async (): Promise<Processing> => {
    const v = await send(h, `/rest/videos/${encodeURIComponent(value.video!)}`, { method: "GET", headers: auth });
    const s = v.body?.status;
    if (s === "AVAILABLE") return { state: "ready" };
    if (s === "PROCESSING_FAILED") return { state: "failed", detail: String(v.body?.processingFailureReason ?? "no reason given") };
    return { state: "processing" };
  };
  const ready = await untilProcessed(status, wait ?? VIDEO_WAIT, "LinkedIn");
  return ready === true ? value.video : ready;
}

/** LinkedIn requires a backslash on every reserved character, used or not. */
export const littleText = (text: string) => text.replace(/[|{}@[\]()<>#\\*_~]/g, "\\$&");

export function createLinkedInPlugin(o: SocialPluginOptions = {}) {
  const h = socialHttp(o, API);
  const me = (token: string) => getJson<{ sub: string; name?: string }>(h, "/v2/userinfo", token);
  return definePlugin({
    manifest: linkedinManifest,
    effects: {
      "social.publish": {
        // ponytail: code points are a guess, since LinkedIn doesn't say how it counts or whether escapes count. Real at-limit posts settle it.
        prepare: async (input) => preparePost(input, { needsTarget: true, maxFollowUps: 0, count: (text) => ({ used: [...text].length, limit: LIMIT }), video: LINKEDIN_VIDEO, image: LINKEDIN_IMAGE }),

        async execute(raw, ctx): Promise<ExecuteResult> {
          const token = accessToken(ctx.credential);
          if (!token) return notConnected();
          const spec = postSpec(raw);
          if (!spec?.target) return notAPost();
          const author = `urn:li:person:${spec.target}`;
          const video = videoOf(spec);
          let videoUrn: string | undefined;
          if (video) {
            const link = ctx.media?.[video.mediaId];
            if (!link) return held("the approved video was not handed to this post");
            const up = await uploadVideo(h, token, author, link, o.videoWait);
            if (typeof up !== "string") return up;
            videoUrn = up;
          }
          const images: { id: string; altText?: string }[] = [];
          for (const { ref, alt } of imagesOf(spec)) {
            const link = ctx.media?.[ref.mediaId];
            if (!link) return held("an approved image was not handed to this post");
            const up = await uploadImage(h, token, author, link);
            if (typeof up !== "string") return up;
            images.push({ id: up, ...(alt && { altText: alt }) });
          }
          const content = videoUrn ? { media: { id: videoUrn } } : images.length === 1 ? { media: images[0] } : images.length ? { multiImage: { images } } : undefined;
          const r = await send(h, "/rest/posts", {
            headers: { authorization: `Bearer ${token}`, ...marketing },
            json: {
              author,
              commentary: littleText(spec.text),
              ...(content && { content }),
              visibility: "PUBLIC",
              distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
              lifecycleState: "PUBLISHED",
              isReshareDisabledByAuthor: false,
            },
          });
          const urn = r.headers.get("x-restli-id");
          if (r.status < 300 && urn) return sent(urn, `https://www.linkedin.com/feed/update/${urn}/`, []);
          if (r.status === 400 || r.status === 422) return held("LinkedIn refused the text");
          if (r.status === 401 || r.status === 403) return tokenRejected("LinkedIn refused the token or its permission");
          if (r.status === 426) return held("Direx's LinkedIn version is out of date, and an operator must update it");
          if (r.status === 429) return rateLimited("LinkedIn's rate limit");
          if (r.status === 409) return later("LinkedIn reported a write conflict");
          throw new SocialHttpError(r.status);
        },
      },
    },
    queries: {
      "social.identity": async (_input, ctx): Promise<QueryOutput<"social.identity">> => {
        const u = await me(tokenOf(ctx.credential));
        return { accountId: u.sub, accountLabel: u.name ?? "LinkedIn member", accountType: "member" };
      },
      "social.health": async (_input, ctx) => healthOf(() => me(tokenOf(ctx.credential))),
    },
  });
}

type Acls = { elements?: { organization?: string; roleAssignee?: string }[] };

export function createLinkedInPagePlugin(o: SocialPluginOptions = {}) {
  const h = socialHttp(o, API);
  const acls = (token: string) => getJson<Acls>(h, `/rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&count=${PAGE_LIMIT}`, token, marketing);
  return definePlugin({
    manifest: linkedinPageManifest,
    queries: {
      "social.identity": async (_input, ctx): Promise<QueryOutput<"social.identity">> => {
        const token = tokenOf(ctx.credential);
        const found = (await acls(token)).elements ?? [];
        const accountId = found[0]?.roleAssignee;
        // This app can't have sign-in scopes, so the person's id comes from their Page roles.
        if (!accountId) throw new Error("this LinkedIn account administers no Pages");
        // One lookup each: LinkedIn's development tier allows no batch calls.
        const targets = await Promise.all(
          found.flatMap((a) => {
            const urn = a.organization;
            const id = urn?.split(":").pop();
            if (!urn || !id) return [];
            return [getJson<{ localizedName?: string }>(h, `/rest/organizations/${encodeURIComponent(id)}`, token, marketing).then((org) => ({ id: urn, name: org.localizedName ?? urn, type: "page" }))];
          }),
        );
        return { accountId, accountLabel: targets.length === 1 ? targets[0]!.name : "LinkedIn Pages", targets };
      },
      // A 403 means this person lost their role, which a reconnect can't fix by itself but they must see.
      "social.health": async (_input, ctx) => healthOf(() => acls(tokenOf(ctx.credential)), [401, 403]),
    },
  });
}
