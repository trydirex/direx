// SPDX-License-Identifier: AGPL-3.0-only
// A Bluesky account's own posts, read from the public AppView with no session, so a read never spends one of
// the account's sign-ins. AppView order need not match our indexing-time watermark, so filter each page
// independently and carry that watermark while paging.
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
type FeedItem = { post: PostView; reason?: { $type?: string; uri?: string; indexedAt: string } };

const { input: postsInput } = querySchemas("social.posts");
const cursorOf = z.strictObject({ feed: z.string().optional(), since: z.iso.datetime().optional() });
const QUOTES = ["app.bsky.embed.record", "app.bsky.embed.recordWithMedia"];
const BATCH = 25;
const RECORD_MISSING = Symbol("record missing");
const REPOST = "app.bsky.feed.repost";
const repostUri = /^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.repost\/([^/]+)$/;
const postUri = /^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/;
const repostRecord = z.object({ uri: z.string(), value: z.object({ $type: z.literal(REPOST), createdAt: z.iso.datetime({ offset: true }), subject: z.object({ uri: z.string().regex(postUri) }) }) });

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

function toPost(p: PostView): Post {
  const permalink = postUrl(p.author.did, rkeyOf(p.uri));
  const r = p.record;
  const kind = r.reply ? "reply" : QUOTES.includes(r.embed?.$type ?? "") ? "quote" : "original";
  const facets = (r.facets ?? []).flatMap((f) => f.features ?? []).filter((x) => x.$type === "app.bsky.richtext.facet#link");
  const links = [...facets.map((x) => x.uri), (r.embed?.external ?? r.embed?.media?.external)?.uri].filter(web);
  return { id: p.uri, accountId: p.author.did, kind, createdAt: iso(r.createdAt), text: r.text ?? "", links: [...new Set(links)], permalink };
}

async function get<T>(h: SocialHttp, path: string, missing?: { repo: string; value: T }): Promise<T> {
  const r = await send(h, path, { method: "GET" });
  if (r.status === 429) {
    const told = r.headers.has("ratelimit-reset") || r.headers.has("retry-after");
    throw new PluginError("rate_limited", "Bluesky asked to wait", { status: 429, ...(told && { waitMs: waitFrom(r.headers, Date.now(), 0) }) });
  }
  if (missing) {
    if ((r.status === 400 || r.status === 404) && r.body?.error === "RecordNotFound") return missing.value;
    if (r.status === 400 && r.body?.error === "InvalidRequest" && r.body.message === `Could not find repo: ${missing.repo}`) return missing.value;
  }
  if (r.status >= 300) throw new SocialHttpError(r.status);
  return r.body as T;
}

async function lookupRepost(h: SocialHttp, id: string): Promise<Post | null> {
  const match = repostUri.exec(id);
  if (!match) throw new PluginError("provider_error", "Bluesky gave no valid repost record URI");
  const [, repo, rkey] = match;
  const q = new URLSearchParams({ repo: repo!, collection: REPOST, rkey: rkey! });
  const raw = await get<unknown>(h, `/xrpc/com.atproto.repo.getRecord?${q}`, { repo: repo!, value: RECORD_MISSING });
  if (raw === RECORD_MISSING) return null;
  const record = repostRecord.safeParse(raw);
  if (!record.success || record.data.uri !== id) throw new PluginError("provider_error", "Bluesky gave an invalid repost record");
  const { value } = record.data;
  const [, did, subjectKey] = postUri.exec(value.subject.uri)!;
  return { id, accountId: repo!, kind: "repost", createdAt: iso(value.createdAt), text: "", links: [], permalink: postUrl(did!, subjectKey!) };
}

export async function blueskyPosts(h: SocialHttp, raw: unknown, c: Credential | null): Promise<QueryOutput<"social.posts">> {
  const input = postsInput.safeParse(raw);
  if (!input.success) throw new PluginError("invalid_params", "social.posts takes { cursor?, limit } or { ids }");
  if ("ids" in input.data) {
    // A uri missing from the answer is a deleted post.
    const posts: Post[] = [];
    const ordinary = input.data.ids.filter((id) => !repostUri.test(id));
    for (let i = 0; i < ordinary.length; i += BATCH) {
      const q = new URLSearchParams(ordinary.slice(i, i + BATCH).map((uri) => ["uris", uri]));
      posts.push(...(await get<{ posts: PostView[] }>(h, `/xrpc/app.bsky.feed.getPosts?${q}`)).posts.map((p) => toPost(p)));
    }
    for (const id of input.data.ids) {
      if (!repostUri.test(id)) continue;
      const post = await lookupRepost(h, id);
      if (post) posts.push(post);
    }
    return { posts };
  }
  if (!c || !("username" in c)) throw new PluginError("not_connected", "account not connected");
  const cur = cursorOf.safeParse(json(input.data.cursor ?? "{}"));
  if (!cur.success) throw new PluginError("invalid_params", "not a Bluesky cursor");
  const { feed, since } = cur.data;
  const actor = c.settings?.accountId ?? c.username.trim().replace(/^@/, "");
  if (actor.includes("@")) throw new PluginError("not_connected", "Bluesky needs a public account identifier");
  const q = new URLSearchParams({ actor, filter: "posts_no_replies", limit: String(input.data.limit), ...(feed && { cursor: feed }) });
  const page = await get<{ feed: FeedItem[]; cursor?: string }>(h, `/xrpc/app.bsky.feed.getAuthorFeed?${q}`);
  const sinceMs = since ? Date.parse(since) : -Infinity;
  let watermark = sinceMs;
  const posts: Post[] = [];
  for (const f of page.feed) {
    const time = Date.parse(sortAt(f));
    if (time <= sinceMs) continue;
    let post: Post | null;
    if (f.reason?.$type === "app.bsky.feed.defs#reasonRepost") {
      post = f.reason.uri === undefined ? null : await lookupRepost(h, f.reason.uri);
    } else {
      post = toPost(f.post);
    }
    if (post) posts.push(post);
    watermark = Math.max(watermark, time);
  }
  // Update the checkpoint from the top page; keep the original boundary while scanning later pages.
  const newest = !feed && Number.isFinite(watermark) ? new Date(watermark).toISOString() : undefined;
  return {
    posts,
    ...(page.cursor && { next: JSON.stringify({ feed: page.cursor, ...(since && { since }) }) }),
    ...(newest && { newest: JSON.stringify({ since: newest }) }),
  };
}
