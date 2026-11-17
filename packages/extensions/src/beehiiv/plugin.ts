// SPDX-License-Identifier: AGPL-3.0-only
// beehiiv's API v2: posts drafted and sent, the subscriber list in pages, the publication's name and
// size, and a post's email stats. Field names are the ones recorded against a real beehiiv trial on
// 2026-11-04; the subscriber states and the draft-to-confirmed PATCH are from beehiiv's docs.
// beehiiv can't unschedule a post, so Direx keeps an Issue until its time and then sends it at once:
// before that a cancel never reaches beehiiv, and after it the post is already sent.
import { definePlugin, type Credential, type ExecuteResult } from "@direx/plugin-sdk";
import { z } from "zod";
import { cancelInput, draftInput, profileOutput, publishInput, sendInput, statsOutput, subscribersInput, subscribersOutput, toSubscriberState, type SubscriberState } from "../newsletter/contract";
import { call, keyOf, NewsletterHttpError, type NewsletterHttp } from "../newsletter/http";
import { beehiivManifest } from "./manifest";

export const BEEHIIV_DEFAULTS = {
  timeoutMs: 20_000,
  /** Used only when a 429 comes without beehiiv's ratelimit-reset header. */
  rateLimitWaitMs: 60_000,
  /** beehiiv's maximum. */
  pageSize: 100,
};
export type BeehiivOptions = Partial<typeof BEEHIIV_DEFAULTS> & { baseUrl?: string; fetch?: typeof fetch; now?: () => number };

/**
 * beehiiv's subscription states. A paused reader is still a subscriber; `inactive` is beehiiv's word
 * for an unsubscribe. `pending` (double opt-in not finished), `validating`, `invalid`,
 * `needs_attention`, `unset` and anything new stay "other". beehiiv has no bounced or complained state.
 */
export const BEEHIIV_STATES: Readonly<Record<string, SubscriberState>> = { active: "subscribed", paused: "subscribed", inactive: "unsubscribed" };

type BeehiivSubscription = { email?: unknown; status?: unknown; created?: unknown };

const POST_ID = /^post_[0-9a-f-]{36}$/;
const issueInput = z.strictObject({ issueId: z.string().regex(POST_ID) });

/** What a refusal says when beehiiv's plan doesn't allow sending through the API. */
export const NEEDS_PRO = "needs Pro: beehiiv refused to send through its API on this plan";
const refused = (retryable: boolean, detail: string): ExecuteResult => ({ kind: "refused", permanent: !retryable, retryable, detail });
/** A failed answer as a refusal. A dropped connection is not an answer, so it throws and the Dispatcher holds the Action. */
function refusal(e: unknown): ExecuteResult {
  if (!(e instanceof NewsletterHttpError)) throw e;
  if (e.credentialRejected) return { kind: "refused", permanent: false, retryable: true, detail: e.message, credentialRejected: true };
  if (e.status === 403) return { kind: "refused", permanent: false, retryable: false, detail: NEEDS_PRO, plan: "Pro" };
  if (e.status === 429 || e.status >= 500) return refused(true, e.message);
  return refused(false, e.message);
}
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);
const iso = (unixSeconds: unknown) => (typeof unixSeconds === "number" && Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000).toISOString() : null);

