// SPDX-License-Identifier: AGPL-3.0-only
// Which TikTok account a login is, and whether it still works: one user info call.
// Written from TikTok's Login Kit and Display API docs.
import { definePlugin, type QueryOutput } from "@direx/plugin-sdk";
import { getJson, healthOf, socialHttp, tokenOf, type SocialPluginOptions } from "../http";
import { tiktokManifest } from "./manifest";

const API = "https://open.tiktokapis.com";
const ME = "/v2/user/info/?fields=open_id,display_name";

type UserInfo = { data?: { user?: { open_id?: string; display_name?: string } } };

export function createTikTokPlugin(o: SocialPluginOptions = {}) {
  const h = socialHttp(o, API);
  const me = (token: string) => getJson<UserInfo>(h, ME, token);
  return definePlugin({
    manifest: tiktokManifest,
    queries: {
      "social.identity": async (_input, ctx): Promise<QueryOutput<"social.identity">> => {
        const user = (await me(tokenOf(ctx.credential))).data?.user;
        if (!user?.open_id) throw new Error("TikTok did not say which account this is");
        return { accountId: user.open_id, accountLabel: user.display_name || "TikTok account", accountType: "creator" };
      },
      "social.health": async (_input, ctx) => healthOf(() => me(tokenOf(ctx.credential))),
    },
  });
}
