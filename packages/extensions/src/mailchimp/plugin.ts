// SPDX-License-Identifier: AGPL-3.0-only
// Mailchimp's Marketing API 3.0: campaigns drafted and sent now to one list, a list's members in
// pages, the account's lists, and a campaign's report. Endpoints and field names are from Mailchimp's
// OpenAPI description, read 2026-11-20; nothing here has run against a real account yet.
// Mailchimp never sends one campaign twice, so the only duplicate to guard against is a second
// campaign: every write stamps the campaign's name, and a retry finds the campaign by that stamp.
import { definePlugin, PluginError, type Credential, type ExecuteResult, type ReconcileResult } from "@direx/plugin-sdk";
import { z } from "zod";
import { cancelInput, draftInput, listsOutput, profileOutput, publishInput, sendInput, statsOutput, subscribersInput, subscribersOutput, toSubscriberState, type SubscriberState } from "../newsletter/contract";
import { call, keyOf, NewsletterHttpError, type NewsletterHttp } from "../newsletter/http";
import { mailchimpManifest } from "./manifest";

export const MAILCHIMP_DEFAULTS = {
  timeoutMs: 20_000,
  /** Mailchimp's 429 is about concurrent calls and comes with no header saying how long to wait. */
  rateLimitWaitMs: 60_000,
  /** Mailchimp's maximum. */
  pageSize: 1000,
  /** How many pages of 100 recent campaigns a retry or reconcile reads looking for its stamp. */
  reconcilePages: 5,
};
export type MailchimpOptions = Partial<typeof MAILCHIMP_DEFAULTS> & { fetch?: typeof fetch; now?: () => number };

/** Mailchimp's member states. `pending`, `transactional`, `archived` and anything new stay "other". */
export const MAILCHIMP_STATES: Readonly<Record<string, SubscriberState>> = { subscribed: "subscribed", unsubscribed: "unsubscribed", cleaned: "bounced" };

/** The data center at the end of a key, such as "us21". It becomes the host, so nothing else is accepted. */
const DC = /-([a-z]{2,4}[0-9]{1,3})$/;
/** Campaign and list ids go into paths, so only plain ids are accepted. */
const ID = /^[a-z0-9]{1,40}$/;

/**
 * The campaign's name, which subscribers never see, carries the ledger Action's id: `direx:<id>` when
 * created, and `send:<id>` once that Action is to send it (from the start for a publish, just before
 * the send call for a send). A retry finds its campaign by that stamp, and a send refuses a campaign
 * Direx didn't create.
 */
const DRAFTED = "direx:";
type Campaign = { id?: unknown; status?: unknown; settings?: { title?: unknown; subject_line?: unknown; from_name?: unknown; reply_to?: unknown } };
const titleOf = (c: Campaign) => (typeof c.settings?.title === "string" ? c.settings.title : "");
const stamped = (c: Campaign, mark: string) => titleOf(c).split(" ").includes(mark);
const gone = (c: Campaign) => c.status === "sending" || c.status === "sent";

