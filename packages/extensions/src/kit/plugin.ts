// SPDX-License-Identifier: AGPL-3.0-only
// Kit's API v4: broadcasts drafted, scheduled and unscheduled, the subscriber list in pages, the
// account's name and size, and a broadcast's stats. Field names are the ones recorded against real
// Kit on 2026-11-04. Kit has no send-now, so a send schedules the broadcast a few minutes out and a
// cancel inside that window puts it back to draft.
import { definePlugin, type Credential, type ExecuteResult, type ReconcileResult } from "@direx/plugin-sdk";
import { z } from "zod";
import { cancelInput, draftInput, profileOutput, publishInput, sendInput, statsOutput, subscribersInput, subscribersOutput, toSubscriberState, type SubscriberState } from "../newsletter/contract";
import { call, keyOf, NewsletterHttpError, type NewsletterHttp } from "../newsletter/http";
import { kitManifest } from "./manifest";

export const KIT_DEFAULTS = {
  timeoutMs: 20_000,
  /** Kit sends no rate limit headers, so a 429 waits this long. */
  rateLimitWaitMs: 60_000,
  pageSize: 500,
  /** A send goes this far out, so a pause or cancel can still stop it. */
  sendDelayMs: 5 * 60_000,
  /** How many pages of recent broadcasts reconcile reads looking for our marker. */
  reconcilePages: 5,
};
export type KitOptions = Partial<typeof KIT_DEFAULTS> & { baseUrl?: string; fetch?: typeof fetch; now?: () => number };

/** Kit's subscriber states. `inactive` and anything new stay "other". */
export const KIT_STATES: Readonly<Record<string, SubscriberState>> = { active: "subscribed", cancelled: "unsubscribed", bounced: "bounced", complained: "complained" };

/**
 * Every write stamps the broadcast's internal description, which subscribers never see, with the
 * ledger Action's id: `direx:<id>` when drafted, then `send:<id>` and `cancel:<id>`. A retry after a
 * lost answer finds the broadcast by that stamp, and a send refuses a broadcast Direx didn't draft.
 */
const DRAFTED = "direx:";
const stamped = (b: KitBroadcast, mark: string) => typeof b.description === "string" && b.description.split(" ").includes(mark);

type KitSubscriber = { email_address?: unknown; state?: unknown; created_at?: unknown };
type KitPage = { subscribers?: KitSubscriber[]; pagination?: { has_next_page?: boolean; end_cursor?: string | null; total_count?: number } };
type KitBroadcast = { id?: unknown; status?: unknown; description?: unknown; send_at?: unknown };
type KitBroadcasts = { broadcasts?: KitBroadcast[]; pagination?: { has_next_page?: boolean; end_cursor?: string | null } };

const issueInput = z.strictObject({ issueId: z.string().regex(/^\d{1,20}$/) });
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);

const refused = (retryable: boolean, detail: string): ExecuteResult => ({ kind: "refused", permanent: !retryable, retryable, detail });
/** A failed answer as a refusal. A dropped connection is not an answer, so it throws and the Dispatcher reconciles. */
function refusal(e: unknown): ExecuteResult {
  if (!(e instanceof NewsletterHttpError)) throw e;
  if (e.credentialRejected) return { kind: "refused", permanent: false, retryable: true, detail: e.message, credentialRejected: true };
  if (e.status === 429 || e.status >= 500) return refused(true, e.message);
  return refused(false, e.message);
}

