// SPDX-License-Identifier: AGPL-3.0-only
// Mailchimp's Marketing API 3.0: a list's members in pages, the account's lists, and a campaign's
// report. Endpoints and field names are from Mailchimp's OpenAPI description, read 2026-11-20;
// nothing here has run against a real account yet.
import { definePlugin, PluginError, type Credential } from "@direx/plugin-sdk";
import { z } from "zod";
import { listsOutput, profileOutput, statsOutput, subscribersInput, subscribersOutput, toSubscriberState, type SubscriberState } from "../newsletter/contract";
import { call, keyOf, type NewsletterHttp } from "../newsletter/http";
import { mailchimpManifest } from "./manifest";

export const MAILCHIMP_DEFAULTS = {
  timeoutMs: 20_000,
  /** Mailchimp's 429 is about concurrent calls and comes with no header saying how long to wait. */
  rateLimitWaitMs: 60_000,
  /** Mailchimp's maximum. */
  pageSize: 1000,
};
export type MailchimpOptions = Partial<typeof MAILCHIMP_DEFAULTS> & { fetch?: typeof fetch; now?: () => number };

/** Mailchimp's member states. `pending`, `transactional`, `archived` and anything new stay "other". */
export const MAILCHIMP_STATES: Readonly<Record<string, SubscriberState>> = { subscribed: "subscribed", unsubscribed: "unsubscribed", cleaned: "bounced" };

/** The data center at the end of a key, such as "us21". It becomes the host, so nothing else is accepted. */
const DC = /-([a-z]{2,4}[0-9]{1,3})$/;
/** Campaign and list ids go into paths, so only plain ids are accepted. */
const ID = /^[a-z0-9]{1,40}$/;

const issueInput = z.strictObject({ issueId: z.string().regex(ID) });
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);
const isTotal = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const iso = (...v: unknown[]) => {
  for (const x of v) if (typeof x === "string" && Number.isFinite(Date.parse(x))) return new Date(x).toISOString();
  return null;
};

type List = { id?: unknown; name?: unknown; stats?: { member_count?: unknown } };
type Member = { email_address?: unknown; status?: unknown; timestamp_opt?: unknown; timestamp_signup?: unknown; last_changed?: unknown };

