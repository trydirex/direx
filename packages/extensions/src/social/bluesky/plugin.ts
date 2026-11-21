// SPDX-License-Identifier: AGPL-3.0-only
// A Bluesky login: a handle and an app password, on bsky.social only. Anything shaped like a main password
// is refused before it leaves, so nobody stores one. Publishing chooses its own record key, so a post whose
// outcome was cut off can be looked up by the Action id alone.
import { createHash } from "node:crypto";
import { definePlugin, MediaMismatch, streamParts, type Credential, type ExecuteResult, type MediaLink, type ReconcileResult, PluginError, type QueryOutput } from "@direx/plugin-sdk";
import { healthOf, send, SocialHttpError, socialHttp, VIDEO_WAIT, type SocialPluginOptions } from "../http";
import { findLinks, graphemes, held, imagesOf, isRefused, later, MB, notAPost, notConnected, postSpec, preparePost, rateLimited, type ImageRules, type Processing, type Refused, runFollowUps, sent, tokenRejected, untilProcessed, videoOf, type VideoRules } from "../post";
import { blueskyManifest } from "./manifest";
import { APP_VIEW, blueskyPosts, postUrl } from "./posts";

const APP_PASSWORD = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;
const COLLECTION = "app.bsky.feed.post";
const MAX_GRAPHEMES = 300;
const MAX_BYTES = 3000;
const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";
const TID_LATEST_US = BigInt(Date.UTC(2026, 9, 1)) * 1000n;
const YEAR_US = 365n * 86_400_000_000n;

/** Bluesky's video service, not the account's server: it takes the upload and processes it. */
const VIDEO_SERVICE = "https://video.bsky.app";
export const BLUESKY_VIDEO: VideoRules = { network: "Bluesky", types: ["video/mp4"], maxBytes: 300 * MB };
/** app.bsky.embed.images: up to 4, each a blob of at most 1,000,000 bytes. A GIF would show as a still, so none. */
export const BLUESKY_IMAGE: ImageRules = { network: "Bluesky", types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 1_000_000, max: 4 };
/** How long the upload's permission lasts, from Bluesky's video guide. */
const SERVICE_AUTH_S = 30 * 60;

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

/**
 * A valid TID from a hash, so a resend and a reconcile land on the same key. Its time bits are a fixed date
 * less a hash-derived offset, so it says nothing about when the post was made. `createdAt` says that.
 */
export function rkeyFor(key: string, followUp?: number): string {
  const hash = createHash("sha256").update(followUp === undefined ? key : `${key}:${followUp}`).digest();
  const micros = TID_LATEST_US - hash.readBigUInt64BE(0) % YEAR_US;
  let value = (micros << 10n) | BigInt(hash.readUInt16BE(8) & 0x3ff);
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = TID_CHARS[Number(value & 31n)]! + out;
    value >>= 5n;
  }
  return out;
}

/** A URL in the text isn't a link on Bluesky without a facet, and facets count UTF-8 bytes. */
export function linkFacets(text: string) {
  return findLinks(text)
    .filter((l) => /^https?:\/\//i.test(l.url))
    .map((l) => ({
      index: { byteStart: bytes(text.slice(0, l.start)), byteEnd: bytes(text.slice(0, l.end)) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: l.url }],
    }));
}

type Session = { did: string; handle: string; accessJwt: string; didDoc?: { service?: { id?: string; serviceEndpoint?: string }[] } };
type VideoBlob = Record<string, unknown>;

/** A request body read part by part, so a large video is never held whole. */
const streamOf = (parts: AsyncGenerator<Uint8Array<ArrayBuffer>>) =>
  new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(c) {
      const next = await parts.next();
      if (next.done) c.close();
      else c.enqueue(next.value);
    },
  });
type Ref = { uri: string; cid: string };

