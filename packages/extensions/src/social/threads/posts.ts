// SPDX-License-Identifier: AGPL-3.0-only
// A Threads account's own posts. A later read passes `since` in Unix seconds and also keeps only posts newer than
// the time its cursor holds, because the docs don't say whether `since` is inclusive. Replies aren't in this list.
import { PluginError, querySchemas, type QueryOutput } from "@direx/plugin-sdk";
import { z } from "zod";
import { send, type Answer, SocialHttpError, type SocialHttp } from "../http";

type Post = QueryOutput<"social.posts">["posts"][number];
type Media = { id: string; text?: string; timestamp: string; permalink?: string; media_type?: string; is_quote_post?: boolean; link_attachment_url?: string };

const FIELDS = "id,text,timestamp,permalink,media_type,is_quote_post,link_attachment_url";
const { input: postsInput } = querySchemas("social.posts");
const cursorOf = z.strictObject({ after: z.string().optional(), since: z.iso.datetime().optional() });

const web = (u: string | undefined): u is string => !!u && URL.canParse(u) && /^https?:$/.test(new URL(u).protocol);
const json = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const errorOf = (r: Answer) => (r.body?.error ?? null) as { code?: unknown; error_subcode?: unknown } | null;
/** Graph's "object does not exist" is code 100 with subcode 33. A bad field is code 100 too, so the subcode decides. */
const gone = (r: Answer) => r.status === 404 || (errorOf(r)?.code === 100 && errorOf(r)?.error_subcode === 33);

async function get(h: SocialHttp, path: string, token: string): Promise<Answer> {
  return send(h, `/v1.0${path}`, { method: "GET", headers: { authorization: `Bearer ${token}` } });
}

/** As publishing reads them: 190 is a dead token and 4 is throttling, at any status. */
function bodyOf<T>(r: Answer): T {
  const code = errorOf(r)?.code;
  if (r.status < 300 && code === undefined) return r.body as T;
  if (code === 190) throw new PluginError("credential_rejected", "Threads refused the token", { status: r.status });
  if (code === 4) throw new PluginError("rate_limited", "Threads asked to wait", { status: r.status });
  throw new SocialHttpError(r.status, typeof code === "number" ? code : undefined);
}

const toPost = (m: Media, accountId: string): Post => ({
  id: m.id,
  accountId,
  kind: m.media_type === "REPOST_FACADE" ? "repost" : m.is_quote_post ? "quote" : "original",
  // Threads writes the zone as +0000.
  createdAt: new Date(m.timestamp).toISOString(),
  text: m.text ?? "",
  links: web(m.link_attachment_url) ? [m.link_attachment_url] : [],
  ...(web(m.permalink) && { permalink: m.permalink }),
});

export async function threadsPosts(h: SocialHttp, raw: unknown, token: string): Promise<QueryOutput<"social.posts">> {
  const input = postsInput.safeParse(raw);
  if (!input.success) throw new PluginError("invalid_params", "social.posts takes { cursor?, limit } or { ids }");
  // The posts don't name their owner in these fields, so the account id comes from the token.
  const { id: accountId } = bodyOf<{ id: string }>(await get(h, "/me?fields=id", token));
  if ("ids" in input.data) {
    const posts: Post[] = [];
    for (const id of input.data.ids) {
      const r = await get(h, `/${encodeURIComponent(id)}?fields=${FIELDS}`, token);
      if (!gone(r)) posts.push(toPost(bodyOf<Media>(r), accountId));
    }
    return { posts };
  }
  const cur = cursorOf.safeParse(json(input.data.cursor ?? "{}"));
  if (!cur.success) throw new PluginError("invalid_params", "not a Threads cursor");
  const { after, since } = cur.data;
  const q = new URLSearchParams({ fields: FIELDS, limit: String(input.data.limit), ...(after && { after }), ...(since && { since: String(Math.floor(Date.parse(since) / 1000)) }) });
  const page = bodyOf<{ data?: Media[]; paging?: { cursors?: { after?: string } } }>(await get(h, `/me/threads?${q}`, token));
  const posts = (page.data ?? []).map((m) => toPost(m, accountId)).filter((p) => !since || Date.parse(p.createdAt) > Date.parse(since));
  const next = posts.length > 0 ? page.paging?.cursors?.after : undefined;
  // Only a read from the top knows the newest post; one paging back leaves it to the first page.
  const newest = after ? undefined : (posts[0]?.createdAt ?? since);
  return { posts, ...(next && { next: JSON.stringify({ after: next, ...(since && { since }) }) }), ...(newest && { newest: JSON.stringify({ since: newest }) }) };
}
