// SPDX-License-Identifier: AGPL-3.0-only
// Who a Threads login is, when its data access ends, and publishing in two steps with a wait between. The
// first step can't publish anything, so only the second can leave an outcome unknown. Threads' error shapes
// aren't documented, so the Graph shape is a guess until real responses replace these readings.
import { accessToken, definePlugin, type ExecuteResult, type MediaLink, type QueryOutput } from "@direx/plugin-sdk";
import { getJson, healthOf, send, type Answer, SocialHttpError, socialHttp, tokenOf, VIDEO_WAIT, type SocialPluginOptions } from "../http";
import { findLinks, graphemes, held, isEmoji, isRefused, later, MB, notAPost, notConnected, postSpec, preparePost, rateLimited, type Processing, type Refused, runFollowUps, sent, tokenRejected, untilProcessed, videoOf, type VideoRules } from "../post";
import { threadsManifest } from "./manifest";

const GRANT_MS = 90 * 24 * 60 * 60_000;
/** Threads recommends waiting about this long before publishing a container. */
const WAIT_MS = 30_000;
const LIMIT = 500;
const MAX_LINKS = 5;
const MAX_FOLLOW_UPS = 3;
/** Past this into the effect's five minutes, another follow-up (two calls and a wait) might not finish. */
const LAST_FOLLOW_UP_START_MS = 225_000;
/**
 * Threads fetches the video from a link itself, so it needs Direx at a public address. Direx checks the
 * file's hash when it makes the link, but can't check the bytes Threads reads.
 */
export const THREADS_VIDEO: VideoRules = { network: "Threads", types: ["video/mp4", "video/quicktime"], maxBytes: 1000 * MB };

const encoder = new TextEncoder();
// ponytail: how Threads counts anything but emoji isn't documented, so one grapheme is one here. Real at-limit posts settle it.
const count = (text: string) => graphemes(text).reduce((n, g) => n + (isEmoji(g) ? encoder.encode(g).length : 1), 0);
const uniqueLinks = (text: string) => new Set(findLinks(text).map((l) => l.url)).size;

const errorOf = (r: Answer) => (r.body?.error ?? null) as { code?: unknown } | null;
const refusedToken = (r: Answer) => r.status === 401 || errorOf(r)?.code === 190;
const throttled = (r: Answer) => r.status === 429 || errorOf(r)?.code === 4;

export type ThreadsPluginOptions = SocialPluginOptions & { now?: () => number; wait?: (ms: number) => Promise<void> };