export function createBeehiivPlugin(o: BeehiivOptions = {}) {
  const cfg = { ...BEEHIIV_DEFAULTS, ...o };
  const http = (c: Credential | null): NewsletterHttp => ({
    tool: "beehiiv",
    baseUrl: o.baseUrl ?? "https://api.beehiiv.com/v2",
    fetch: o.fetch ?? fetch,
    timeoutMs: cfg.timeoutMs,
    headers: { authorization: `Bearer ${keyOf("beehiiv", c)}` },
  });
  const req = <T>(c: Credential | null, path: string, method = "GET", json?: unknown) =>
    call<T>(http(c), path, { method, ...(json !== undefined && { json }), rateLimitWaitMs: cfg.rateLimitWaitMs, ...(o.now && { now: o.now }) }).then((r) => r.body);
  const get = <T>(c: Credential | null, path: string) => req<T>(c, path);
  const now = o.now ?? Date.now;
  const postStatus = async (c: Credential | null, pub: string, id: string) => (await get<{ data?: { status?: unknown } }>(c, `/publications/${pub}/posts/${id}`))?.data?.status;

  const prepareWith = <T extends z.ZodType>(schema: T, name: string, preview: (d: z.infer<T>) => string) => async (input: unknown) => {
    const p = schema.safeParse(input);
    if (!p.success) throw new Error(`${name}: ${p.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}`);
    return { spec: p.data, preview: preview(p.data) };
  };

  // ponytail: one publication per key, looked up once per process. A key reaching several
  // publications is refused; a picker on the connect screen if customers need that.
  const publications = new Map<string, string>();
  async function publicationOf(c: Credential | null): Promise<string> {
    const key = keyOf("beehiiv", c);
    const known = publications.get(key);
    if (known) return known;
    const list = (await get<{ data?: { id?: unknown }[] }>(c, "/publications?limit=2"))?.data ?? [];
    const ids = list.flatMap((p) => (typeof p.id === "string" && /^pub_[0-9a-f-]{36}$/.test(p.id) ? [p.id] : []));
    if (ids.length !== 1) throw new Error(ids.length ? "this beehiiv key reaches more than one publication; Direx needs a key for one" : "this beehiiv key reaches no publication");
    publications.set(key, ids[0]!);
    return ids[0]!;
  }

  async function subscribers(input: unknown, c: Credential | null) {
    const p = subscribersInput.safeParse(input ?? {});
    if (!p.success) throw new Error("newsletter.subscribers takes { cursor?, changedSince? }");
    // beehiiv has no changed-since filter, so every read is the whole list.
    const pub = await publicationOf(c);
    const q = new URLSearchParams({ status: "all", limit: String(cfg.pageSize) });
    if (p.data.cursor) q.set("cursor", p.data.cursor);
    const page = await get<{ data?: BeehiivSubscription[]; has_more?: boolean; next_cursor?: string | null }>(c, `/publications/${pub}/subscriptions?${q}`);
    const rows = (page?.data ?? []).flatMap((s) => {
      const createdAt = iso(s.created);
      return typeof s.email === "string" && createdAt ? [{ email: s.email.toLowerCase(), state: toSubscriberState(typeof s.status === "string" ? s.status : "", BEEHIIV_STATES), createdAt }] : [];
    });
    return subscribersOutput.parse({ subscribers: rows, nextCursor: page?.has_more && page.next_cursor ? page.next_cursor : null });
  }

  async function profile(c: Credential | null) {
    const pub = await publicationOf(c);
    const d = (await get<{ data?: { name?: unknown; stats?: { active_subscriptions?: unknown } } }>(c, `/publications/${pub}?expand[]=stats`))?.data;
    // Whether this plan can send is only known once beehiiv takes or refuses a send.
    return profileOutput.parse({ listName: typeof d?.name === "string" ? d.name : "beehiiv", subscriberCount: n(d?.stats?.active_subscriptions), canSend: true });
  }

  async function stats(input: unknown, c: Credential | null) {
    const p = issueInput.safeParse(input);
    if (!p.success) throw new Error("newsletter.stats takes { issueId } with a beehiiv post id");
    const pub = await publicationOf(c);
    const e = (await get<{ data?: { stats?: { email?: Record<string, unknown> } } }>(c, `/publications/${pub}/posts/${p.data.issueId}?expand[]=stats`))?.data?.stats?.email ?? {};
    return statsOutput.parse({ recipients: n(e.recipients), delivered: n(e.delivered), clicks: n(e.unique_clicks), unsubscribes: n(e.unsubscribes), opens: n(e.unique_opens) });
  }

  return definePlugin({
    manifest: beehiivManifest,
    effects: {
      "newsletter.draft": {
        prepare: prepareWith(draftInput, "newsletter.draft", (d) => `Draft "${d.title}" in beehiiv`),
        async execute(spec, ctx) {
          const d = draftInput.safeParse(spec);
          if (!d.success) return refused(false, "the approved spec is not a newsletter draft");
          try {
            const pub = await publicationOf(ctx.credential);
            // Preview text isn't sent: the create call's docs don't list it, and beehiiv derives one.
            const r = await req<{ data?: { id?: unknown } }>(ctx.credential, `/publications/${pub}/posts`, "POST", { title: d.data.title, body_content: d.data.html, status: "draft" });
            const id = r?.data?.id;
            if (typeof id !== "string" || !POST_ID.test(id)) throw new Error("beehiiv answered without a post id");
            return { kind: "sent", providerRef: id };
          } catch (e) {
            return refusal(e);
          }
        },
      },

      "newsletter.send": {
        prepare: prepareWith(sendInput, "newsletter.send", (d) => `Send beehiiv post ${d.issueId} now`),
        async execute(spec, ctx) {
          const s = sendInput.safeParse(spec);
          if (!s.success || !POST_ID.test(s.data.issueId)) return refused(false, "the approved spec is not a beehiiv send");
          if (s.data.at && Date.parse(s.data.at) > now() + 60_000) return refused(false, "beehiiv can't unschedule a post, so Direx sends it at its time, not before");
          try {
            const pub = await publicationOf(ctx.credential);
            const status = await postStatus(ctx.credential, pub, s.data.issueId);
            if (status !== "draft") return refused(false, `the post is ${String(status)}, not a draft, so it is not sent again`);
            await req(ctx.credential, `/publications/${pub}/posts/${s.data.issueId}`, "PATCH", { status: "confirmed" });
            return { kind: "sent", providerRef: s.data.issueId };
          } catch (e) {
            return refusal(e);
          }
        },
      },

      // One call that creates the post and sends it now. Direx calls it at the Issue's time.
      "newsletter.publish": {
        prepare: prepareWith(publishInput, "newsletter.publish", (d) => `Publish "${d.title}" to beehiiv now`),
        async execute(spec, ctx) {
          const p = publishInput.safeParse(spec);
          if (!p.success) return refused(false, "the approved spec is not a newsletter issue");
          if (p.data.at && Date.parse(p.data.at) > now() + 60_000) return refused(false, "beehiiv can't unschedule a post, so Direx sends it at its time, not before");
          try {
            const pub = await publicationOf(ctx.credential);
            const r = await req<{ data?: { id?: unknown } }>(ctx.credential, `/publications/${pub}/posts`, "POST", { title: p.data.title, body_content: p.data.html, status: "confirmed" });
            const id = r?.data?.id;
            if (typeof id !== "string" || !POST_ID.test(id)) throw new Error("beehiiv answered without a post id");
            return { kind: "sent", providerRef: id };
          } catch (e) {
            return refusal(e);
          }
        },
      },

      "newsletter.cancel": {
        prepare: prepareWith(cancelInput, "newsletter.cancel", (d) => `Cancel beehiiv post ${d.issueId}`),
        async execute(spec, ctx) {
          const s = cancelInput.safeParse(spec);
          if (!s.success || !POST_ID.test(s.data.issueId)) return refused(false, "the approved spec is not a beehiiv cancel");
          try {
            const pub = await publicationOf(ctx.credential);
            // A draft was never sent, so there is nothing to stop. Anything else has gone to beehiiv.
            if ((await postStatus(ctx.credential, pub, s.data.issueId)) === "draft") return { kind: "sent", providerRef: s.data.issueId };
            return refused(false, "already sent: beehiiv can't unschedule a post once it has it");
          } catch (e) {
            return refusal(e);
          }
        },
      },
    },
    queries: {
      "newsletter.subscribers": (input, ctx) => subscribers(input, ctx.credential),
      "newsletter.profile": (_input, ctx) => profile(ctx.credential),
      "newsletter.stats": (input, ctx) => stats(input, ctx.credential),
    },
  });
}
