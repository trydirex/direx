// SPDX-License-Identifier: AGPL-3.0-only
// A Bluesky account's own posts, read from the public AppView with no session, so a read never spends one of
// the account's sign-ins. getAuthorFeed has no "since", so a later read reads one page from the top and stops
// at the first post not newer than the time its cursor holds; `next` carries that time on to the next page.
import { PluginError, querySchemas, type Credential, type QueryOutput } from "@direx/plugin-sdk";
import { z } from "zod";
import { waitFrom } from "../../newsletter/http";
import { send, SocialHttpError, type SocialHttp } from "../http";

export const APP_VIEW = "https://public.api.bsky.app";
export const postUrl = (did: string, rkey: string) => `https://bsky.app/profile/${did}/post/${rkey}`;

type Post = QueryOutput<"social.posts">["posts"][number];
type External = { external?: { uri?: string } };
type Record_ = { text?: string; createdAt: string; reply?: unknown; facets?: { features?: { $type?: string; uri?: string }[] }[]; embed?: External & { $type?: string; media?: External } };
type PostView = { uri: string; author: { did: string }; indexedAt: string; record: Record_ };
type FeedItem = { post: PostView; reason?: { $type?: string; uri?: string; by: { did: string }; indexedAt: string } };

const { input: postsInput } = querySchemas("social.posts");
const cursorOf = z.strictObject({ feed: z.string().optional(), since: z.iso.datetime().optional() });
const QUOTES = ["app.bsky.embed.record", "app.bsky.embed.recordWithMedia"];
const BATCH = 25;

const iso = (t: string) => new Date(t).toISOString();
const web = (u: string | undefined): u is string => !!u && URL.canParse(u) && /^https?:$/.test(new URL(u).protocol);
const json = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const rkeyOf = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);
const sortAt = (f: FeedItem) => f.reason?.indexedAt ?? f.post.indexedAt;

function toPost(p: PostView, reason?: FeedItem["reason"]): Post {
  const permalink = postUrl(p.author.did, rkeyOf(p.uri));
  // A repost has none of the account's own words, and the post it shares is someone else's.
  if (reason?.$type === "app.bsky.feed.defs#reasonRepost") return { id: reason.uri ?? p.uri, accountId: reason.by.did, kind: "repost", createdAt: iso(reason.indexedAt), text: "", links: [], permalink };
  const r = p.record;
  const kind = r.reply ? "reply" : QUOTES.includes(r.embed?.$type ?? "") ? "quote" : "original";
  const facets = (r.facets ?? []).flatMap((f) => f.features ?? []).filter((x) => x.$type === "app.bsky.richtext.facet#link");
  const links = [...facets.map((x) => x.uri), (r.embed?.external ?? r.embed?.media?.external)?.uri].filter(web);
  return { id: p.uri, accountId: p.author.did, kind, createdAt: iso(r.createdAt), text: r.text ?? "", links: [...new Set(links)], permalink };
}

async function get<T>(h: SocialHttp, path: string): Promise<T> {
  const r = await send(h, path, { method: "GET" });
  if (r.status === 429) {
    const told = r.headers.has("ratelimit-reset") || r.headers.has("retry-after");
    throw new PluginError("rate_limited", "Bluesky asked to wait", { status: 429, ...(told && { waitMs: waitFrom(r.headers, Date.now(), 0) }) });
  }
  if (r.status >= 300) throw new SocialHttpError(r.status);
  return r.body as T;
}

export async function blueskyPosts(h: SocialHttp, raw: unknown, c: Credential | null): Promise<QueryOutput<"social.posts">> {
  const input = postsInput.safeParse(raw);
  if (!input.success) throw new PluginError("invalid_params", "social.posts takes { cursor?, limit } or { ids }");
  if ("ids" in input.data) {
    // A uri missing from the answer is a deleted post.
    const posts: Post[] = [];
    for (let i = 0; i < input.data.ids.length; i += BATCH) {
      const q = new URLSearchParams(input.data.ids.slice(i, i + BATCH).map((uri) => ["uris", uri]));
      posts.push(...(await get<{ posts: PostView[] }>(h, `/xrpc/app.bsky.feed.getPosts?${q}`)).posts.map((p) => toPost(p)));
    }
    return { posts };
  }
  if (!c || !("username" in c)) throw new PluginError("not_connected", "account not connected");
  const cur = cursorOf.safeParse(json(input.data.cursor ?? "{}"));
  if (!cur.success) throw new PluginError("invalid_params", "not a Bluesky cursor");
  const { feed, since } = cur.data;
  const q = new URLSearchParams({ actor: c.username.trim().replace(/^@/, ""), filter: "posts_no_replies", limit: String(input.data.limit), ...(feed && { cursor: feed }) });
  const page = await get<{ feed: FeedItem[]; cursor?: string }>(h, `/xrpc/app.bsky.feed.getAuthorFeed?${q}`);
  const stop = since ? page.feed.findIndex((f) => Date.parse(sortAt(f)) <= Date.parse(since)) : -1;
  const items = stop < 0 ? page.feed : page.feed.slice(0, stop);
  // Only a read from the top knows the newest post; one paging back leaves it to the first page.
  const newest = feed ? undefined : items[0] ? iso(sortAt(items[0])) : since;
  return {
    posts: items.map((f) => toPost(f.post, f.reason)),
    ...(stop < 0 && page.cursor && { next: JSON.stringify({ feed: page.cursor, ...(since && { since }) }) }),
    ...(newest && { newest: JSON.stringify({ since: newest }) }),
  };
}