export function createMailchimpPlugin(o: MailchimpOptions = {}) {
  const cfg = { ...MAILCHIMP_DEFAULTS, ...o };
  const now = o.now ?? Date.now;
  function http(c: Credential | null): NewsletterHttp {
    const key = keyOf("Mailchimp", c);
    const dc = DC.exec(key)?.[1];
    if (!dc) throw new PluginError("credential_rejected", "this doesn't look like a Mailchimp API key: it should end in a data center, such as -us21");
    return { tool: "Mailchimp", baseUrl: `https://${dc}.api.mailchimp.com/3.0`, fetch: o.fetch ?? fetch, timeoutMs: cfg.timeoutMs, headers: { authorization: `Basic ${btoa(`direx:${key}`)}` } };
  }
  const req = <T>(c: Credential | null, path: string, method = "GET", json?: unknown) =>
    call<T>(http(c), path, { method, ...(json !== undefined && { json }), rateLimitWaitMs: cfg.rateLimitWaitMs, now }).then((r) => r.body);
  async function allLists(c: Credential | null): Promise<List[]> {
    const count = MAILCHIMP_DEFAULTS.pageSize;
    const lists: List[] = [];
    for (;;) {
      const page = await req<{ lists?: List[]; total_items?: unknown }>(c, `/lists?count=${count}&offset=${lists.length}`);
      if (!Array.isArray(page?.lists) || (page.total_items !== undefined && !isTotal(page.total_items))) {
        throw new PluginError("provider_error", "Mailchimp returned an unreadable list page");
      }
      lists.push(...page.lists);
      if (isTotal(page.total_items) ? lists.length >= page.total_items : page.lists.length < count) return lists;
      if (page.lists.length === 0) throw new PluginError("provider_error", "Mailchimp returned an incomplete list page");
    }
  }

  /** The list a read is about: the one named, or the account's only list. */
  async function listOf(c: Credential | null, listId: string | undefined): Promise<string> {
    if (listId) {
      if (!ID.test(listId)) throw new PluginError("invalid_params", "a Mailchimp list id is letters and digits");
      return listId;
    }
    const lists = await allLists(c);
    if (lists.length !== 1 || typeof lists[0]!.id !== "string") throw new PluginError("invalid_params", "Mailchimp has several lists: choose one on the Newsletter settings page");
    return lists[0]!.id;
  }

  async function subscribers(input: unknown, c: Credential | null) {
    const p = subscribersInput.safeParse(input ?? {});
    if (!p.success) throw new Error("newsletter.subscribers takes { cursor?, changedSince?, listId? }");
    const list = await listOf(c, p.data.listId);
    const offset = Number(p.data.cursor ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new PluginError("invalid_params", "a Mailchimp cursor is an offset");
    const q = new URLSearchParams({ count: String(cfg.pageSize), offset: String(offset), fields: "members.email_address,members.status,members.timestamp_opt,members.timestamp_signup,members.last_changed,total_items" });
    if (p.data.changedSince) q.set("since_last_changed", p.data.changedSince);
    const page = await req<{ members?: Member[]; total_items?: unknown }>(c, `/lists/${list}/members?${q}`);
    if (!Array.isArray(page?.members) || !isTotal(page.total_items)) {
      throw new PluginError("provider_error", "Mailchimp returned an unreadable member page");
    }
    const { members } = page;
    if (members.length === 0 && offset < page.total_items) {
      throw new PluginError("provider_error", "Mailchimp returned an incomplete member page");
    }
    const rows = members.flatMap((m) => {
      const createdAt = iso(m.timestamp_opt, m.timestamp_signup, m.last_changed);
      const updatedAt = iso(m.last_changed);
      return typeof m.email_address === "string" && createdAt
        ? [{ email: m.email_address.toLowerCase(), state: toSubscriberState(typeof m.status === "string" ? m.status : "", MAILCHIMP_STATES), createdAt, ...(updatedAt && { updatedAt }) }]
        : [];
    });
    const next = offset + members.length;
    return subscribersOutput.parse({ subscribers: rows, nextCursor: next < page.total_items ? String(next) : null });
  }

  async function profile(input: unknown, c: Credential | null) {
    const listId = (input as { listId?: unknown } | null | undefined)?.listId;
    if (typeof listId === "string") {
      const l = (await req<List>(c, `/lists/${await listOf(c, listId)}`)) ?? {};
      return profileOutput.parse({ listName: typeof l.name === "string" ? l.name : "Mailchimp", subscriberCount: n(l.stats?.member_count), canSend: true });
    }
    // No list chosen yet. Answering for the whole account lets a new key be saved, after which the
    // Newsletter page asks which list. Someone on two lists is counted twice here.
    const lists = await allLists(c);
    const one = lists.length === 1 && typeof lists[0]!.name === "string" ? lists[0]!.name : null;
    return profileOutput.parse({ listName: one ?? "Mailchimp", subscriberCount: lists.reduce((s, l) => s + n(l.stats?.member_count), 0), canSend: true });
  }

  async function lists(c: Credential | null) {
    return listsOutput.parse((await allLists(c)).flatMap((l) => (typeof l.id === "string" && ID.test(l.id) ? [{ id: l.id, name: typeof l.name === "string" ? l.name : l.id, subscriberCount: n(l.stats?.member_count) }] : [])));
  }

  async function stats(input: unknown, c: Credential | null) {
    const p = issueInput.safeParse(input);
    if (!p.success) throw new Error("newsletter.stats takes { issueId } with a Mailchimp campaign id");
    const r = (await req<{ emails_sent?: unknown; unsubscribed?: unknown; opens?: { unique_opens?: unknown }; clicks?: { unique_clicks?: unknown } }>(c, `/reports/${p.data.issueId}`)) ?? {};
    return statsOutput.parse({ recipients: n(r.emails_sent), clicks: n(r.clicks?.unique_clicks), unsubscribes: n(r.unsubscribed), opens: n(r.opens?.unique_opens) });
  }

  return definePlugin({
    manifest: mailchimpManifest,
    queries: {
      "newsletter.subscribers": (input, ctx) => subscribers(input, ctx.credential),
      "newsletter.profile": (input, ctx) => profile(input, ctx.credential),
      "newsletter.stats": (input, ctx) => stats(input, ctx.credential),
      "newsletter.lists": (_input, ctx) => lists(ctx.credential),
    },
  });
}
