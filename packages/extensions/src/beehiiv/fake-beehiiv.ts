// SPDX-License-Identifier: AGPL-3.0-only
// A fake beehiiv API v2 for tests, answering with the shapes recorded against a real trial on
// 2026-11-04. Pass `fetch` to the plugin. `revoke()` makes every call a 401; `limitNext()` makes the
// next a 429 with beehiiv's ratelimit-reset header.
export type FakeBeehiivSubscription = { email: string; status: string; created: number };
export type FakeBeehiivPost = { id: string; status: "draft" | "confirmed"; recipients: number; delivered: number; opens: number; clicks: number; unsubscribes: number };

export const FAKE_PUB = "pub_00000000-0000-4000-8000-000000000001";

/** `sendApi: false` is a plan whose API refuses to create or confirm posts (403). */
export function createFakeBeehiiv(o: { key?: string; name?: string; subscriptions?: FakeBeehiivSubscription[]; publications?: string[]; sendApi?: boolean } = {}) {
  const key = o.key ?? "bh-test-key";
  const pubs = o.publications ?? [FAKE_PUB];
  const subscriptions = [...(o.subscriptions ?? [])];
  const posts = new Map<string, FakeBeehiivPost>();
  const calls: string[] = [];
  let revoked = false;
  let limitResetAt: number | null = null;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (limitResetAt !== null) {
      const reset = limitResetAt;
      limitResetAt = null;
      return json(429, { errors: [{ message: "Too many requests" }] }, { "ratelimit-limit": "500", "ratelimit-remaining": "0", "ratelimit-reset": String(reset) });
    }
    if (revoked || new Headers(init?.headers).get("authorization") !== `Bearer ${key}`) return json(401, { errors: [{ message: "Unauthorized" }] });
    const path = url.pathname.replace(/^\/v2/, "");

    if (method === "GET" && path === "/publications") return json(200, { data: pubs.map((id) => ({ id, name: o.name ?? "Test letter" })), limit: 2, page: 1, total_results: pubs.length, total_pages: 1 });
    const pub = path.match(/^\/publications\/(pub_[0-9a-f-]+)(\/.*)?$/);
    if (!pub || !pubs.includes(pub[1]!)) return json(404, { errors: [{ message: "Not found" }] });
    const rest = pub[2] ?? "";

    if (method === "GET" && rest === "") {
      return json(200, { data: { id: pub[1], name: o.name ?? "Test letter", stats: { active_subscriptions: subscriptions.filter((s) => s.status === "active").length } } });
    }
    if (method === "GET" && rest === "/subscriptions") {
      const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 10));
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const page = subscriptions.slice(start, start + limit);
      const more = start + limit < subscriptions.length;
      return json(200, { data: page.map((s, i) => ({ id: `sub_${start + i}`, email: s.email, status: s.status, created: s.created, utm_source: "direct" })), limit, has_more: more, next_cursor: more ? String(start + limit) : null });
    }
    const writesPosts = (method === "POST" && rest === "/posts") || (method === "PATCH" && /^\/posts\//.test(rest));
    if (writesPosts && o.sendApi === false) return json(403, { errors: [{ message: "This endpoint is available to publications on the Pro and Enterprise plans." }] });
    if (method === "POST" && rest === "/posts") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string };
      const id = `post_00000000-0000-4000-8000-${String(posts.size + 1).padStart(12, "0")}`;
      posts.set(id, { id, status: body.status === "confirmed" ? "confirmed" : "draft", recipients: 0, delivered: 0, opens: 0, clicks: 0, unsubscribes: 0 });
      return json(201, { data: { id, preview_url: `https://app.beehiiv.com/posts/${id}/preview` } });
    }
    const post = rest.match(/^\/posts\/(post_[0-9a-f-]+)$/);
    if (method === "PATCH" && post) {
      const p = posts.get(post[1]!);
      if (!p) return json(404, { errors: [{ message: "Not found" }] });
      const body = JSON.parse(String(init?.body ?? "{}")) as { status?: string };
      if (p.status !== "draft" || body.status !== "confirmed") return json(400, { errors: [{ message: "Only the draft to confirmed transition is supported" }] });
      p.status = "confirmed";
      return json(200, { data: { id: p.id, status: p.status } });
    }
    if (method === "GET" && post) {
      const p = posts.get(post[1]!);
      if (!p) return json(404, { errors: [{ message: "Not found" }] });
      return json(200, { data: { id: p.id, status: p.status, stats: { email: { recipients: p.recipients, delivered: p.delivered, opens: p.opens, unique_opens: p.opens, clicks: p.clicks, unique_clicks: p.clicks, unsubscribes: p.unsubscribes, spam_reports: 0 } } } });
    }
    return json(404, { errors: [{ message: "Not found" }] });
  }) as typeof globalThis.fetch;

  return { fetch, key, calls, posts, subscriptions, revoke: () => void (revoked = true), limitNext: (resetAtUnixSeconds: number) => void (limitResetAt = resetAtUnixSeconds) };
}
