// SPDX-License-Identifier: AGPL-3.0-only
// Notion's API, version 2026-03-11, written from developers.notion.com (checked 2026-11-14):
// POST /v1/search for the pages shared with the integration, GET /v1/pages/{id} for a title and
// GET /v1/blocks/{id}/children, one level at a time, for a page's text. Reads only. What a page
// says is data for whoever reads it, never an instruction.
import { definePlugin, effectSchemas, type Credential, type EffectHandler, type ExecuteResult, type ReconcileResult, PluginError, type PluginReason, type QueryOutput } from "@direx/plugin-sdk";
import { z } from "zod";
import { waitFrom } from "../newsletter/http";
import { notionManifest } from "./manifest";

export const NOTION_VERSION = "2026-03-11";
export const NOTION_DEFAULTS = {
  timeoutMs: 20_000,
  /** Used when a 429 doesn't say how long to wait. */
  rateLimitWaitMs: 2_000,
  /** How deep nested blocks are read, and how many blocks one page may take. */
  maxDepth: 3,
  maxBlocks: 1_000,
  /** The most text one page gives, the brand reader's own limit. */
  maxChars: 100_000,
};
export type NotionOptions = Partial<typeof NOTION_DEFAULTS> & { baseUrl?: string; fetch?: typeof fetch; now?: () => number };

/** Why a call failed, in a word the Brand page turns into a sentence. */
export type NotionReason = "needs_reconnecting" | "no_access" | "busy" | "failed";

/**
 * A failed answer. The host passes on only the message, so the status, any wait and the reason all
 * go in it, as "Notion answered 429; wait 2000 ms: busy". It never holds a token or a body.
 */
/** The host's reason for each of Notion's; no_access also goes as a code. */
const typed = (why: NotionReason): PluginReason => (why === "needs_reconnecting" ? "credential_rejected" : why === "busy" ? "rate_limited" : "provider_error");

export class NotionError extends PluginError {
  /** Always set: these come from an HTTP answer. */
  declare readonly status: number;
  readonly credentialRejected: boolean;
  constructor(
    status: number,
    why: NotionReason,
    readonly retryAfterMs?: number,
  ) {
    super(typed(why), `Notion answered ${status}${retryAfterMs === undefined ? "" : `; wait ${retryAfterMs} ms`}: ${why}`, {
      status,
      ...(retryAfterMs !== undefined && { waitMs: retryAfterMs }),
      ...(why === "no_access" && { code: why }),
    });
    this.credentialRejected = status === 401;
  }
}

/** A Notion id, with or without its dashes. */
export const notionId = z.string().regex(/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i, "a Notion page id");
const pageTextInput = z.strictObject({ pageId: notionId });
const sourcesInput = z.strictObject({ kind: z.enum(["page", "database"]).default("page") }).nullish();
const rowsInput = z.strictObject({ sourceId: notionId, cursor: z.string().min(1).max(500).optional(), editedSince: z.iso.datetime({ offset: true }).optional() });
/** The id in its dashed form, the one Notion answers with. */
const dashed = (id: string) => id.replaceAll("-", "").toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");

type RichText = { plain_text?: unknown }[];
type Block = { id: string; type: string; has_children?: boolean } & Record<string, unknown>;
type Page = { id: string; url?: unknown; last_edited_time?: unknown; properties?: Record<string, { type?: unknown; title?: RichText } & Record<string, unknown>> };
type SchemaProperty = { name?: unknown; type?: unknown } & Record<string, unknown>;
type DataSource = { id: string; title?: RichText; last_edited_time?: unknown; properties?: Record<string, SchemaProperty> };

const plain = (r: unknown) => (Array.isArray(r) ? (r as RichText).map((t) => (typeof t.plain_text === "string" ? t.plain_text : "")).join("") : "");
/** A page's title: its one title property, whatever the database calls it. */
const titleOf = (p: Page) => plain(Object.values(p.properties ?? {}).find((v) => v.type === "title")?.title).trim();