/** Mailchimp won't send without an unsubscribe link and the list's postal address, so one is added when missing. */
export const FOOTER = '<p style="font-size:12px;color:#666">*|LIST:ADDRESSLINE|*<br><a href="*|UNSUB|*">Unsubscribe</a></p>';
export const withFooter = (html: string) => (html.includes("*|UNSUB|*") ? html : /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${FOOTER}</body>`) : `${html}${FOOTER}`);

const issueInput = z.strictObject({ issueId: z.string().regex(ID) });
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);
const iso = (...v: unknown[]) => {
  for (const x of v) if (typeof x === "string" && Number.isFinite(Date.parse(x))) return new Date(x).toISOString();
  return null;
};

type List = { id?: unknown; name?: unknown; stats?: { member_count?: unknown }; campaign_defaults?: { from_name?: unknown; from_email?: unknown } };
type Member = { email_address?: unknown; status?: unknown; timestamp_opt?: unknown; timestamp_signup?: unknown; last_changed?: unknown };
type Checklist = { is_ready?: unknown; items?: { type?: unknown; heading?: unknown; details?: unknown }[] };

const refused = (retryable: boolean, detail: string): ExecuteResult => ({ kind: "refused", permanent: !retryable, retryable, detail });
/** A failed answer as a refusal. A dropped connection is not an answer, so it throws and the Dispatcher reconciles. */
function refusal(e: unknown): ExecuteResult {
  if (!(e instanceof NewsletterHttpError)) throw e;
  if (e.credentialRejected) return { kind: "refused", permanent: false, retryable: true, detail: e.message, credentialRejected: true };
  if (e.status === 429 || e.status >= 500) return refused(true, e.message);
  return refused(false, e.message);
}

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
  const campaign = async (c: Credential | null, id: string) => (await req<Campaign>(c, `/campaigns/${id}`)) ?? {};
  const allLists = async (c: Credential | null) => (await req<{ lists?: List[] }>(c, "/lists?count=1000"))?.lists ?? [];

  /** The newest of the recent campaigns carrying `mark`, or null. */
  async function findStamped(c: Credential | null, mark: string): Promise<Campaign | null> {
    for (let i = 0; i < cfg.reconcilePages; i++) {
      const q = new URLSearchParams({ count: "100", offset: String(i * 100), sort_field: "create_time", sort_dir: "DESC", fields: "campaigns.id,campaigns.status,campaigns.settings.title" });
      const page = (await req<{ campaigns?: Campaign[] }>(c, `/campaigns?${q}`))?.campaigns ?? [];
      const hit = page.find((x) => stamped(x, mark));
      if (hit) return hit;
      if (page.length < 100) return null;
    }
    return null;
  }

  /** Only ever confirms. A miss stays unknown, so a person decides rather than Direx sending twice. */
  const reconcileBy =
    (prefix: string, done: (x: Campaign) => boolean) =>
    async (_key: string, ctx: { idempotencyKey: string; credential: Credential | null }): Promise<ReconcileResult> => {
      try {
        const x = await findStamped(ctx.credential, `${prefix}${ctx.idempotencyKey}`);
        return x && done(x) ? { kind: "sent", providerRef: String(x.id) } : { kind: "unknown" };
      } catch {
        return { kind: "unknown" };
      }
    };

  /**
   * This Action's campaign, created if no campaign carries its stamp yet, with its content written
   * while it is still a draft. A retry after any failed step carries on with the same campaign.
   */
  async function ensureCampaign(c: Credential | null, d: z.infer<typeof draftInput>, listId: string, key: string, toSend: boolean): Promise<{ id: string; campaign: Campaign }> {
    let x = await findStamped(c, `${DRAFTED}${key}`);
    if (!x) {
      // The list's own sender name and address, which Mailchimp needs before it sends.
      const list = (await req<List>(c, `/lists/${listId}`)) ?? {};
      const from = list.campaign_defaults ?? {};
      x = await req<Campaign>(c, "/campaigns", "POST", {
        type: "regular",
        recipients: { list_id: listId },
        settings: {
          subject_line: d.title,
          ...(d.previewText && { preview_text: d.previewText }),
          title: `${d.title.slice(0, 80)} ${DRAFTED}${key}${toSend ? ` send:${key}` : ""}`,
          ...(typeof from.from_name === "string" && { from_name: from.from_name }),
          ...(typeof from.from_email === "string" && { reply_to: from.from_email }),
        },
      });
    }
    const id = typeof x?.id === "string" ? x.id : "";
    if (!ID.test(id)) throw new Error("Mailchimp answered without a campaign id");
    if (x.status === "save") await req(c, `/campaigns/${id}/content`, "PUT", { html: withFooter(d.html) });
    return { id, campaign: x };
  }

  /** Sends a draft campaign now, after Mailchimp's own checklist says it is ready. */
  async function sendNow(c: Credential | null, id: string, x: Campaign, key: string): Promise<ExecuteResult> {
    const mark = `send:${key}`;
    if (stamped(x, mark) && gone(x)) return { kind: "sent", providerRef: id, correlationKey: id };
    if (x.status !== "save") return refused(false, `the campaign is ${String(x.status)}, not a draft, so it is not sent again`);
    const check = (await req<Checklist>(c, `/campaigns/${id}/send-checklist`)) ?? {};
    if (check.is_ready !== true) {
      const item = check.items?.find((i) => i.type === "error") ?? check.items?.find((i) => i.type !== "success");
      const words = [item?.heading, item?.details].filter((w) => typeof w === "string" && w).join(": ");
      return refused(false, `Mailchimp says the campaign isn't ready to send${words ? `: ${words}` : ""}`);
    }
    if (!stamped(x, mark)) {
      // The campaign's own subject and sender go back with the new name, in case Mailchimp wants them on every change.
      const { subject_line, from_name, reply_to } = x.settings ?? {};
      await req(c, `/campaigns/${id}`, "PATCH", { settings: { subject_line, from_name, reply_to, title: `${titleOf(x)} ${mark}` } });
    }
    // A campaign that already went is refused by Mailchimp, so a repeated call can't send it twice.
    await req(c, `/campaigns/${id}/actions/send`, "POST");
    return { kind: "sent", providerRef: id, correlationKey: id };
  }

  const prepareWith = <T extends z.ZodType>(schema: T, name: string, preview: (d: z.infer<T>) => string) => async (input: unknown) => {
    const p = schema.safeParse(input);
    if (!p.success) throw new Error(`${name}: ${p.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}`);
    return { spec: p.data, preview: preview(p.data) };
  };
  const listOfSpec = (listId: string | undefined) => (listId && ID.test(listId) ? listId : null);
  const NO_LIST = "the approved spec names no Mailchimp list, so it is not sent";
  const TOO_EARLY = "Direx sends a Mailchimp campaign at its time, never schedules it inside Mailchimp";

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
    const members = page?.members ?? [];
    const rows = members.flatMap((m) => {
      const createdAt = iso(m.timestamp_opt, m.timestamp_signup, m.last_changed);
      const updatedAt = iso(m.last_changed);
      return typeof m.email_address === "string" && createdAt
        ? [{ email: m.email_address.toLowerCase(), state: toSubscriberState(typeof m.status === "string" ? m.status : "", MAILCHIMP_STATES), createdAt, ...(updatedAt && { updatedAt }) }]
        : [];
    });
    const next = offset + members.length;
    return subscribersOutput.parse({ subscribers: rows, nextCursor: members.length && next < n(page?.total_items) ? String(next) : null });
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
    effects: {
      "newsletter.draft": {
        prepare: prepareWith(draftInput, "newsletter.draft", (d) => `Draft "${d.title}" in Mailchimp`),
        async execute(spec, ctx) {
          const d = draftInput.safeParse(spec);
          if (!d.success) return refused(false, "the approved spec is not a newsletter draft");
          const listId = listOfSpec(d.data.listId);
          if (!listId) return refused(false, NO_LIST);
          try {
            const { id } = await ensureCampaign(ctx.credential, d.data, listId, ctx.idempotencyKey, false);
            return { kind: "sent", providerRef: id, correlationKey: id };
          } catch (e) {
            return refusal(e);
          }
        },
        reconcile: reconcileBy(DRAFTED, () => true),
      },

      "newsletter.send": {
        prepare: prepareWith(sendInput, "newsletter.send", (d) => `Send Mailchimp campaign ${d.issueId} now`),
        async execute(spec, ctx) {
          const s = sendInput.safeParse(spec);
          if (!s.success || !ID.test(s.data.issueId)) return refused(false, "the approved spec is not a Mailchimp send");
          if (s.data.at && Date.parse(s.data.at) > now() + 60_000) return refused(false, TOO_EARLY);
          try {
            const x = await campaign(ctx.credential, s.data.issueId);
            if (!titleOf(x).split(" ").some((t) => t.startsWith(DRAFTED))) return refused(false, "Direx didn't create this campaign, so it won't send it");
            return await sendNow(ctx.credential, s.data.issueId, x, ctx.idempotencyKey);
          } catch (e) {
            return refusal(e);
          }
        },
        reconcile: reconcileBy("send:", gone),
      },

      // Create, write and send, resuming from whatever step a retry finds the campaign at.
      "newsletter.publish": {
        prepare: prepareWith(publishInput, "newsletter.publish", (d) => `Publish "${d.title}" to Mailchimp now`),
        async execute(spec, ctx) {
          const p = publishInput.safeParse(spec);
          if (!p.success) return refused(false, "the approved spec is not a newsletter issue");
          if (p.data.at && Date.parse(p.data.at) > now() + 60_000) return refused(false, TOO_EARLY);
          const listId = listOfSpec(p.data.listId);
          if (!listId) return refused(false, NO_LIST);
          try {
            const { id, campaign: x } = await ensureCampaign(ctx.credential, p.data, listId, ctx.idempotencyKey, true);
            return await sendNow(ctx.credential, id, x, ctx.idempotencyKey);
          } catch (e) {
            return refusal(e);
          }
        },
        reconcile: reconcileBy("send:", gone),
      },

      // Direx never schedules inside Mailchimp, so a cancel finds a draft. One scheduled by hand is unscheduled.
      "newsletter.cancel": {
        prepare: prepareWith(cancelInput, "newsletter.cancel", (d) => `Cancel Mailchimp campaign ${d.issueId}`),
        async execute(spec, ctx) {
          const s = cancelInput.safeParse(spec);
          if (!s.success || !ID.test(s.data.issueId)) return refused(false, "the approved spec is not a Mailchimp cancel");
          try {
            const x = await campaign(ctx.credential, s.data.issueId);
            if (x.status === "schedule") await req(ctx.credential, `/campaigns/${s.data.issueId}/actions/unschedule`, "POST");
            else if (x.status !== "save") return refused(false, gone(x) ? "already sent: Mailchimp has started or finished sending this campaign" : `the campaign is ${String(x.status)}`);
            return { kind: "sent", providerRef: s.data.issueId };
          } catch (e) {
            return refusal(e);
          }
        },
        // A campaign back in draft is cancelled, whoever put it there.
        async reconcile(_key, ctx, spec) {
          const s = cancelInput.safeParse(spec);
          if (!s.success || !ID.test(s.data.issueId)) return { kind: "unknown" };
          try {
            return (await campaign(ctx.credential, s.data.issueId)).status === "save" ? { kind: "sent", providerRef: s.data.issueId } : { kind: "unknown" };
          } catch {
            return { kind: "unknown" };
          }
        },
      },
    },
    queries: {
      "newsletter.subscribers": (input, ctx) => subscribers(input, ctx.credential),
      "newsletter.profile": (input, ctx) => profile(input, ctx.credential),
      "newsletter.stats": (input, ctx) => stats(input, ctx.credential),
      "newsletter.lists": (_input, ctx) => lists(ctx.credential),
    },
  });
}
