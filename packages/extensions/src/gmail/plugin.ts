// SPDX-License-Identifier: AGPL-3.0-only
// The Gmail plugin: send an approved message, confirm a send whose outcome was cut
// off, read replies, say which mailbox is connected, send and read back a probe, send
// the reply that joins the Placement circle, send Placement checks, and read and
// archive the checks other members send, by labels and Message-ID only.
import { accessToken, definePlugin, skipMail, type CallContext, type EffectHandler, type ExecuteResult, type QueryOutput, type ReconcileResult, PluginError } from "@direx/plugin-sdk";
import { simpleParser } from "mailparser";
import { z } from "zod";
import { GMAIL_API, gmailClient, headerOf, type GmailClient } from "./client";
import { messagesFrom, pollMailbox } from "./history";
import { gmailManifest } from "./manifest";
import { encodeRaw, gmailSpec, prepareMessage } from "./mime";
import { archiveCheck, archiveSpec, readCheck } from "./placement";
import { pollSent } from "./sent";

export type GmailPluginOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per request; under the host's 25 s call timeout. */
  timeoutMs?: number;
  now?: () => number;
};

/** How many of the newest sent messages reconcile checks for our headers. */
export const SENT_SCAN = 25;

const NOT_CONNECTED = "mailbox not connected";
// Goes into a Gmail search, so nothing that could widen the search gets through.
const SEARCHABLE_EMAIL = /^[^\s"():{}]+@[^\s"():{}]+$/;

/**
 * Looks for the message an Action sent by our X-Direx-Action header among the newest
 * sent mail. It does not use Gmail's search, which can lag and cannot match a custom
 * header. Returns the Gmail id, or null when it is not among them.
 */
async function findSent(client: GmailClient, token: string, actionId: string): Promise<string | null> {
  const recent = await client.list(token, { labelIds: "SENT", maxResults: SENT_SCAN });
  for (const stub of recent?.messages ?? []) {
    const m = await client.message(token, stub.id, "metadata", ["X-Direx-Action"]);
    if (m && headerOf(m, "X-Direx-Action") === actionId) return m.id;
  }
  return null;
}

/** How many search hits probe_read checks for our header. */
export const PROBE_SCAN = 10;
export const PROBE_HEADER_BYTES = 64 * 1024;
export const PROBE_TEXT_CHARS = 20_000;

const probeReadInput = z.strictObject({
  actionId: z.string().regex(/^[0-9a-zA-Z-]+$/, "a plain token"),
  subject: z.string().min(1).max(998),
});

export type ProbeRead = QueryOutput<"mailbox.probe_read">;

/**
 * Finds the probe an Action sent where it was delivered: INBOX or SPAM. The sender's copy, labelled
 * only SENT, never counts. Gmail's search cannot match a custom header, so this searches by subject
 * and confirms X-Direx-Action in the raw message. A get never marks mail read, and nothing here
 * changes a label.
 */
async function readProbe(client: GmailClient, token: string, actionId: string, subject: string): Promise<ProbeRead> {
  // Quotes, backslashes and grouping characters would end or widen the search.
  const q = `in:anywhere {in:inbox in:spam} subject:"${subject.replace(/["\\{}()]/g, " ")}"`;
  const hits = await client.list(token, { q, includeSpamTrash: true, maxResults: PROBE_SCAN });
  for (const stub of hits?.messages ?? []) {
    const m = await client.message(token, stub.id, "raw");
    const folder = m?.labelIds?.includes("SPAM") ? "junk" : m?.labelIds?.includes("INBOX") ? "inbox" : null;
    if (!m?.raw || !folder) continue;
    const bytes = Buffer.from(m.raw, "base64url");
    const parsed = await simpleParser(bytes);
    if (String(parsed.headers.get("x-direx-action") ?? "").trim() !== actionId) continue;
    const blank = /\r?\n\r?\n/.exec(bytes.toString("latin1"));
    const headers = bytes.subarray(0, Math.min(blank?.index ?? bytes.length, PROBE_HEADER_BYTES)).toString("utf8");
    const html = typeof parsed.html === "string" ? parsed.html.slice(0, PROBE_TEXT_CHARS) : null;
    return { found: true, folder, headers, text: (parsed.text ?? "").slice(0, PROBE_TEXT_CHARS), html };
  }
  return { found: false };
}

