// SPDX-License-Identifier: AGPL-3.0-only
// A fake Mailchimp Marketing API 3.0 for tests, with the paths and field names of Mailchimp's OpenAPI
// description (read 2026-11-20), not recordings. Pass `fetch` to the plugin. A call to a data center
// other than the key's answers 403, as Mailchimp does. The send checklist's wording is made up.
// `revoke()` makes every call a 401; `limitNext()` makes the next a 429.
export type FakeMailchimpMember = { email: string; status: string; opt?: string; signup?: string; changed: string };
export type FakeMailchimpList = { id: string; name: string; members?: FakeMailchimpMember[]; fromName?: string; fromEmail?: string };
export type FakeMailchimpCampaign = { id: string; status: string; listId: string; title: string; subject: string; fromName?: string; replyTo?: string; html?: string; sends: number };
export type FakeMailchimpReport = { emails_sent: number; unsubscribed: number; opens: { unique_opens: number }; clicks: { unique_clicks: number } };

export function createFakeMailchimp(o: { key?: string; lists?: FakeMailchimpList[] } = {}) {
  const key = o.key ?? "fake-mailchimp-key-us21";
  const host = `${key.split("-").at(-1)}.api.mailchimp.com`;
  const lists = o.lists ?? [{ id: "a1b2c3d4e5", name: "Founders", members: [], fromName: "Ada", fromEmail: "ada@example.com" }];
  const campaigns = new Map<string, FakeMailchimpCampaign>();
  const reports = new Map<string, FakeMailchimpReport>();
  const calls: string[] = [];
  let revoked = false;
  let limit = 0;

  const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const problem = (status: number, title: string, detail: string) => json(status, { type: "https://mailchimp.com/developer/marketing/docs/errors/", title, status, detail });
  const notFound = () => problem(404, "Resource Not Found", "The requested resource could not be found.");
  const view = (c: FakeMailchimpCampaign) => ({ id: c.id, web_id: 1, type: "regular", status: c.status, recipients: { list_id: c.listId }, settings: { subject_line: c.subject, title: c.title, from_name: c.fromName, reply_to: c.replyTo } });
  const listView = (l: FakeMailchimpList) => ({ id: l.id, name: l.name, stats: { member_count: (l.members ?? []).filter((m) => m.status === "subscribed").length }, campaign_defaults: { from_name: l.fromName, from_email: l.fromEmail, subject: "", language: "en" } });
  const checklist = (c: FakeMailchimpCampaign) => {
    const missing = [!c.html && "Content", !c.html?.includes("*|UNSUB|*") && "Unsubscribe link", !c.replyTo && "Reply-to address"].filter((x): x is string => !!x);
    return { is_ready: missing.length === 0, items: missing.length ? missing.map((h, i) => ({ type: "error", id: i, heading: h, details: `${h} is missing.` })) : [{ type: "success", id: 0, heading: "Ready", details: "Your campaign is ready to send." }] };
  };

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
    const body = init?.body ? (JSON.parse(String(init.body)) as { html?: string; recipients?: { list_id?: string }; settings?: Record<string, string> }) : {};

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

    if (method === "POST" && path === "/campaigns") {
      const l = lists.find((x) => x.id === body.recipients?.list_id);
      if (!l) return problem(400, "Invalid Resource", "The resource submitted could not be validated.");
      const s = body.settings ?? {};
      const c: FakeMailchimpCampaign = { id: `c${String(campaigns.size + 1).padStart(9, "0")}`, status: "save", listId: l.id, title: s.title ?? "", subject: s.subject_line ?? "", sends: 0, ...(s.from_name && { fromName: s.from_name }), ...(s.reply_to && { replyTo: s.reply_to }) };
      campaigns.set(c.id, c);
      return json(200, view(c));
    }
    if (method === "GET" && path === "/campaigns") {
      // Newest first, as the plugin asks with sort_field=create_time and sort_dir=DESC.
      const all = [...campaigns.values()].reverse();
      const offset = Number(q.get("offset") ?? 0);
      return json(200, { campaigns: all.slice(offset, offset + Number(q.get("count") ?? 10)).map(view), total_items: all.length });
    }
    const one = path.match(/^\/campaigns\/([a-z0-9]+)(\/content|\/send-checklist|\/actions\/send|\/actions\/unschedule)?$/);
    const c = one ? campaigns.get(one[1]!) : undefined;
    if (!c) return notFound();
    const sub = one?.[2] ?? "";
    if (method === "GET" && sub === "") return json(200, view(c));
    if (method === "PATCH" && sub === "") {
      if (body.settings?.title !== undefined) c.title = body.settings.title;
      return json(200, view(c));
    }
    if (method === "PUT" && sub === "/content") {
      c.html = body.html ?? "";
      return json(200, { html: c.html });
    }
    if (method === "GET" && sub === "/send-checklist") return json(200, checklist(c));
    if (method === "POST" && sub === "/actions/send") {
      if (c.status !== "save" || !checklist(c).is_ready) return problem(400, "Bad Request", "Your Campaign is not ready to send.");
      Object.assign(c, { status: "sent", sends: c.sends + 1 });
      return json(204, null);
    }
    if (method === "POST" && sub === "/actions/unschedule") {
      if (c.status !== "schedule") return problem(400, "Bad Request", "This campaign is not scheduled.");
      c.status = "save";
      return json(204, null);
    }
    return notFound();
  }) as typeof globalThis.fetch;

  return { fetch, key, calls, campaigns, lists, reports, revoke: () => void (revoked = true), limitNext: (times = 1) => void (limit = times) };
}