export function createBlueskyPlugin(o: SocialPluginOptions & { videoServiceUrl?: string; appViewUrl?: string } = {}) {
  const h = socialHttp(o, "https://bsky.social");
  const appView = socialHttp({ ...o, baseUrl: o.appViewUrl ?? APP_VIEW }, APP_VIEW);
  const videoService = o.videoServiceUrl ?? VIDEO_SERVICE;

  /**
   * Uploads the approved video to Bluesky's video service and waits for it, returning the blob a post
   * embeds. Nothing is posted yet. The bytes stream through a hash check, so other bytes stop the upload.
   */
  async function uploadVideo(s: Session, link: MediaLink): Promise<VideoBlob | Refused> {
    // The service needs a token addressed to the account's own server, which the session names.
    const pds = s.didDoc?.service?.find((x) => x.id === "#atproto_pds")?.serviceEndpoint ?? h.baseUrl;
    const q = new URLSearchParams({ aud: `did:web:${new URL(pds).host}`, lxm: "com.atproto.repo.uploadBlob", exp: String(Math.floor(Date.now() / 1000) + SERVICE_AUTH_S) });
    const auth = await send(h, `/xrpc/com.atproto.server.getServiceAuth?${q}`, { method: "GET", headers: { authorization: `Bearer ${s.accessJwt}` } });
    const token = auth.body?.token;
    if (auth.status >= 300 || typeof token !== "string") return auth.status === 401 ? tokenRejected("Bluesky refused the session") : later(`Bluesky answered ${auth.status} when asked to upload`);
    let mismatch = false;
    async function* checked() {
      try {
        yield* streamParts(link, 1024 * 1024, h.fetch);
      } catch (e) {
        if (e instanceof MediaMismatch) mismatch = true;
        throw e;
      }
    }
    let job: Record<string, unknown> | null;
    try {
      const res = await h.fetch(`${videoService}/xrpc/app.bsky.video.uploadVideo?${new URLSearchParams({ did: s.did, name: "video.mp4" })}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": link.contentType, "content-length": String(link.bytes) },
        body: streamOf(checked()),
        duplex: "half",
        signal: AbortSignal.timeout(h.timeoutMs * 10),
      } as RequestInit);
      job = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      // The service answers 409 with the job when it already has these bytes, which is a success here.
      if (!res.ok && !(res.status === 409 && typeof job?.jobId === "string")) {
        if (res.status === 429) return rateLimited("Bluesky's video upload limit");
        return res.status >= 400 && res.status < 500 ? held(`Bluesky refused the video${typeof job?.message === "string" ? `: ${job.message}` : ""}`) : later(`Bluesky answered ${res.status} to the upload`);
      }
    } catch {
      return mismatch ? held("the video is not the one approved, so it was not posted") : later("the video upload to Bluesky failed");
    }
    if (mismatch) return held("the video is not the one approved, so it was not posted");
    const jobId = job?.jobId;
    if (typeof jobId !== "string") return later("Bluesky gave no upload job");
    let blob: VideoBlob | undefined;
    const status = async (): Promise<Processing> => {
      const r = await h.fetch(`${videoService}/xrpc/app.bsky.video.getJobStatus?${new URLSearchParams({ jobId })}`, { headers: { authorization: `Bearer ${s.accessJwt}`, accept: "application/json" }, signal: AbortSignal.timeout(h.timeoutMs) });
      const js = ((await r.json().catch(() => null)) as { jobStatus?: { state?: string; blob?: VideoBlob; error?: string } } | null)?.jobStatus;
      if (js?.state === "JOB_STATE_COMPLETED" && js.blob) {
        blob = js.blob;
        return { state: "ready" };
      }
      if (js?.state === "JOB_STATE_FAILED") return { state: "failed", detail: js.error ?? "no reason given" };
      return { state: "processing" };
    };
    const ready = await untilProcessed(status, o.videoWait ?? VIDEO_WAIT, "Bluesky");
    return ready === true ? blob! : ready;
  }
  // ponytail: a new session per call, and Bluesky allows 30 per 5 minutes and 300 a day per account.
  // Fine for a daily check and pilot posting. Posting at any rate should keep the session and use refreshJwt.
  async function session(c: Credential | null) {
    if (!c || !("password" in c)) throw new PluginError("not_connected", "account not connected");
    // A pasted value often brings a space, and a handle is often written with its @.
    const password = c.password.trim();
    if (!APP_PASSWORD.test(password)) throw new Error("That isn't an app password. Create one in Bluesky's settings: it looks like abcd-efgh-ijkl-mnop. Don't use your main password.");
    const res = await h.fetch(`${h.baseUrl}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ identifier: c.username.trim().replace(/^@/, ""), password }),
      signal: AbortSignal.timeout(h.timeoutMs),
    });
    if (!res.ok) throw new SocialHttpError(res.status);
    return (await res.json()) as Session;
  }

  /** Nothing can have posted yet, so every failure here is a definite refusal. */
  async function signIn(c: Credential | null): Promise<Session | Refused> {
    if (!c || !("password" in c)) return notConnected();
    if (!APP_PASSWORD.test(c.password.trim())) return tokenRejected("use an app password from Bluesky's settings, not your main password");
    try {
      return await session(c);
    } catch (e) {
      const status = e instanceof SocialHttpError ? e.status : 0;
      if (status === 401) return tokenRejected("Bluesky refused the app password");
      if (status >= 400 && status < 500 && status !== 429) return held(`Bluesky refused the sign-in (${status})`);
      return later("could not sign in to Bluesky");
    }
  }

  /** Uploads one approved image to the account's server, returning its blob. Nothing is posted yet. */
  async function uploadImage(s: Session, link: MediaLink): Promise<VideoBlob | Refused> {
    try {
      // One part the size of the file: read whole, with its hash checked against the approved one.
      for await (const part of streamParts(link, Math.max(1, link.bytes), h.fetch)) {
        const res = await h.fetch(`${h.baseUrl}/xrpc/com.atproto.repo.uploadBlob`, { method: "POST", headers: { authorization: `Bearer ${s.accessJwt}`, "content-type": link.contentType }, body: part, signal: AbortSignal.timeout(h.timeoutMs) });
        const body = (await res.json().catch(() => null)) as { blob?: VideoBlob } | null;
        if (res.status === 401) return tokenRejected("Bluesky refused the session");
        if (res.status === 429) return rateLimited("Bluesky's rate limit");
        if (res.status === 400) return held("Bluesky refused the image");
        if (!res.ok || !body?.blob) return later(`Bluesky answered ${res.status} to the image upload`);
        return body.blob;
      }
      return later("the image was empty");
    } catch (e) {
      if (e instanceof MediaMismatch) return held("an image is not the one approved, so it was not posted");
      return later("the image upload to Bluesky failed");
    }
  }

  async function create(s: Session, text: string, rkey: string, reply?: { root: Ref; parent: Ref }, video?: VideoBlob, images?: { image: VideoBlob; alt: string }[]): Promise<Ref | Refused> {
    const facets = linkFacets(text);
    const embed = video ? { $type: "app.bsky.embed.video", video } : images?.length ? { $type: "app.bsky.embed.images", images } : undefined;
    const record = { $type: COLLECTION, text, createdAt: new Date().toISOString(), ...(facets.length && { facets }), ...(reply && { reply }), ...(embed && { embed }) };
    const r = await send(h, "/xrpc/com.atproto.repo.createRecord", { headers: { authorization: `Bearer ${s.accessJwt}` }, json: { repo: s.did, collection: COLLECTION, rkey, record } });
    const { uri, cid, error } = r.body ?? {};
    if (r.status < 300 && typeof uri === "string" && typeof cid === "string") return { uri, cid };
    if (r.status === 400 && error === "InvalidRequest") return held("Bluesky refused the text");
    if (r.status === 400 && error === "InvalidSwap") return held("a different record already holds this post's key");
    if (r.status === 429) return rateLimited("Bluesky's rate limit");
    // A session made a moment ago shouldn't be expired, so this one isn't read as a dead login.
    if (r.status === 401 && error !== "ExpiredToken") return tokenRejected("Bluesky refused the session");
    throw new SocialHttpError(r.status);
  }

  return definePlugin({
    manifest: blueskyManifest,
    effects: {
      "social.publish": {
        prepare: async (input) =>
          preparePost(input, {
            maxFollowUps: Number.MAX_SAFE_INTEGER,
            count: (text) => ({ used: graphemes(text).length, limit: MAX_GRAPHEMES }),
            refuse: (text) => (bytes(text) > MAX_BYTES ? `${bytes(text)} of ${MAX_BYTES} bytes` : undefined),
            video: BLUESKY_VIDEO,
            image: BLUESKY_IMAGE,
          }),

        async execute(raw, ctx): Promise<ExecuteResult> {
          const s = await signIn(ctx.credential);
          if (isRefused(s)) return s;
          const spec = postSpec(raw);
          if (!spec) return notAPost();
          const video = videoOf(spec);
          let blob: VideoBlob | undefined;
          if (video) {
            const link = ctx.media?.[video.mediaId];
            if (!link) return held("the approved video was not handed to this post");
            const up = await uploadVideo(s, link);
            if (isRefused(up)) return up;
            blob = up;
          }
          const images: { image: VideoBlob; alt: string }[] = [];
          for (const { ref, alt } of imagesOf(spec)) {
            const link = ctx.media?.[ref.mediaId];
            if (!link) return held("an approved image was not handed to this post");
            const up = await uploadImage(s, link);
            if (isRefused(up)) return up;
            images.push({ image: up, alt });
          }
          const rkey = rkeyFor(ctx.idempotencyKey);
          const root = await create(s, spec.text, rkey, undefined, blob, images);
          if (isRefused(root)) return root;
          let parent = root;
          const followUps = await runFollowUps(spec.followUps, async (text, i) => {
            const key = rkeyFor(ctx.idempotencyKey, i);
            const r = await create(s, text, key, { root, parent });
            if (isRefused(r)) return r;
            parent = r;
            return { url: postUrl(s.did, key) };
          });
          return sent(root.uri, postUrl(s.did, rkey), followUps);
        },

        // Follows the key execute would have used. The record either exists or it doesn't, so this is proof both ways.
        async reconcile(correlationKey, ctx): Promise<ReconcileResult> {
          try {
            const s = await session(ctx.credential);
            const rkey = rkeyFor(correlationKey);
            const q = new URLSearchParams({ repo: s.did, collection: COLLECTION, rkey });
            const r = await send(h, `/xrpc/com.atproto.repo.getRecord?${q}`, { method: "GET" });
            if (r.status < 300 && typeof r.body?.uri === "string") return { kind: "sent", providerRef: r.body.uri, url: postUrl(s.did, rkey) };
            // Docs name the error and not its status.
            return r.body?.error === "RecordNotFound" ? { kind: "not_sent" } : { kind: "unknown" };
          } catch {
            return { kind: "unknown" };
          }
        },
      },
    },
    queries: {
      "social.identity": async (_input, ctx): Promise<QueryOutput<"social.identity">> => {
        // This is what a person sees when connecting, so a refused sign-in says what to check, not a status.
        const s = await session(ctx.credential).catch((e: unknown) => {
          throw e instanceof SocialHttpError && e.status === 401 ? new Error("Bluesky didn't accept that handle and app password. Check both and try again.") : e;
        });
        return { accountId: s.did, accountLabel: `@${s.handle}`, accountType: "user" };
      },
      "social.health": async (_input, ctx) => healthOf(() => session(ctx.credential)),
      "social.posts": async (input, ctx) => blueskyPosts(appView, input, ctx.credential),
    },
  });
}