export function createGmailPlugin(opts: GmailPluginOptions = {}) {
  const base = { baseUrl: opts.baseUrl ?? GMAIL_API, fetch: opts.fetch ?? fetch };
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const client = gmailClient({ ...base, timeoutMs });
  // The send and the Message-ID read together stay under one call's deadline, so a slow read
  // can't turn a confirmed send into an unknown one.
  const afterSend = gmailClient({ ...base, timeoutMs: Math.ceil(timeoutMs / 5) });
  const now = opts.now ?? Date.now;

  /** Sends an approved message; a placement message leaves out X-Direx-Action. */
  async function sendRaw(spec: unknown, ctx: CallContext, header: { actionHeader?: boolean } = {}): Promise<ExecuteResult> {
    const token = accessToken(ctx.credential);
    if (!token) return { kind: "refused", permanent: false, retryable: false, detail: NOT_CONNECTED };
    const msg = gmailSpec.safeParse(spec);
    if (!msg.success) return { kind: "refused", permanent: true, retryable: false, detail: "the approved spec is not a Gmail message" };
    // Throws when the outcome is unknown; the Dispatcher then holds the Action and reconciles.
    const r = await client.send(token, encodeRaw(msg.data, ctx.idempotencyKey, header), msg.data.threadId);
    if (!r.ok) return { kind: "refused", permanent: r.permanent, retryable: r.retryable, detail: r.detail, ...(r.providerLimit ? { providerLimit: r.providerLimit } : {}) };
    // The Message-ID Gmail assigned, so replies can be matched to this send.
    let messageId: string | undefined;
    try {
      messageId = headerOf(await afterSend.message(token, r.id, "metadata", ["Message-ID"]), "Message-ID");
    } catch {
      // The send already happened; without the id, replies match by thread instead.
    }
    return { kind: "sent", providerRef: r.id, ...(messageId ? { correlationKey: messageId } : {}) };
  }

  // The probe is sent exactly as an email is, so it shows what an email from this Mailbox carries.
  const send: EffectHandler = {
    prepare: async (input) => prepareMessage(input),
    execute: (spec, ctx) => sendRaw(spec, ctx),

    // Only ever confirms a send. "Not found" is never "not sent": Gmail's search can
    // lag, so a miss leaves the outcome unknown and a person decides in the end.
    async reconcile(_correlationKey, ctx): Promise<ReconcileResult> {
      const token = accessToken(ctx.credential);
      if (!token) return { kind: "unknown" };
      try {
        const id = await findSent(client, token, ctx.idempotencyKey);
        return id ? { kind: "sent", providerRef: id } : { kind: "unknown" };
      } catch {
        return { kind: "unknown" };
      }
    },
  };

  // Placement mail carries no X-Direx-Action; Gmail's Message-ID, read back after the send, is its key.
  const placementMail: EffectHandler = { prepare: send.prepare, execute: (spec, ctx) => sendRaw(spec, ctx, { actionHeader: false }) };

  return definePlugin({
    manifest: gmailManifest,
    // Blind, so no reconcile: an uncertain join waits for a person, who can ask the signer for new codes,
    // and an uncertain Placement check for a person to say whether it went.
    effects: {
      "email.send": send,
      "mailbox.probe": send,
      "placement.join": placementMail,
      "placement.send": placementMail,
      "placement.report": placementMail,
      // Blind too: an uncertain archive is left as it is, never retried.
      "placement.archive": {
        prepare: async (input) => {
          const spec = archiveSpec.parse(input);
          return { spec, preview: `Archive the Placement check ${spec.messageId}` };
        },
        execute: async (spec, ctx) => {
          const token = accessToken(ctx.credential);
          if (!token) return { kind: "refused", permanent: false, retryable: false, detail: NOT_CONNECTED };
          return archiveCheck(client, token, spec);
        },
      },
    },
    queries: {
      "placement.read": async (input, ctx) => {
        const token = accessToken(ctx.credential);
        if (!token) throw new PluginError("not_connected", NOT_CONNECTED);
        const r = skipMail.safeParse(input);
        if (!r.success) throw new Error("placement.read needs a sender, subject text and window");
        return readCheck(client, token, r.data);
      },
      "mailbox.probe_read": async (input, ctx) => {
        const token = accessToken(ctx.credential);
        if (!token) throw new PluginError("not_connected", NOT_CONNECTED);
        const r = probeReadInput.safeParse(input);
        if (!r.success) throw new Error("mailbox.probe_read needs an actionId and the probe's subject");
        return readProbe(client, token, r.data.actionId, r.data.subject);
      },
      "mail.from": async (input, ctx): Promise<QueryOutput<"mail.from">> => {
        const token = accessToken(ctx.credential);
        if (!token) throw new PluginError("not_connected", NOT_CONNECTED);
        const email = (input as { email?: unknown } | null)?.email;
        if (typeof email !== "string" || !SEARCHABLE_EMAIL.test(email)) throw new Error("mail.from needs one email address");
        const skip = skipMail.array().safeParse((input as { skip?: unknown }).skip ?? []);
        if (!skip.success) throw new Error("mail.from's skip list is not mail to skip");
        return { events: await messagesFrom(client, token, email, skip.data, now()) };
      },
      "mailbox.profile": async (_input, ctx): Promise<QueryOutput<"mailbox.profile">> => {
        const token = accessToken(ctx.credential);
        if (!token) throw new PluginError("not_connected", NOT_CONNECTED);
        const p = await client.profile(token);
        // An answer without the account's address is not a profile (the catalogue entry requires one).
        if (!p?.emailAddress) throw new PluginError("provider_error", "Gmail gave no address for this account");
        return { emailAddress: p.emailAddress };
      },
    },
    triggers: {
      "email.received": {
        poll: async (cursor, ctx) => {
          const token = accessToken(ctx.credential);
          if (!token) throw new PluginError("not_connected", NOT_CONNECTED);
          return pollMailbox(client, token, cursor, now(), ctx.skip);
        },
      },
      "mail.sent": {
        poll: async (cursor, ctx) => {
          const token = accessToken(ctx.credential);
          if (!token) throw new PluginError("not_connected", NOT_CONNECTED);
          return pollSent(client, token, cursor, now());
        },
      },
    },
  });
}
