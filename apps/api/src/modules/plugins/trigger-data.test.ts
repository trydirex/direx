// SPDX-License-Identifier: AGPL-3.0-only
// The host parses each mail trigger's event data through its SDK catalogue entry before onEvent
// (ADR 0028 rule 001). A real event from each first-party plugin's fake reaches onEvent typed; one
// malformed event refuses its whole batch, logged by trigger and event id only, and the cursor
// stays where it was, so the next poll brings the batch again.
import { createGmailPlugin, createImapSmtpPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { definePlugin, type Credential, type Plugin, type TriggerEvent as PluginEvent } from "@direx/plugin-sdk";
import nodemailer from "nodemailer";
import { afterAll, expect, test, vi } from "vitest";
import { inWorkspace, lastPollAt } from "./adapters/trigger-repo";
import { loadPlugins, receivedMail, type TriggerEvent } from "./index";

vi.setConfig({ testTimeout: 30_000 });
const HOST = "127.0.0.1";
const gmail = startFakeGmail();
const seeder = nodemailer.createTransport({ host: HOST, port: 3465, secure: true, auth: { user: "alice@example.com", pass: "secret" }, tls: { rejectUnauthorized: false } });
afterAll(() => {
  gmail.stop();
  seeder.close();
});

/** The plugin with its poll of `trigger` spoiled on demand: one of its real events gets a field no entry has. */
function spoilable(real: Plugin, trigger: string) {
  const state = { spoil: false };
  const poll = real.triggers[trigger]!.poll!;
  const plugin = definePlugin({
    ...real,
    triggers: {
      ...real.triggers,
      [trigger]: {
        poll: async (cursor, ctx) => {
          const r = await poll(cursor, ctx);
          const bad: PluginEvent[] = state.spoil ? r.events.map((e) => ({ eventId: `bad-${e.eventId}`, data: { ...(e.data as object), secretWord: "pineapple" } })) : [];
          return { events: [...r.events, ...bad], cursor: r.cursor };
        },
      },
    },
  });
  return { plugin, state };
}

const imapBox = `u${crypto.randomUUID()}@example.com`;
const sentAt = Date.now() - 3_600_000;
const imapPlugin = createImapSmtpPlugin({ timeoutMs: 5000, test: { untrustedCerts: true, implicitTlsPort: 3465 } });
const imapCredential: Credential = { username: imapBox, password: imapBox, settings: { fromAddress: imapBox, smtpHost: HOST, smtpPort: "3465", imapHost: HOST, imapPort: "3993" } };

const CASES: {
  name: string;
  pluginId: string;
  trigger: string;
  plugin: Plugin;
  credential: Credential;
  /** Puts one real message in the provider's fake. */
  seed: () => Promise<unknown>;
  /** What core reads of the real event. */
  read: (e: TriggerEvent) => unknown;
  expected: unknown;
}[] = [
  {
    name: "Gmail email.received",
    pluginId: "com.trydirex.gmail",
    trigger: "email.received",
    plugin: createGmailPlugin({ baseUrl: gmail.url, timeoutMs: 1000 }),
    credential: { accessToken: gmail.token, expiresAt: "" },
    seed: async () => gmail.deliver({ from: "Kim <kim@example.org>", subject: "Re: Hello", text: "Please remove me", labelIds: ["INBOX"], at: sentAt }),
    read: (e) => (!e.custom && e.trigger === "email.received" ? { from: e.data.headers.from, subject: e.data.headers.subject, text: e.data.text } : null),
    expected: { from: "Kim <kim@example.org>", subject: "Re: Hello", text: "Please remove me" },
  },
  {
    name: "Gmail mail.sent",
    pluginId: "com.trydirex.gmail",
    trigger: "mail.sent",
    plugin: createGmailPlugin({ baseUrl: gmail.url, timeoutMs: 1000 }),
    credential: { accessToken: gmail.token, expiresAt: "" },
    seed: async () => gmail.sentMail({ to: "Lee <lee@example.org>", at: sentAt }),
    read: (e) => (!e.custom && e.trigger === "mail.sent" ? { recipients: e.data.recipients, xDirexAction: e.data.xDirexAction } : null),
    expected: { recipients: ["lee@example.org"], xDirexAction: null },
  },
  {
    name: "IMAP email.received",
    pluginId: "com.trydirex.imap-smtp",
    trigger: "email.received",
    plugin: imapPlugin,
    credential: imapCredential,
    seed: async () => {
      await seeder.sendMail({
        envelope: { from: "alice@example.com", to: [imapBox] },
        raw: [`From: Kim <kim@example.org>`, `To: ${imapBox}`, "Subject: Re: Hello", `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@example.org>`, "In-Reply-To: <a@b>", "", "Please remove me"].join("\r\n"),
      });
      // Delivery is asynchronous: wait until the plugin itself can read the message.
      const read = imapPlugin.triggers["email.received"]!.poll!;
      for (let i = 0; i < 80; i++) {
        if ((await read(null, { workspaceId: "w", credential: imapCredential, log: () => {} })).events.length) return;
        await Bun.sleep(100);
      }
      throw new Error("the message never arrived");
    },
    read: (e) => (!e.custom && e.trigger === "email.received" ? { from: e.data.headers.from, subject: e.data.headers.subject, inReplyTo: e.data.headers.inReplyTo } : null),
    expected: { from: "\"Kim\" <kim@example.org>", subject: "Re: Hello", inReplyTo: "<a@b>" },
  },
];

test.each(CASES)("$name: a malformed event refuses its batch and keeps the cursor; the real one reaches onEvent typed", async (c) => {
  const W = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const { plugin, state } = spoilable(c.plugin, c.trigger);
  const handed: TriggerEvent[] = [];
  const logs: string[] = [];
  const host = loadPlugins({
    sources: [{ mode: "in_process", plugin }],
    credentials: async () => c.credential,
    confinement: "none",
    log: (l) => logs.push(l),
    onEvent: async (_tx, e) => void handed.push(e),
  });
  await c.seed();
  const run = () => host.runPoll({ workspaceId: W, pluginId: c.pluginId, trigger: c.trigger, credentialId });
  const key = { workspaceId: W, pluginId: c.pluginId, trigger: c.trigger, credentialId };

  state.spoil = true;
  expect(await run()).toBe("failed");
  expect(handed).toEqual([]);
  expect(await inWorkspace(W, (tx) => lastPollAt(tx, key))).toBeNull();
  expect(logs).toEqual([expect.stringMatching(new RegExp(`^plugin ${c.pluginId}: poll ${c.trigger} failed: ${c.trigger} events bad-\\S+ do not fit the catalogue entry$`))]);
  expect(logs.join("\n")).not.toContain("pineapple");

  state.spoil = false;
  expect(await run()).toBe("handed_off");
  expect(handed).toHaveLength(1);
  expect(handed[0]!.custom).toBeUndefined();
  expect(c.read(handed[0]!)).toEqual(c.expected);
  expect(await inWorkspace(W, (tx) => lastPollAt(tx, key))).not.toBeNull();
});

test("a webhook whose events don't fit their entry hands none off; one that fits is typed", async () => {
  const W = crypto.randomUUID();
  const handed: TriggerEvent[] = [];
  const plugin = definePlugin({
    manifest: {
      id: "com.example.sentmail",
      apiVersion: 1,
      version: "1.0.0",
      minHostVersion: "0.1.0",
      trust: "first_party",
      connections: [{ key: "svc", auth: "api_key" }],
      egress: { hosts: [] },
      capabilities: [{ kind: "trigger", name: "mail.sent", connection: "svc", source: "webhook", signature: { scheme: "hmac_sha256", header: "x-signature" } }],
    },
    triggers: { "mail.sent": { normalize: async (payload) => (payload as { events: PluginEvent[] }).events } },
  });
  const host = loadPlugins({ sources: [{ mode: "in_process", plugin }], credentials: async () => null, confinement: "none", verifyWebhook: async () => true, onEvent: async (_tx, e) => void handed.push(e) });
  const data = { messageId: "<m@x>", recipients: ["kim@example.org"], sentAt, xDirexAction: null, listUnsubscribe: null, precedence: null };
  const deliver = (events: unknown[]) =>
    host.ingestWebhook({ workspaceId: W, pluginId: "com.example.sentmail", trigger: "mail.sent", headers: { "x-signature": "a".repeat(64) }, rawBody: new TextEncoder().encode(JSON.stringify({ events })) });
  await expect(deliver([{ eventId: "ok", data }, { eventId: "no", data: { ...data, recipients: "kim@example.org" } }])).rejects.toThrow("mail.sent events no do not fit the catalogue entry");
  expect(handed).toEqual([]);
  expect(await deliver([{ eventId: "ok", data }])).toEqual({ ok: true, accepted: 1 });
  expect(handed).toEqual([{ workspaceId: W, pluginId: "com.example.sentmail", trigger: "mail.sent", credentialId: null, eventId: "ok", data }]);
});

test("mail a search found is parsed as received mail; any that doesn't fit fails the search, naming only its id", () => {
  const data = { headers: { from: "a@b", subject: "s", date: "", inReplyTo: "", references: "" }, text: "t" };
  expect(receivedMail([{ eventId: "1", data, workspaceId: "w" }])).toEqual([{ eventId: "1", data, workspaceId: "w" }]);
  expect(() => receivedMail([{ eventId: "1", data }, { eventId: "2", data: { ...data, text: undefined } }])).toThrow(/^email\.received events 2 do not fit the catalogue entry$/);
});