export function createKitPlugin(o: KitOptions = {}) {
  const cfg = { ...KIT_DEFAULTS, ...o };
  const now = o.now ?? Date.now;
  const http = (c: Credential | null): NewsletterHttp => ({
    tool: "Kit",
    baseUrl: o.baseUrl ?? "https://api.kit.com/v4",
    fetch: o.fetch ?? fetch,
    timeoutMs: cfg.timeoutMs,
    headers: { "x-kit-api-key": keyOf("Kit", c) },
  });
  const req = <T>(c: Credential | null, path: string, method = "GET", json?: unknown) =>
    call<T>(http(c), path, { method, ...(json !== undefined && { json }), rateLimitWaitMs: cfg.rateLimitWaitMs, now }).then((r) => r.body);
  const broadcast = async (c: Credential | null, id: string) => (await req<{ broadcast?: KitBroadcast }>(c, `/broadcasts/${id}`))?.broadcast ?? {};
  const put = (c: Credential | null, id: string, json: unknown) => req<{ broadcast?: KitBroadcast }>(c, `/broadcasts/${id}`, "PUT", json);

  /**
   * Whether Kit has started or finished sending. The stats' status is the one Kit was seen to move
   * to "completed" after a real send, and a send time already reached counts as gone too, in case
   * the stats lag. The recipient count is no evidence: Kit fills it in while the broadcast is still
   * scheduled.
   */
  async function hasGone(c: Credential | null, id: string, b: KitBroadcast): Promise<boolean> {
    const s = (await req<{ broadcast?: { stats?: { status?: unknown } } }>(c, `/broadcasts/${id}/stats`))?.broadcast?.stats?.status;
    if (s !== "draft" && s !== "scheduled") return true;
    const at = typeof b.send_at === "string" ? Date.parse(b.send_at) : Number.NaN;
    return Number.isFinite(at) && at <= now() + 30_000;
  }

  /** The newest broadcast carrying `mark`, or null if none of the recent pages has it. */
  async function findStamped(c: Credential | null, mark: string): Promise<KitBroadcast | null> {
    let after: string | null = null;
    for (let i = 0; i < cfg.reconcilePages; i++) {
      const page: KitBroadcasts = await req<KitBroadcasts>(c, `/broadcasts?per_page=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
      const hit = (page?.broadcasts ?? []).find((b) => stamped(b, mark));
      if (hit) return hit;
      if (!page?.pagination?.has_next_page || !page.pagination.end_cursor) return null;
      after = page.pagination.end_cursor;
    }
    return null;
  }

  /** Only ever confirms. A miss stays unknown, so a person decides rather than Direx sending twice. */
  const reconcileBy =
    (prefix: string, done: (b: KitBroadcast) => boolean) =>
    async (_key: string, ctx: { idempotencyKey: string; credential: Credential | null }): Promise<ReconcileResult> => {
      try {
        const b = await findStamped(ctx.credential, `${prefix}${ctx.idempotencyKey}`);
        return b && done(b) ? { kind: "sent", providerRef: String(b.id) } : { kind: "unknown" };
      } catch {
        return { kind: "unknown" };
      }
    };

  const prepareWith = <T extends z.ZodType>(schema: T, name: string, preview: (d: z.infer<T>) => string) => async (input: unknown) => {
    const p = schema.safeParse(input);
    if (!p.success) throw new Error(`${name}: ${p.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}`);
    return { spec: p.data, preview: preview(p.data) };
  };

  async function subscribers(input: unknown, c: Credential | null) {
    const p = subscribersInput.safeParse(input ?? {});
    if (!p.success) throw new Error("newsletter.subscribers takes { cursor?, changedSince? }");
    const q = new URLSearchParams({ status: "all", per_page: String(cfg.pageSize) });
    if (p.data.cursor) q.set("after", p.data.cursor);
    if (p.data.changedSince) q.set("updated_after", p.data.changedSince);
    const page = await req<KitPage>(c, `/subscribers?${q}`);
    const rows = (page?.subscribers ?? []).flatMap((s) =>
      typeof s.email_address === "string" && typeof s.created_at === "string"
        ? [{ email: s.email_address.toLowerCase(), state: toSubscriberState(typeof s.state === "string" ? s.state : "", KIT_STATES), createdAt: s.created_at }]
        : [],
    );
    const next = page?.pagination?.has_next_page && page.pagination.end_cursor ? page.pagination.end_cursor : null;
    return subscribersOutput.parse({ subscribers: rows, nextCursor: next });
  }

  async function profile(c: Credential | null) {
    const account = await req<{ account?: { name?: unknown } }>(c, "/account");
    const active = await req<KitPage>(c, "/subscribers?status=active&per_page=1&include_total_count=true");
    return profileOutput.parse({ listName: typeof account?.account?.name === "string" ? account.account.name : "Kit", subscriberCount: n(active?.pagination?.total_count), canSend: true });
  }

  async function stats(input: unknown, c: Credential | null) {
    const p = issueInput.safeParse(input);
    if (!p.success) throw new Error("newsletter.stats takes { issueId } with a Kit broadcast id");
    const s = (await req<{ broadcast?: { stats?: Record<string, unknown> } }>(c, `/broadcasts/${p.data.issueId}/stats`))?.broadcast?.stats ?? {};
    return statsOutput.parse({ recipients: n(s.recipients), clicks: n(s.total_clicks), unsubscribes: n(s.unsubscribes), opens: n(s.emails_opened) });
  }

  return definePlugin({
    manifest: kitManifest,
    effects: {
      "newsletter.draft": {
        prepare: prepareWith(draftInput, "newsletter.draft", (d) => `Draft "${d.title}" in Kit`),
        async execute(spec, ctx) {
          const d = draftInput.safeParse(spec);
          if (!d.success) return refused(false, "the approved spec is not a newsletter draft");
          try {
            const r = await req<{ broadcast?: KitBroadcast }>(ctx.credential, "/broadcasts", "POST", {
              subject: d.data.title,
              ...(d.data.previewText && { preview_text: d.data.previewText }),
              content: d.data.html,
              description: `${DRAFTED}${ctx.idempotencyKey}`,
              public: false,
              send_at: null,
            });
            const id = r?.broadcast?.id;
            if (typeof id !== "number") throw new Error("Kit answered without a broadcast id");
            return { kind: "sent", providerRef: String(id), correlationKey: String(id) };
          } catch (e) {
            return refusal(e);
          }
        },
        reconcile: reconcileBy(DRAFTED, () => true),
      },

      "newsletter.send": {
        prepare: prepareWith(sendInput, "newsletter.send", (d) => `Send Kit broadcast ${d.issueId}${d.at ? ` at ${d.at}` : ""}`),
        async execute(spec, ctx) {
          const s = sendInput.safeParse(spec);
          if (!s.success || !/^\d{1,20}$/.test(s.data.issueId)) return refused(false, "the approved spec is not a Kit send");
          const mark = `send:${ctx.idempotencyKey}`;
          try {
            const b = await broadcast(ctx.credential, s.data.issueId);
            const desc = typeof b.description === "string" ? b.description : "";
            if (!desc.startsWith(DRAFTED)) return refused(false, "Direx didn't draft this broadcast, so it won't send it");
            // This Action already scheduled it: report that, never schedule it twice, whatever Kit now says.
            if (stamped(b, mark)) return { kind: "sent", providerRef: s.data.issueId, correlationKey: s.data.issueId };
            if (b.status !== "draft") return refused(false, `the broadcast is ${String(b.status)}, not a draft`);
            // A draft whose last stamp is a send was scheduled by Direx and then put back to draft
            // outside Direx, since Direx's own cancel leaves a cancel stamp. Whether it went out first
            // can't be told from Kit, so it is never sent again.
            const last = desc.split(" ").filter((t) => t.startsWith("send:") || t.startsWith("cancel:")).at(-1);
            if (last?.startsWith("send:")) return refused(false, "may have been sent: Direx scheduled this broadcast before, and it was put back to draft outside Direx");
            if (await hasGone(ctx.credential, s.data.issueId, b)) return refused(false, "already sent: Kit has sent this broadcast before");
            const at = s.data.at && Date.parse(s.data.at) > now() + cfg.sendDelayMs ? s.data.at : new Date(now() + cfg.sendDelayMs).toISOString();
            await put(ctx.credential, s.data.issueId, { send_at: at, description: `${desc} ${mark}` });
            return { kind: "sent", providerRef: s.data.issueId, correlationKey: s.data.issueId };
          } catch (e) {
            return refusal(e);
          }
        },
        // Only the schedule call writes the send stamp, so a stamp means it was scheduled.
        reconcile: reconcileBy("send:", () => true),
      },

      // One call: the broadcast is created already scheduled and stamped as drafted and sent by this Action.
      "newsletter.publish": {
        prepare: prepareWith(publishInput, "newsletter.publish", (d) => `Publish "${d.title}" to Kit${d.at ? ` at ${d.at}` : ""}`),
        async execute(spec, ctx) {
          const p = publishInput.safeParse(spec);
          if (!p.success) return refused(false, "the approved spec is not a newsletter issue");
          const at = p.data.at && Date.parse(p.data.at) > now() + cfg.sendDelayMs ? p.data.at : new Date(now() + cfg.sendDelayMs).toISOString();
          try {
            const r = await req<{ broadcast?: KitBroadcast }>(ctx.credential, "/broadcasts", "POST", {
              subject: p.data.title,
              ...(p.data.previewText && { preview_text: p.data.previewText }),
              content: p.data.html,
              description: `${DRAFTED}${ctx.idempotencyKey} send:${ctx.idempotencyKey}`,
              public: false,
              send_at: at,
            });
            const id = r?.broadcast?.id;
            if (typeof id !== "number") throw new Error("Kit answered without a broadcast id");
            return { kind: "sent", providerRef: String(id), correlationKey: String(id) };
          } catch (e) {
            return refusal(e);
          }
        },
        reconcile: reconcileBy("send:", () => true),
      },

      "newsletter.cancel": {
        prepare: prepareWith(cancelInput, "newsletter.cancel", (d) => `Cancel Kit broadcast ${d.issueId}`),
        async execute(spec, ctx) {
          const s = cancelInput.safeParse(spec);
          if (!s.success || !/^\d{1,20}$/.test(s.data.issueId)) return refused(false, "the approved spec is not a Kit cancel");
          try {
            const b = await broadcast(ctx.credential, s.data.issueId);
            const gone = refused(false, "already sent: Kit has started or finished sending this broadcast");
            if (b.status !== "draft" && b.status !== "scheduled") return gone;
            if (await hasGone(ctx.credential, s.data.issueId, b)) return gone;
            if (b.status === "draft") return { kind: "sent", providerRef: s.data.issueId };
            const desc = typeof b.description === "string" ? b.description : "";
            const r = await put(ctx.credential, s.data.issueId, { send_at: null, description: `${desc} cancel:${ctx.idempotencyKey}` });
            if (r?.broadcast?.status !== "draft") return refused(false, "already sent: Kit didn't return the broadcast to draft");
            return { kind: "sent", providerRef: s.data.issueId };
          } catch (e) {
            return refusal(e);
          }
        },
        reconcile: reconcileBy("cancel:", (b) => b.status === "draft"),
      },
    },
    queries: {
      "newsletter.subscribers": (input, ctx) => subscribers(input, ctx.credential),
      "newsletter.profile": (_input, ctx) => profile(ctx.credential),
      "newsletter.stats": (input, ctx) => stats(input, ctx.credential),
    },
  });
}
