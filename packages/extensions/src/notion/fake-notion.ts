// SPDX-License-Identifier: AGPL-3.0-only
// A fake Notion API for tests, answering with Notion's shapes. Pass `fetch` to the plugin. Pages
// hold blocks, and a block may hold blocks; children come `pageSize` at a time. `failNext(kind)`
// makes the next call answer as Notion does for a revoked token (401), a page not shared with the
// integration (404) or too many requests (429 with Retry-After).
export type FakeNotionBlock = { type: string; text?: string; children?: FakeNotionBlock[] };
export type FakeNotionPage = { id: string; title: string; editedAt?: string; blocks: FakeNotionBlock[] };
export type FakeNotionFailure = "revoked" | "not_shared" | "rate_limited";
/** A database's one data source: columns by name, and rows whose values are plain (a date is its start). */
export type FakeNotionColumn = { type: string; options?: string[] };
export type FakeNotionRow = { id: string; editedAt: string; values: Record<string, string | string[] | null> };
// A column's options are its choices by name; their ids are "opt-" and the name.
export type FakeNotionSource = { id: string; title: string; columns: Record<string, FakeNotionColumn>; rows: FakeNotionRow[] };

export function createFakeNotion(o: { token?: string; pages?: FakeNotionPage[]; sources?: FakeNotionSource[]; pageSize?: number } = {}) {
  const token = o.token ?? "ntn_test_token";
  const pages = [...(o.pages ?? [])];
  const sources = [...(o.sources ?? [])];
  const pageSize = o.pageSize ?? 100;
  const calls: { method: string; path: string; version: string | null; body: unknown }[] = [];
  const failures: FakeNotionFailure[] = [];
  const blocks = new Map<string, FakeNotionBlock[]>();
  let next = 0;
  const idOf = new WeakMap<FakeNotionBlock, string>();
  const register = (id: string, list: FakeNotionBlock[]) => {
    blocks.set(id, list);
    for (const b of list) {
      const bid = `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
      idOf.set(b, bid);
      if (b.children) register(bid, b.children);
    }
  };
  for (const p of pages) register(p.id, p.blocks);

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const error = (status: number, code: string, message: string, headers?: Record<string, string>) => json(status, { object: "error", status, code, message }, headers);
  const pageObject = (p: FakeNotionPage) => ({
    object: "page",
    id: p.id,
    url: `https://www.notion.so/${p.id.replaceAll("-", "")}`,
    last_edited_time: p.editedAt ?? "2026-11-10T10:00:00.000Z",
    properties: { Name: { id: "title", type: "title", title: [{ type: "text", plain_text: p.title }] } },
  });
  const blockObject = (b: FakeNotionBlock) => ({
    object: "block",
    id: idOf.get(b),
    type: b.type,
    has_children: Boolean(b.children?.length),
    [b.type]: b.text === undefined ? {} : { rich_text: [{ type: "text", plain_text: b.text }] },
  });

  const rich = (t: string) => [{ type: "text", plain_text: t }];
  const valueObject = (type: string, v: string | string[] | null) => {
    if (type === "title" || type === "rich_text") return { type, [type]: v === null ? [] : rich(String(v)) };
    if (type === "date") return { type, date: v === null ? null : { start: v, end: null } };
    // A choice's id is "opt-" and its name, so a test can write by id.
    if (type === "select" || type === "status") return { type, [type]: v === null ? null : { id: `opt-${v}`, name: v } };
    if (type === "multi_select") return { type, multi_select: (Array.isArray(v) ? v : []).map((name) => ({ name })) };
    return { type, [type]: v };
  };
  const sourceObject = (src: FakeNotionSource) => ({
    object: "data_source",
    id: src.id,
    title: rich(src.title),
    last_edited_time: "2026-11-10T10:00:00.000Z",
    properties: Object.fromEntries(Object.entries(src.columns).map(([name, c]) => [name, { id: name, name, type: c.type, [c.type]: c.options ? { options: c.options.map((n) => ({ id: `opt-${n}`, name: n })) } : {} }])),
  });
  const rowObject = (src: FakeNotionSource, r: FakeNotionRow) => ({
    object: "page",
    id: r.id,
    last_edited_time: r.editedAt,
    properties: Object.fromEntries(Object.entries(src.columns).map(([name, c]) => [name, { id: name, ...valueObject(c.type, r.values[name] ?? null) }])),
  });
  /** A database row and its source, found by the row's page id. */
  const rowOf = (id: string) => {
    for (const src of sources) {
      const r = src.rows.find((x) => x.id === id);
      if (r) return { src, r };
    }
    return undefined;
  };
  // Each write moves the row's edit time on a minute, as Notion's own clock would.
  let edits = 0;

  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v1/, "");
    const headers = new Headers(init?.headers);
    calls.push({ method, path: `${path}${url.search}`, version: headers.get("notion-version"), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (headers.get("authorization") !== `Bearer ${token}`) return error(401, "unauthorized", "API token is invalid.");
    const failure = failures.shift();
    if (failure === "revoked") return error(401, "unauthorized", "API token is invalid.");
    if (failure === "rate_limited") return error(429, "rate_limited", "You have been rate limited. Please try again in a few minutes.", { "retry-after": "3" });
    if (failure === "not_shared") return error(404, "object_not_found", "Could not find page. Make sure the relevant pages and databases are shared with your integration.");
    if (method === "POST" && path === "/search") {
      const want = (calls.at(-1)!.body as { filter?: { value?: string } } | null)?.filter?.value;
      return json(200, { object: "list", results: want === "data_source" ? sources.map(sourceObject) : pages.map(pageObject), next_cursor: null, has_more: false });
    }
    const source = /^\/data_sources\/([^/]+)(\/query)?$/.exec(path);
    if (source) {
      const src = sources.find((x) => x.id === source[1]);
      if (!src) return error(404, "object_not_found", "Could not find data source.");
      if (!source[2]) return json(200, sourceObject(src));
      const body = (calls.at(-1)!.body ?? {}) as { start_cursor?: string; page_size?: number; filter?: { last_edited_time?: { on_or_after?: string } } };
      const since = body.filter?.last_edited_time?.on_or_after;
      const list = src.rows.filter((r) => !since || r.editedAt >= since).sort((a, b) => a.editedAt.localeCompare(b.editedAt));
      const start = Number(body.start_cursor ?? 0);
      const size = Math.min(body.page_size ?? 100, pageSize);
      const more = start + size < list.length;
      return json(200, { object: "list", results: list.slice(start, start + size).map((r) => rowObject(src, r)), next_cursor: more ? String(start + size) : null, has_more: more });
    }
    const page = /^\/pages\/([^/]+)$/.exec(path)?.[1];
    if (page) {
      const row = rowOf(page);
      if (row && method === "PATCH") {
        const props = (calls.at(-1)!.body as { properties?: Record<string, Record<string, unknown>> }).properties ?? {};
        for (const [key, value] of Object.entries(props)) {
          const c = row.src.columns[key];
          if (!c) return error(400, "validation_error", `${key} is not a property that exists.`);
          const v = value[c.type] as { id?: string } | string | null;
          row.r.values[key] = typeof v === "string" || v === null ? v : (v?.id ?? "").replace(/^opt-/, "");
        }
        row.r.editedAt = new Date(Date.parse("2026-11-20T00:00:00.000Z") + ++edits * 60_000).toISOString();
        return json(200, rowObject(row.src, row.r));
      }
      if (row) return json(200, rowObject(row.src, row.r));
      const p = pages.find((x) => x.id === page);
      return p ? json(200, pageObject(p)) : error(404, "object_not_found", "Could not find page.");
    }
    const parent = /^\/blocks\/([^/]+)\/children$/.exec(path)?.[1];
    if (parent) {
      const list = blocks.get(parent);
      if (!list) return error(404, "object_not_found", "Could not find block.");
      const start = Number(url.searchParams.get("start_cursor") ?? 0);
      const size = Math.min(Number(url.searchParams.get("page_size") ?? 100), pageSize);
      const slice = list.slice(start, start + size);
      const more = start + size < list.length;
      return json(200, { object: "list", results: slice.map(blockObject), next_cursor: more ? String(start + size) : null, has_more: more });
    }
    return error(400, "invalid_request_url", "Invalid request URL.");
  }) as typeof globalThis.fetch;

  return { fetch, calls, token, sources, failNext: (kind: FakeNotionFailure) => void failures.push(kind) };
}
