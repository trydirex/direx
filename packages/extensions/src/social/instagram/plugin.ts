// SPDX-License-Identifier: AGPL-3.0-only
// Who an Instagram login is. `user_id` is the professional account's id; `id` is scoped to the app.
import { definePlugin, type QueryOutput } from "@direx/plugin-sdk";
import { getJson, healthOf, socialHttp, tokenOf, type SocialPluginOptions } from "../http";
import { instagramManifest } from "./manifest";

export function createInstagramPlugin(o: SocialPluginOptions = {}) {
  const h = socialHttp(o, "https://graph.instagram.com/v26.0");
  const me = (token: string) => getJson<{ user_id: string; username: string }>(h, "/me?fields=user_id,username,name,account_type", token);
  return definePlugin({
    manifest: instagramManifest,
    queries: {
      "social.identity": async (_input, ctx): Promise<QueryOutput<"social.identity">> => {
        const u = await me(tokenOf(ctx.credential));
        return { accountId: String(u.user_id), accountLabel: `@${u.username}`, accountType: "professional" };
      },
      // Instagram's own error page wasn't read. Meta's code 190 is the likely signal, so S2 confirms it.
      "social.health": async (_input, ctx) => healthOf(() => me(tokenOf(ctx.credential)), [401], [190]),
    },
  });
}