// Blocks whose words are the page's text. Code, embeds, files and child pages are not.
const TEXT_BLOCKS = new Set(["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "toggle", "quote", "callout"]);
const LISTS = new Set(["bulleted_list_item", "numbered_list_item", "to_do"]);
/** A child page or database is its own page: a person picks it on its own. */
const OWN_PAGE = new Set(["child_page", "child_database"]);

/** The kinds of column a mapping can use; the rest are listed with no options and read as nothing. */
const CHOICES = new Set(["select", "status", "multi_select"]);
/** A schema property as the core sees it: its name, its type, and the options of a choice column. */
const columnOf = (name: string, p: SchemaProperty) => {
  const type = typeof p.type === "string" ? p.type : "unknown";
  const raw = CHOICES.has(type) ? ((p[type] as { options?: { id?: unknown; name?: unknown }[] } | undefined)?.options ?? []) : null;
  const choices = raw?.flatMap((o) => (typeof o.name === "string" && typeof o.id === "string" ? [{ id: o.id, name: o.name }] : [])) ?? null;
  // A write-back goes by property and option id, so a rename in Notion can't redirect it (ADR 0025 rule 003).
  return { name, id: typeof p.id === "string" ? p.id : name, type, options: raw ? raw.flatMap((o) => (typeof o.name === "string" ? [o.name] : [])) : null, choices };
};
/** A row's value, simplified: words, a date's start, a choice's name or several names. */
function valueOf(v: Record<string, unknown> & { type?: unknown }): string | string[] | null {
  const type = typeof v.type === "string" ? v.type : "";
  const x = v[type] as unknown;
  if (type === "title" || type === "rich_text") return plain(x).trim() || null;
  if (type === "date") return typeof (x as { start?: unknown } | null)?.start === "string" ? (x as { start: string }).start : null;
  if (type === "select" || type === "status") return typeof (x as { name?: unknown } | null)?.name === "string" ? (x as { name: string }).name : null;
  if (type === "multi_select") return Array.isArray(x) ? x.flatMap((o: { name?: unknown }) => (typeof o.name === "string" ? [o.name] : [])) : null;
  if (type === "url" || type === "email" || type === "phone_number") return typeof x === "string" ? x : null;
  if (type === "number" || type === "checkbox") return x === null || x === undefined ? null : String(x);
  return null;
}

const lineOf = (b: Block) => {
  if (!TEXT_BLOCKS.has(b.type)) return null;
  const text = plain((b[b.type] as { rich_text?: unknown } | undefined)?.rich_text).trim();
  return text ? (LISTS.has(b.type) ? `- ${text}` : text) : null;
};

/**
 * One status write-back (ADR 0025 rule 003): the row, its status property and the option to set, the option
 * Direx last wrote (null for none), and on Sent the URL property and link. Ids only, never names.
 */
export const RowUpdate = effectSchemas("docs.row.update").input.extend({ pageId: notionId });
type RowUpdate = z.infer<typeof RowUpdate>;
type PageProps = { last_edited_time?: unknown; properties?: Record<string, { id?: unknown; type?: unknown } & Record<string, unknown>> };
/** The option id and URL a row holds now, read by property id. */
const holding = (page: PageProps, u: RowUpdate) => {
  const props = Object.values(page.properties ?? {});
  const status = props.find((p) => p.id === u.statusPropertyId);
  const option = (status?.[u.statusType] as { id?: unknown } | null | undefined)?.id;
  const url = u.urlPropertyId ? props.find((p) => p.id === u.urlPropertyId)?.url : undefined;
  return { found: Boolean(status), optionId: typeof option === "string" ? option : null, url: typeof url === "string" ? url : null };
};
/** A refusal as the ledger reads it: Notion said no, for good, and why in a word. */
const refusal = (e: unknown): ExecuteResult | null => {
  if (!(e instanceof NotionError)) return null;
  if (e.status === 401) return { kind: "refused", permanent: true, retryable: false, detail: "needs_reconnecting", credentialRejected: true };
  if (e.status === 403) return { kind: "refused", permanent: true, retryable: false, detail: "cant_edit" };
  if (e.status === 404) return { kind: "refused", permanent: true, retryable: false, detail: "row_gone" };
  if (e.status === 429) return { kind: "refused", permanent: false, retryable: true, detail: "busy" };
  // Notion refused the request itself, such as an option or property deleted since it was read. Final.
  if (e.status === 400) return { kind: "refused", permanent: true, retryable: false, detail: "rejected" };
  return null;
};

export function createNotionPlugin(o: NotionOptions = {}) {
  const cfg = { ...NOTION_DEFAULTS, ...o };
  const now = o.now ?? Date.now;
  const baseUrl = o.baseUrl ?? "https://api.notion.com/v1";
  const doFetch = o.fetch ?? fetch;

  async function req<T>(c: Credential | null, path: string, json?: unknown, method?: "PATCH"): Promise<T> {
    // The typed key of an internal integration, or the access token of the OAuth connection.
    const key = c && "key" in c ? c.key : c && "accessToken" in c ? c.accessToken : null;
    if (!key) throw new PluginError("not_connected", "Notion is not connected");
    const res = await doFetch(`${baseUrl}${path}`, {
      method: method ?? (json === undefined ? "GET" : "POST"),
      headers: { accept: "application/json", authorization: `Bearer ${key}`, "notion-version": NOTION_VERSION, ...(json !== undefined && { "content-type": "application/json" }) },
      ...(json !== undefined && { body: JSON.stringify(json) }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (res.status === 401) throw new NotionError(401, "needs_reconnecting");
    // A page not shared with the integration answers 404, as if it didn't exist.
    if (res.status === 403 || res.status === 404) throw new NotionError(res.status, "no_access");
    if (res.status === 429) throw new NotionError(429, "busy", waitFrom(res.headers, now(), cfg.rateLimitWaitMs));
    if (!res.ok) throw new NotionError(res.status, "failed");
    return (await res.json()) as T;
  }

  const rowUpdate: EffectHandler = {
    // Core builds the spec from the source's mapping; this checks its shape and says it in words.
    async prepare(input) {
      const spec = RowUpdate.parse(input);
      return { spec, preview: `Set the row's status${spec.url ? " and link" : ""} in Notion` };
    },
    // Compare and set: only over the option Direx last wrote or none, so a person's own status stands.
    async execute(spec, ctx): Promise<ExecuteResult> {
      const u = RowUpdate.parse(spec);
      try {
        const page = await req<PageProps>(ctx.credential, `/pages/${dashed(u.pageId)}`);
        const now = holding(page, u);
        if (!now.found) return { kind: "refused", permanent: true, retryable: false, detail: "column_gone" };
        if (now.optionId !== null && now.optionId !== u.optionId && now.optionId !== u.lastOptionId) return { kind: "refused", permanent: true, retryable: false, detail: "changed_in_source" };
        const properties = {
          [u.statusPropertyId]: { [u.statusType]: { id: u.optionId } },
          ...(u.urlPropertyId && u.url && { [u.urlPropertyId]: { url: u.url } }),
        };
        const after = await req<PageProps>(ctx.credential, `/pages/${dashed(u.pageId)}`, { properties }, "PATCH");
        // providerRef carries the edit time the write made, so the import knows it as Direx's own (rule 003).
        return { kind: "sent", ...(typeof after.last_edited_time === "string" && { providerRef: after.last_edited_time }) };
      } catch (e) {
        const r = refusal(e);
        if (r) return r;
        throw e;
      }
    },
    // The whole patch present is sent; the column as it was before is not sent; anything else is unknown.
    async reconcile(_key, ctx, spec): Promise<ReconcileResult> {
      const u = RowUpdate.safeParse(spec);
      if (!u.success) return { kind: "unknown" };
      try {
        const page = await req<PageProps>(ctx.credential, `/pages/${dashed(u.data.pageId)}`);
        const now = holding(page, u.data);
        const whole = now.optionId === u.data.optionId && (!u.data.urlPropertyId || !u.data.url || now.url === u.data.url);
        if (whole) return { kind: "sent", ...(typeof page.last_edited_time === "string" && { providerRef: page.last_edited_time }) };
        if (now.optionId === u.data.lastOptionId) return { kind: "not_sent" };
        return { kind: "unknown" };
      } catch (e) {
        const r = refusal(e);
        return r && r.kind === "refused" && r.permanent ? { kind: "refused", detail: r.detail ?? "refused" } : { kind: "unknown" };
      }
    },
  };

  return definePlugin({
    manifest: notionManifest,
    effects: { "docs.row.update": rowUpdate },
    queries: {
      /** The newest 100 pages, or databases (their data sources), shared with the integration, newest edit first. */
      "docs.sources": async (input, ctx): Promise<QueryOutput<"docs.sources">> => {
        const p = sourcesInput.safeParse(input);
        if (!p.success) throw new Error("docs.sources takes { kind?: page | database }");
        const kind = p.data?.kind ?? "page";
        const r = await req<{ results?: (Page & DataSource)[]; has_more?: boolean }>(ctx.credential, "/search", {
          filter: { property: "object", value: kind === "page" ? "page" : "data_source" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          page_size: 100,
        });
        const pages = (r.results ?? []).map((x) => ({
          id: x.id,
          title: (kind === "page" ? titleOf(x) : plain(x.title).trim()) || "Untitled",
          url: typeof x.url === "string" ? x.url : null,
          editedAt: typeof x.last_edited_time === "string" ? x.last_edited_time : null,
        }));
        return { pages, more: r.has_more === true };
      },
      /** One data source's columns, and a page of its rows edited since `editedSince`, oldest edit first. */
      "docs.rows": async (input, ctx): Promise<QueryOutput<"docs.rows">> => {
        const p = rowsInput.safeParse(input);
        if (!p.success) throw new Error("docs.rows takes { sourceId, cursor?, editedSince? }");
        const id = dashed(p.data.sourceId);
        const source = await req<DataSource>(ctx.credential, `/data_sources/${id}`);
        const r = await req<{ results?: Page[]; has_more?: boolean; next_cursor?: string | null }>(ctx.credential, `/data_sources/${id}/query`, {
          page_size: 100,
          sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
          ...(p.data.cursor && { start_cursor: p.data.cursor }),
          ...(p.data.editedSince && { filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: p.data.editedSince } } }),
        });
        return {
          title: plain(source.title).trim() || "Untitled",
          columns: Object.entries(source.properties ?? {}).map(([name, prop]) => columnOf(name, prop)),
          rows: (r.results ?? []).map((row) => ({
            id: row.id,
            editedAt: typeof row.last_edited_time === "string" ? row.last_edited_time : null,
            values: Object.fromEntries(Object.entries(row.properties ?? {}).map(([name, v]) => [name, valueOf(v)])),
          })),
          next: r.has_more && r.next_cursor ? r.next_cursor : null,
        };
      },
      /** One page's title and text, nested blocks read to a depth, cut at the limit and saying so. */
      "docs.page_text": async (input, ctx): Promise<QueryOutput<"docs.page_text">> => {
        const p = pageTextInput.safeParse(input);
        if (!p.success) throw new Error("docs.page_text takes { pageId }");
        const pageId = dashed(p.data.pageId);
        const page = await req<Page>(ctx.credential, `/pages/${pageId}`);
        const lines: string[] = [];
        let chars = 0;
        let blocks = 0;
        let cut = false;
        const full = () => chars >= cfg.maxChars || blocks >= cfg.maxBlocks;
        async function walk(id: string, depth: number) {
          let cursor: string | undefined;
          do {
            const r = await req<{ results?: Block[]; has_more?: boolean; next_cursor?: string | null }>(ctx.credential, `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`);
            for (const b of r.results ?? []) {
              if (full()) return void (cut = true);
              blocks += 1;
              const line = lineOf(b);
              if (line) {
                lines.push(line);
                chars += line.length + 1;
              }
              if (b.has_children && !OWN_PAGE.has(b.type)) {
                if (depth < cfg.maxDepth) await walk(b.id, depth + 1);
                else cut = true;
              }
            }
            cursor = r.has_more && r.next_cursor ? r.next_cursor : undefined;
          } while (cursor && !full());
          if (cursor) cut = true;
        }
        await walk(pageId, 1);
        const text = lines.join("\n");
        return { title: titleOf(page) || "Untitled", text: text.slice(0, cfg.maxChars), cut: cut || text.length > cfg.maxChars };
      },
    },
  });
}
