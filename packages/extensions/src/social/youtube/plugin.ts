// SPDX-License-Identifier: AGPL-3.0-only
// Which YouTube channel a Google login is, and whether it still works: one call at 1 quota unit.
// Written from the YouTube Data API docs.
import { definePlugin, type QueryOutput } from "@direx/plugin-sdk";
import { getJson, healthOf, send, SocialHttpError, socialHttp, tokenOf, type SocialPluginOptions } from "../http";
import { youtubeManifest } from "./manifest";

const API = "https://www.googleapis.com";
const MINE = "/youtube/v3/channels?part=snippet&mine=true";
const NO_CHANNEL = "This Google account has no YouTube channel";

type Channels = { items?: { id?: string; snippet?: { title?: string } }[] };
type GoogleError = { error?: { errors?: { reason?: string }[] } };

export function createYouTubePlugin(o: SocialPluginOptions = {}) {
  const h = socialHttp(o, API);
  return definePlugin({
    manifest: youtubeManifest,
    queries: {
      "social.identity": async (_input, ctx): Promise<QueryOutput<"social.identity">> => {
        const r = await send(h, MINE, { method: "GET", headers: { authorization: `Bearer ${tokenOf(ctx.credential)}` } });
        // Google says no channel either way: a 401 with this reason, or an empty list.
        if (r.status === 401 && (r.body as GoogleError | null)?.error?.errors?.some((e) => e.reason === "youtubeSignupRequired")) throw new Error(NO_CHANNEL);
        if (r.status >= 300) throw new SocialHttpError(r.status);
        const channel = (r.body as Channels | null)?.items?.[0];
        if (!channel?.id) throw new Error(NO_CHANNEL);
        return { accountId: channel.id, accountLabel: channel.snippet?.title || "YouTube channel", accountType: "channel" };
      },
      // Any 401 asks for a reconnect. A 403 is often the daily quota, which passes by itself.
      "social.health": async (_input, ctx) => healthOf(() => getJson<Channels>(h, MINE, tokenOf(ctx.credential))),
    },
  });
}
