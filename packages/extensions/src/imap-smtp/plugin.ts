// SPDX-License-Identifier: AGPL-3.0-only
// A mailbox over SMTP and IMAP: send an approved message, confirm a send whose outcome was cut off,
// read replies, read back a probe the Mailbox sent itself, and check the connection.
import { definePlugin, type EffectHandler, type ExecuteResult, type QueryOutput, type ReconcileResult, PluginError } from "@direx/plugin-sdk";
import { addressOf, mailInput, mailSpec, prepareWith, rfc5322 } from "../mail/message";
import { connectionOf, type ConnectOptions } from "./connection";
import { checkImap, findProbe, findSent, messagesFrom, pollInbox } from "./imap";
import { imapSmtpManifest } from "./manifest";
import { checkSmtp, sendRaw } from "./smtp";

export type ImapSmtpOptions = {
  /** Per step; under the host's 25 s call timeout. */
  timeoutMs?: number;
  now?: () => number;
  /** Messages read per poll. */
  pollLimit?: number;
  /** Set only by tests; a credential can't reach these. */
  test?: ConnectOptions["test"];
};

const NOT_CONNECTED = "mailbox not connected";
const POLL_LIMIT = 100;
const SEARCHABLE_EMAIL = /^[^\s"():{}]+@[^\s"():{}]+$/;

export function createImapSmtpPlugin(opts: ImapSmtpOptions = {}) {
  const connect: ConnectOptions = { timeoutMs: opts.timeoutMs ?? 20_000, ...(opts.test ? { test: opts.test } : {}) };
  const now = opts.now ?? Date.now;
  const pollLimit = opts.pollLimit ?? POLL_LIMIT;

  const emailSend: EffectHandler = {
    prepare: async (input) => prepareWith(mailInput, input),

    async execute(spec, ctx): Promise<ExecuteResult> {
      const c = connectionOf(ctx.credential);
      if (!c) return { kind: "refused", permanent: false, retryable: false, detail: NOT_CONNECTED };
      const msg = mailSpec.safeParse(spec);
      if (!msg.success) return { kind: "refused", permanent: true, retryable: false, detail: "the approved spec is not an email" };
      const domain = c.fromAddress.split("@")[1];
      const messageId = `<${ctx.idempotencyKey}@${domain}>`;
      const from = c.fromName ? { name: c.fromName, address: c.fromAddress } : c.fromAddress;
      const raw = rfc5322(msg.data, ctx.idempotencyKey, { from, date: new Date(now()), messageId });
      const to = [...msg.data.to, ...(msg.data.cc ?? [])].map(addressOf);
      // Throws when the outcome is unknown; the Dispatcher then holds the Action and reconciles.
      const r = await sendRaw(c, connect, { from: c.fromAddress, to }, raw);
      if (!r.ok) return { kind: "refused", permanent: r.permanent, retryable: r.retryable, detail: r.detail, ...(r.providerLimit ? { providerLimit: r.providerLimit } : {}) };
      return { kind: "sent", providerRef: messageId, correlationKey: messageId };
    },

    // Only ever confirms a send. "Not found" is never "not sent": a server may keep no Sent
    // copy, so a miss leaves the outcome unknown and a person decides in the end.
    async reconcile(_correlationKey, ctx): Promise<ReconcileResult> {
      const c = connectionOf(ctx.credential);
      if (!c) return { kind: "unknown" };
      try {
        const ref = await findSent(c, connect, ctx.idempotencyKey);
        return ref ? { kind: "sent", providerRef: ref } : { kind: "unknown" };
      } catch {
        return { kind: "unknown" };
      }
    },
  };

  return definePlugin({
    manifest: imapSmtpManifest,
    effects: {
      "email.send": emailSend,
      // The Mailbox writing to itself on connect, to see what its provider does to our headers.
      "mailbox.probe": emailSend,
    },
    queries: {
      "mailbox.probe_read": async (input, ctx) => {
        const c = connectionOf(ctx.credential);
        if (!c) throw new PluginError("not_connected", NOT_CONNECTED);
        const actionId = (input as { actionId?: unknown } | null)?.actionId;
        if (typeof actionId !== "string" || !/^[0-9a-zA-Z-]{1,200}$/.test(actionId)) throw new Error("mailbox.probe_read needs an Action id");
        const subject = (input as { subject?: unknown }).subject;
        if (subject !== undefined && subject !== null && (typeof subject !== "string" || subject.length > 998 || /[\r\n]/.test(subject))) throw new Error("mailbox.probe_read: the subject must be one line");
        return findProbe(c, connect, actionId, typeof subject === "string" ? subject : undefined);
      },
      "mail.from": async (input, ctx): Promise<QueryOutput<"mail.from">> => {
        const c = connectionOf(ctx.credential);
        if (!c) throw new PluginError("not_connected", NOT_CONNECTED);
        const email = (input as { email?: unknown } | null)?.email;
        if (typeof email !== "string" || !SEARCHABLE_EMAIL.test(email)) throw new Error("mail.from needs one email address");
        return { events: await messagesFrom(c, connect, email, now(), pollLimit) };
      },
      // Signs in to both servers, so a form can test a connection before keeping it.
      "mailbox.profile": async (_input, ctx): Promise<QueryOutput<"mailbox.profile">> => {
        const c = connectionOf(ctx.credential);
        if (!c) throw new PluginError("not_connected", NOT_CONNECTED);
        await checkSmtp(c, connect);
        const { hasSent } = await checkImap(c, connect);
        return { emailAddress: c.fromAddress, hasSent };
      },
    },
    triggers: {
      "email.received": {
        poll: async (cursor, ctx) => {
          const c = connectionOf(ctx.credential);
          if (!c) throw new PluginError("not_connected", NOT_CONNECTED);
          return pollInbox(c, connect, cursor, now(), pollLimit);
        },
      },
    },
  });
}