export function createThreadsPlugin(o: ThreadsPluginOptions = {}) {
  const h = socialHttp(o, "https://graph.threads.com");
  const now = o.now ?? Date.now;
  const wait = o.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const me = (token: string) => getJson<{ id: string; username: string }>(h, "/me?fields=id,username,name", token);

  /** Step one. No post can exist yet, so nothing here is ever an unknown outcome. */
  async function makeContainer(target: string, token: string, text: string, replyTo?: string, video?: MediaLink): Promise<{ id: string } | Refused> {
    let r: Answer;
    try {
      const media: Record<string, string> = video ? { media_type: "VIDEO", video_url: video.url } : { media_type: "TEXT" };
      r = await send(h, `/v1.0/${encodeURIComponent(target)}/threads`, { form: { ...media, text, access_token: token, ...(replyTo && { reply_to_id: replyTo }) } });
    } catch {
      return later("Threads didn't answer, and nothing was posted");
    }
    if (r.status < 300 && !errorOf(r) && typeof r.body?.id === "string") return { id: r.body.id };
    if (refusedToken(r)) return tokenRejected("Threads refused the token");
    if (throttled(r)) return rateLimited("Threads asked to wait, and nothing was posted");
    if (r.status >= 500) return later("Threads asked to wait, and nothing was posted");
    return held(JSON.stringify(r.body).includes("THREADS_API__LINK_LIMIT_EXCEEDED") ? `more than ${MAX_LINKS} links` : "Threads refused the text");
  }

  /** A container in a known bad state needn't reach step two. A failed read isn't one, so it goes on. */
  async function containerProblem(id: string, token: string): Promise<Refused | null> {
    const c = await getJson<{ status?: unknown }>(h, `/${encodeURIComponent(id)}?fields=status,error_message`, token).catch(() => null);
    if (c?.status === "ERROR") return held("Threads couldn't prepare the post");
    return c?.status === "EXPIRED" ? later("the prepared post expired before publishing") : null;
  }

  /** A video container is ready when Threads has fetched and processed the file. */
  async function videoReady(id: string, token: string): Promise<Processing> {
    const c = await getJson<{ status?: unknown; error_message?: unknown }>(h, `/${encodeURIComponent(id)}?fields=status,error_message`, token).catch(() => null);
    if (c?.status === "FINISHED") return { state: "ready" };
    if (c?.status === "ERROR") return { state: "failed", detail: typeof c.error_message === "string" ? c.error_message : "no reason given" };
    // An expired container is made again on the retry, with a fresh link.
    if (c?.status === "EXPIRED") return { state: "failed", detail: "the prepared post expired" };
    return { state: "processing" };
  }

  async function publish(target: string, token: string, text: string, replyTo?: string, video?: MediaLink): Promise<{ id: string; url?: string | undefined } | Refused> {
    const container = await makeContainer(target, token, text, replyTo, video);
    if (isRefused(container)) return container;
    if (video) {
      const ready = await untilProcessed(() => videoReady(container.id, token), o.videoWait ?? VIDEO_WAIT, "Threads");
      if (ready !== true) return ready;
    } else {
      await wait(WAIT_MS);
      const problem = await containerProblem(container.id, token);
      if (problem) return problem;
    }
    const r = await send(h, `/v1.0/${encodeURIComponent(target)}/threads_publish`, { form: { creation_id: container.id, access_token: token } });
    if (r.status < 300 && !errorOf(r) && typeof r.body?.id === "string") {
      const id = r.body.id;
      const url = await getJson<{ permalink?: unknown }>(h, `/${encodeURIComponent(id)}?fields=permalink`, token).then((p) => (typeof p.permalink === "string" ? p.permalink : undefined), () => undefined);
      return { id, url };
    }
    if (refusedToken(r)) return tokenRejected("Threads refused the token");
    if (throttled(r)) return rateLimited("Threads' publishing limit");
    throw new SocialHttpError(r.status);
  }

  return definePlugin({
    manifest: threadsManifest,
    effects: {
      "social.publish": {
        prepare: async (input) =>
          preparePost(input, {
            needsTarget: true,
            maxFollowUps: MAX_FOLLOW_UPS,
            count: (text) => ({ used: count(text), limit: LIMIT }),
            refuse: (text) => (uniqueLinks(text) > MAX_LINKS ? `${uniqueLinks(text)} of ${MAX_LINKS} links` : undefined),
            video: THREADS_VIDEO,
          }),

        async execute(raw, ctx): Promise<ExecuteResult> {
          const started = now();
          const token = accessToken(ctx.credential);
          if (!token) return notConnected();
          const spec = postSpec(raw);
          if (!spec?.target) return notAPost();
          const { target } = spec;
          const video = videoOf(spec);
          const link = video && ctx.media?.[video.mediaId];
          if (video && !link) return held("the approved video was not handed to this post");
          const post = await publish(target, token, spec.text, undefined, link ?? undefined);
          if (isRefused(post)) return post;
          let parent = post.id;
          const followUps = await runFollowUps(spec.followUps, async (text) => {
            if (now() - started > LAST_FOLLOW_UP_START_MS) return held("not attempted, because the time for this post ran out");
            const r = await publish(target, token, text, parent);
            if (isRefused(r)) return r;
            parent = r.id;
            return { url: r.url };
          });
          return sent(post.id, post.url, followUps);
        },
      },
    },
    queries: {
      "social.identity": async (_input, ctx): Promise<QueryOutput<"social.identity">> => {
        const u = await me(tokenOf(ctx.credential));
        // ponytail: 90 days from this call, the shortest a grant lasts. Reading the true date needs the app's
        // secret. A public profile's grant can extend, so it may warn early; a reconnect clears it either way.
        const grantExpiresAt = new Date(now() + GRANT_MS).toISOString();
        return { accountId: u.id, accountLabel: `@${u.username}`, accountType: "profile", grantExpiresAt };
      },
      "social.health": async (_input, ctx) => healthOf(() => me(tokenOf(ctx.credential)), [401], [190]),
    },
  });
}
