// SPDX-License-Identifier: AGPL-3.0-only
// A fake Mailchimp Marketing API 3.0 for tests, with the paths and field names of Mailchimp's OpenAPI
// description (read 2026-11-20), not recordings. Pass `fetch` to the plugin. A call to a data center
// other than the key's answers 403, as Mailchimp does.
// `revoke()` makes every call a 401; `limitNext()` makes the next a 429.
export type FakeMailchimpMember = { email: string; status: string; opt?: string; signup?: string; changed: string };
export type FakeMailchimpList = { id: string; name: string; members?: FakeMailchimpMember[] };
export type FakeMailchimpReport = { emails_sent: number; unsubscribed: number; opens: { unique_opens: number }; clicks: { unique_clicks: number } };

export function createFakeMailchimp(o: { key?: string; lists?: FakeMailchimpList[] } = {}) {
  const key = o.key ?? "fake-mailchimp-key-us21";
  const host = `${key.split("-").at(-1)}.api.mailchimp.com`;
  const lists = o.lists ?? [{ id: "a1b2c3d4e5", name: "Founders", members: [] }];
  const reports = new Map<string, FakeMailchimpReport>();
  const calls: string[] = [];
  let revoked = false;
  let limit = 0;

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const problem = (status: number, title: string, detail: string) => json(status, { type: "https://mailchimp.com/developer/marketing/docs/errors/", title, status, detail });
  const notFound = () => problem(404, "Resource Not Found", "The requested resource could not be found.");
  const listView = (l: FakeMailchimpList) => ({ id: l.id, name: l.name, stats: { member_count: (l.members ?? []).filter((m) => m.status === "subscribed").length } });

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (limit > 0) {
      limit--;
      return problem(429, "Too Many Requests", "You have exceeded the limit of 10 simultaneous connections.");
    }
    if (revoked || new Headers(init?.headers).get("authorization") !== `Basic ${btoa(`direx:${key}`)}`) return problem(401, "API Key Invalid", "Your API key may be invalid, or you've attempted to access the wrong datacenter.");
    if (url.host !== host) return problem(403, "Forbidden", "The API key provided is linked to a different datacenter.");
    const path = url.pathname.replace(/^\/3\.0/, "");
    const q = url.searchParams;

    if (method === "GET" && path === "/lists") return json(200, { lists: lists.map(listView), total_items: lists.length });
    const list = path.match(/^\/lists\/([a-z0-9]+)(\/members)?$/);
    if (list) {
      const l = lists.find((x) => x.id === list[1]);
      if (!l) return notFound();
      if (!list[2]) return json(200, listView(l));
      const since = q.get("since_last_changed");
      const rows = (l.members ?? []).filter((m) => !since || Date.parse(m.changed) > Date.parse(since));
      const offset = Number(q.get("offset") ?? 0);
      const page = rows.slice(offset, offset + Math.min(1000, Number(q.get("count") ?? 10)));
      return json(200, { members: page.map((m) => ({ email_address: m.email, status: m.status, timestamp_opt: m.opt ?? "", timestamp_signup: m.signup ?? "", last_changed: m.changed })), total_items: rows.length });
    }
    const report = path.match(/^\/reports\/([a-z0-9]+)$/);
    if (method === "GET" && report) {
      const r = reports.get(report[1]!);
      return r ? json(200, { id: report[1], ...r }) : notFound();
    }
    return notFound();
  }) as typeof globalThis.fetch;

  return { fetch, key, calls, lists, reports, revoke: () => void (revoked = true), limitNext: (times = 1) => void (limit = times) };
}
