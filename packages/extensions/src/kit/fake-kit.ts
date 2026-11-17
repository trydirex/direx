// SPDX-License-Identifier: AGPL-3.0-only
// A fake Kit API v4 for tests, answering with the shapes recorded against real Kit on 2026-11-04.
// Pass `fetch` to the plugin. `revoke()` makes every call a 401; `limitNext()` makes the next a 429;
// `loseNextAnswer()` applies the next call and then drops the connection, so its answer never
// arrives. `complete(id)` is Kit sending a scheduled broadcast: only its stats say "completed", and
// it still reads as "scheduled" and takes a PUT. That last part is the worst case, not something seen
// in real Kit, so the plugin is tested against it.
export type FakeKitSubscriber = { email: string; state: string; createdAt: string };
export type FakeKitBroadcast = {
  id: number;
  status: "draft" | "scheduled";
  sendAt: string | null;
  /** Kit has sent it. Shown only in the stats. */
  sent?: boolean;
  subject?: string;
  description?: string | null;
  recipients: number;
  opens: number;
  clicks: number;
  unsubscribes: number;
};

export function createFakeKit(o: { key?: string; accountName?: string; subscribers?: FakeKitSubscriber[] } = {}) {
  const key = o.key ?? "kit-test-key";
  const subscribers = [...(o.subscribers ?? [])];
  const broadcasts = new Map<number, FakeKitBroadcast>();
  const calls: string[] = [];
  let revoked = false;
  let limit = 0;
  let lose = false;
  let nextId = 26_803_362;
  const view = (b: FakeKitBroadcast) => ({ id: b.id, subject: b.subject ?? "", description: b.description ?? null, status: b.status, send_at: b.sendAt, public: false });

  const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const cursorOf = (i: number) => Buffer.from(String(i)).toString("base64");
  const indexOf = (c: string | null) => (c ? Number(Buffer.from(c, "base64").toString()) + 1 : 0);

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = answer(input, init);
    if (lose) {
      lose = false;
      throw new TypeError("fetch failed");
    }
    return res;
  }) as typeof globalThis.fetch;

  function answer(input: string | URL | Request, init?: RequestInit): Response {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (limit > 0) {
      limit--;
      return json(429, { errors: ["rate limited"] });
    }
    const headers = new Headers(init?.headers);
    if (revoked || headers.get("x-kit-api-key") !== key) return json(401, { errors: ["The access token is invalid"] });
    const path = url.pathname.replace(/^\/v4/, "");

    if (method === "GET" && path === "/account") return json(200, { account: { name: o.accountName ?? "Test list", plan_type: "free" } });
    if (method === "GET" && path === "/subscribers") {
      const status = url.searchParams.get("status") ?? "active";
      const per = Number(url.searchParams.get("per_page") ?? 500);
      const rows = subscribers.filter((s) => status === "all" || s.state === status);
      const start = indexOf(url.searchParams.get("after"));
      const page = rows.slice(start, start + per);
      const end = start + page.length - 1;
      return json(200, {
        subscribers: page.map((s, i) => ({ id: start + i + 1, state: s.state, first_name: null, email_address: s.email, created_at: s.createdAt, fields: {} })),
        pagination: {
          has_previous_page: start > 0,
          has_next_page: end < rows.length - 1,
          start_cursor: page.length ? cursorOf(start) : null,
          end_cursor: page.length ? cursorOf(end) : null,
          per_page: per,
          ...(url.searchParams.get("include_total_count") === "true" && { total_count: rows.length }),
        },
      });
    }
    const stats = path.match(/^\/broadcasts\/(\d+)\/stats$/);
    if (method === "GET" && stats) {
      const b = broadcasts.get(Number(stats[1]));
      if (!b) return json(404, { errors: ["Not Found"] });
      return json(200, { broadcast: { id: b.id, stats: { recipients: b.recipients, emails_opened: b.opens, total_clicks: b.clicks, unsubscribes: b.unsubscribes, status: b.sent ? "completed" : b.status, progress: b.sent ? 100 : 0 } } });
    }
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === "POST" && path === "/broadcasts") {
      const sendAt = typeof body.send_at === "string" ? body.send_at : null;
      const b: FakeKitBroadcast = { id: nextId++, status: sendAt ? "scheduled" : "draft", sendAt, subject: String(body.subject ?? ""), description: (body.description as string | undefined) ?? null, recipients: 0, opens: 0, clicks: 0, unsubscribes: 0 };
      broadcasts.set(b.id, b);
      return json(201, { broadcast: view(b) });
    }
    if (method === "GET" && path === "/broadcasts") {
      // Newest first, 100 a page at most.
      const all = [...broadcasts.values()].reverse();
      const per = Math.min(100, Number(url.searchParams.get("per_page") ?? 100));
      const start = indexOf(url.searchParams.get("after"));
      const page = all.slice(start, start + per);
      const end = start + page.length - 1;
      return json(200, { broadcasts: page.map(view), pagination: { has_next_page: end < all.length - 1, end_cursor: page.length ? cursorOf(end) : null, per_page: per } });
    }
    const one = path.match(/^\/broadcasts\/(\d+)$/);
    const b = one ? broadcasts.get(Number(one[1])) : undefined;
    if (one && !b) return json(404, { errors: ["Not Found"] });
    if (method === "GET" && b) return json(200, { broadcast: view(b) });
    if (method === "PUT" && b) {
      if ("description" in body) b.description = body.description as string | null;
      if ("send_at" in body) {
        b.sendAt = (body.send_at as string | null) ?? null;
        b.status = b.sendAt ? "scheduled" : "draft";
      }
      return json(200, { broadcast: view(b) });
    }
    return json(404, { errors: ["Not Found"] });
  }

  return {
    fetch,
    key,
    calls,
    broadcasts,
    subscribers,
    revoke: () => void (revoked = true),
    limitNext: (times = 1) => void (limit = times),
    loseNextAnswer: () => void (lose = true),
    complete: (id: number) => {
      const b = broadcasts.get(id);
      if (b?.status === "scheduled") Object.assign(b, { sent: true, recipients: subscribers.filter((s) => s.state === "active").length });
    },
  };
}
