// SPDX-License-Identifier: AGPL-3.0-only
// The plugin against GreenMail, a real SMTP and IMAP server, and a scripted SMTP server for the
// failures a real one won't produce on demand. Each test gets its own new mailbox: GreenMail makes
// one for any unknown recipient, with the address as its password.
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { afterAll, expect, test, vi } from "vitest";
import { startFakeSmtp } from "./fake-smtp";
import { imapSmtpManifest } from "./manifest";
import { createImapSmtpPlugin } from "./plugin";

vi.setConfig({ testTimeout: 30_000 });
const HOST = "127.0.0.1";
const untrusted = { untrustedCerts: true, implicitTlsPort: 3465 };
const plugin = createImapSmtpPlugin({ timeoutMs: 5000, test: untrusted });
const smtp = nodemailer.createTransport({ host: HOST, port: 3465, secure: true, auth: { user: "alice@example.com", pass: "secret" }, tls: { rejectUnauthorized: false } });
const fake = await startFakeSmtp();
afterAll(() => {
  smtp.close();
  fake.stop();
});

const ctx = { workspaceId: "w", log: () => {} };
type Box = { email: string; credential: { username: string; password: string; settings: Record<string, string> } };
const send = plugin.effects["email.send"]!;

const raw = (a: { from: string; to: string; subject?: string; messageId?: string; extra?: string[]; body?: string }) =>
  [
    `From: ${a.from}`,
    `To: ${a.to}`,
    `Subject: ${a.subject ?? "Hello"}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${a.messageId ?? `<${crypto.randomUUID()}@example.org>`}`,
    ...(a.extra ?? []),
    "Content-Type: text/plain; charset=UTF-8",
    "",
    a.body ?? "Hi there",
  ].join("\r\n");
const deliver = (to: string, message: string) => smtp.sendMail({ envelope: { from: "alice@example.com", to: [to] }, raw: message });

function imapClient(b: Box) {
  const c = new ImapFlow({ host: HOST, port: 3993, secure: true, auth: { user: b.email, pass: b.email }, logger: false, tls: { rejectUnauthorized: false } });
  c.on("error", () => {});
  return c;
}
async function withBox<T>(b: Box, use: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = imapClient(b);
  await c.connect();
  try {
    return await use(c);
  } finally {
    await c.logout();
  }
}
async function inboxCount(b: Box) {
  return withBox(b, async (c) => {
    const s = await c.status("INBOX", { messages: true });
    return (s && s.messages) || 0;
  });
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error("timed out");
}
/** A new mailbox holding one message, so it exists. */
async function newBox(over: Record<string, string> = {}): Promise<Box> {
  const email = `u${crypto.randomUUID()}@example.com`;
  const box: Box = { email, credential: { username: email, password: email, settings: { smtpHost: HOST, smtpPort: "3465", imapHost: HOST, imapPort: "3993", fromAddress: email, ...over } } };
  await deliver(email, raw({ from: "seed@example.org", to: email, subject: "Seed" }));
  for (let i = 0; i < 50; i++) {
    const n = await inboxCount(box).catch(() => 0);
    if (n > 0) return box;
    await Bun.sleep(100);
  }
  throw new Error("the mailbox never appeared");
}
const deliverAndWait = async (b: Box, message: string) => {
  const before = await inboxCount(b);
  await deliver(b.email, message);
  await until(async () => (await inboxCount(b)) > before);
};
const prepared = async (input: object = {}) => (await send.prepare({ to: ["kim@example.org"], subject: "Quick question", text: "Hi Kim", ...input }, ctx)).spec;
const exec = (spec: unknown, b: { credential: unknown }, id: string = crypto.randomUUID(), p = plugin) =>
  p.effects["email.send"]!.execute(spec, { ...ctx, idempotencyKey: id, credential: b.credential as never });
const reconcile = (b: { credential: unknown }, id: string) => send.reconcile!("", { ...ctx, idempotencyKey: id, credential: b.credential as never });
const poll = (b: Box, cursor: string | null, p = plugin) => p.triggers["email.received"]!.poll!(cursor, { ...ctx, credential: b.credential as never });
const subjects = (events: { data: unknown }[]) => events.map((e) => (e.data as { headers: { subject: string } }).headers.subject);

const plainPlugin = createImapSmtpPlugin({ timeoutMs: 400, test: { untrustedCerts: true, plainSmtp: true } });
const faked = (imap: Box) => ({ credential: { ...imap.credential, settings: { ...imap.credential.settings, smtpPort: String(fake.port) } } });
const reset = () => {
  for (const k of Object.keys(fake.script)) delete fake.script[k as keyof typeof fake.script];
};

test("the manifest has the six capabilities and no others", () => {
  expect(imapSmtpManifest.capabilities.map((c) => c.name).sort()).toEqual(["email.received", "email.send", "mail.from", "mailbox.probe", "mailbox.probe_read", "mailbox.profile"]);
  expect(imapSmtpManifest.capabilities.find((c) => c.name === "mailbox.probe")).toMatchObject({ kind: "effect", dedupe: "queryable", risk: "low", reachesPerson: false });
});

test("prepare refuses header injection, a Gmail thread id and an empty recipient list, naming the field", async () => {
  await expect(send.prepare({ to: ["kim@example.org"], subject: "a\r\nBcc: x@example.org", text: "" }, ctx)).rejects.toThrow(/subject/);
  await expect(send.prepare({ to: ["kim@example.org"], subject: "a", text: "", threadId: "abc" }, ctx)).rejects.toThrow(/threadId/);
  await expect(send.prepare({ to: [], subject: "a", text: "" }, ctx)).rejects.toThrow(/to/);
});

test("an approved email reaches the recipient once, with every header a real server needs", async () => {
  const sender = await newBox({ fromName: "Sam at Acme" });
  const to = await newBox();
  const id = crypto.randomUUID();
  const spec = await prepared({ to: [to.email], listUnsubscribe: "https://direx.test/u/1" });
  const domain = sender.email.split("@")[1];
  await expect(exec(spec, sender, id)).resolves.toEqual({ kind: "sent", providerRef: `<${id}@${domain}>`, correlationKey: `<${id}@${domain}>` });
  await until(async () => (await inboxCount(to)) === 2);
  const headers = await withBox(to, async (c) => {
    const lock = await c.getMailboxLock("INBOX", { readOnly: true });
    try {
      const m = await c.fetchOne("2", { source: true });
      return m ? (m.source as Buffer).toString().split("\r\n\r\n")[0]! : "";
    } finally {
      lock.release();
    }
  });
  expect(headers).toContain(`From: "Sam at Acme" <${sender.email}>`);
  expect(headers).toMatch(/^Date: /m);
  expect(headers).toContain(`Message-ID: <${id}@${domain}>`);
  expect(headers).toContain(`X-Direx-Action: ${id}`);
  expect(headers).toContain("List-Unsubscribe: <https://direx.test/u/1>");
  expect(headers).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
});

test("with no complete credential, nothing is sent and every read says so", async () => {
  const spec = await prepared();
  const before = fake.messages.length;
  const none = { kind: "refused", permanent: false, retryable: false, detail: "mailbox not connected" };
  await expect(exec(spec, { credential: null })).resolves.toEqual(none);
  await expect(exec(spec, { credential: { username: "a", password: "b" } })).resolves.toEqual(none);
  await expect(exec(spec, { credential: { accessToken: "t", expiresAt: "" } })).resolves.toEqual(none);
  expect(fake.messages).toHaveLength(before);
  await expect(reconcile({ credential: null }, crypto.randomUUID())).resolves.toEqual({ kind: "unknown" });
  await expect(plugin.queries["mailbox.profile"]!(null, { ...ctx, credential: null })).rejects.toThrow(/not connected/);
});

test("certificates are verified unless a test says otherwise", async () => {
  const box = await newBox();
  const strict = createImapSmtpPlugin({ timeoutMs: 3000, test: { implicitTlsPort: 3465 } });
  const r = await exec(await prepared(), box, crypto.randomUUID(), strict);
  expect(r).toMatchObject({ kind: "refused", permanent: false, retryable: true });
  await expect(strict.queries["mailbox.profile"]!(null, { ...ctx, credential: box.credential as never })).rejects.toThrow(/^SMTP/);
  await expect(strict.effects["email.send"]!.reconcile!("", { ...ctx, idempotencyKey: crypto.randomUUID(), credential: box.credential as never })).resolves.toEqual({ kind: "unknown" });
});

test("port 587 style connections refuse a server that doesn't offer STARTTLS, and send nothing", async () => {
  const box = await newBox({ smtpPort: "3025" });
  const before = await inboxCount(box);
  const spec = await prepared({ to: [box.email] });
  expect(await exec(spec, box)).toMatchObject({ kind: "refused", retryable: true });
  await Bun.sleep(200);
  expect(await inboxCount(box)).toBe(before);
});

test.each([
  ["a refused password", { auth: "535 bad credentials" }, { permanent: false, retryable: false }],
  ["a 4xx at MAIL", { mail: "451 try later" }, { permanent: false, retryable: true }],
  ["a 5xx at RCPT", { rcpt: "550 no such user" }, { permanent: true, retryable: false }],
  ["a 4xx after the message", { afterData: "452 full" }, { permanent: false, retryable: true }],
  ["a 5xx after the message", { afterData: "554 rejected" }, { permanent: true, retryable: false }],
])("%s is a definite refusal", async (_name, script, want) => {
  reset();
  Object.assign(fake.script, script);
  const box = await newBox();
  await expect(exec(await prepared(), faked(box), crypto.randomUUID(), plainPlugin)).resolves.toMatchObject({ kind: "refused", ...want });
  reset();
});

test("a server that can't be reached is a retryable refusal: nothing was sent", async () => {
  const box = await newBox({ smtpPort: "1" });
  await expect(exec(await prepared(), box, crypto.randomUUID(), plainPlugin)).resolves.toMatchObject({ kind: "refused", permanent: false, retryable: true });
});

test.each([["drops", "drop"], ["goes silent", "hang"]])("when the server takes the message and %s, the outcome is unknown", async (_name, afterData) => {
  reset();
  fake.script.afterData = afterData;
  const box = await newBox();
  const before = fake.messages.length;
  await expect(exec(await prepared(), faked(box), crypto.randomUUID(), plainPlugin)).rejects.toThrow(/connection was lost/);
  expect(fake.messages).toHaveLength(before + 1);
  reset();
});

test("a cut-off send is found in the Sent folder by its header, and only that one", async () => {
  reset();
  fake.script.afterData = "drop";
  const box = await newBox();
  const id = crypto.randomUUID();
  await expect(exec(await prepared(), faked(box), id, plainPlugin)).rejects.toThrow();
  const copy = fake.messages.at(-1)!;
  reset();
  await withBox(box, async (c) => {
    await c.mailboxCreate("Sent");
    await c.append("Sent", copy);
  });
  await expect(reconcile(box, id)).resolves.toEqual({ kind: "sent", providerRef: `<${id}@example.com>` });
  await expect(reconcile(box, crypto.randomUUID())).resolves.toEqual({ kind: "unknown" });
});

test("with no Sent folder, or a broken connection, reconcile says unknown and never not_sent", async () => {
  const box = await newBox();
  await expect(reconcile(box, crypto.randomUUID())).resolves.toEqual({ kind: "unknown" });
  const broken = { credential: { ...box.credential, password: "wrong" } };
  await expect(reconcile(broken, crypto.randomUUID())).resolves.toEqual({ kind: "unknown" });
});

test("the first poll reads the week's inbox without our own mail; later polls read only what's new", async () => {
  const box = await newBox();
  await deliverAndWait(box, raw({ from: box.email, to: box.email, subject: "From myself" }));
  await deliverAndWait(box, raw({ from: "kim@example.org", to: box.email, subject: "Reply one" }));
  const first = await poll(box, null);
  expect(subjects(first.events)).toEqual(["Seed", "Reply one"]);
  const empty = await poll(box, first.cursor);
  expect(empty.events).toEqual([]);
  await deliverAndWait(box, raw({ from: "kim@example.org", to: box.email, subject: "Reply two" }));
  const next = await poll(box, empty.cursor);
  expect(subjects(next.events)).toEqual(["Reply two"]);
});

test("a changed UIDVALIDITY or a bad cursor reads again, with the same event ids so the host drops repeats", async () => {
  const box = await newBox();
  const first = await poll(box, null);
  const stale = JSON.stringify({ uidValidity: "1", lastUid: 999 });
  const again = await poll(box, stale);
  expect(again.events.map((e) => e.eventId)).toEqual(first.events.map((e) => e.eventId));
  expect((await poll(box, "not json")).events.map((e) => e.eventId)).toEqual(first.events.map((e) => e.eventId));
});

test("a backlog comes over several polls, oldest first, and nothing is lost", async () => {
  const small = createImapSmtpPlugin({ timeoutMs: 5000, pollLimit: 2, test: untrusted });
  const box = await newBox();
  for (const n of [1, 2, 3, 4]) await deliverAndWait(box, raw({ from: "kim@example.org", to: box.email, subject: `Reply ${n}` }));
  const seen: string[] = [];
  let cursor: string | null = null;
  for (const size of [2, 2, 1, 0]) {
    const r: { events: { data: unknown }[]; cursor: string } = await poll(box, cursor, small);
    expect(r.events).toHaveLength(size);
    seen.push(...subjects(r.events));
    cursor = r.cursor;
  }
  expect(seen).toEqual(["Seed", "Reply 1", "Reply 2", "Reply 3", "Reply 4"]);
});

test("an event carries what reply handling reads, with text capped and the reply matchable", async () => {
  const box = await newBox();
  const sentId = `<${crypto.randomUUID()}@example.com>`;
  await deliverAndWait(
    box,
    raw({ from: "Kim <kim@example.org>", to: box.email, subject: "Re: Hi", extra: [`In-Reply-To: ${sentId}`, `References: <a@example.com> ${sentId}`, "Auto-Submitted: auto-replied"], body: "x".repeat(6000) }),
  );
  const { events } = await poll(box, null);
  const data = events.at(-1)!.data as { bounce: boolean; autoSubmitted: string; dsn: unknown; text: string; headers: Record<string, string> };
  expect(data.headers).toMatchObject({ from: expect.stringContaining("kim@example.org"), subject: "Re: Hi", inReplyTo: sentId });
  expect(data.headers.references).toContain(sentId);
  expect(data.autoSubmitted).toBe("auto-replied");
  expect(data.bounce).toBe(false);
  expect(data.dsn).toBeNull();
  expect(data.text).toHaveLength(5000);
});

test("a delivery notice names the recipient that failed", async () => {
  const box = await newBox();
  const boundary = "b1";
  await deliverAndWait(
    box,
    [
      "From: Mail Delivery <mailer-daemon@example.org>",
      `To: ${box.email}`,
      "Subject: Undelivered Mail Returned to Sender",
      `Message-ID: <${crypto.randomUUID()}@example.org>`,
      `Content-Type: multipart/report; report-type=delivery-status; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain",
      "",
      "It failed.",
      `--${boundary}`,
      "Content-Type: message/delivery-status",
      "",
      "Reporting-MTA: dns; example.org",
      "",
      "Final-Recipient: rfc822; Gone@Example.org",
      "Action: failed",
      "Status: 5.1.1",
      "",
      `--${boundary}--`,
      "",
    ].join("\r\n"),
  );
  const { events } = await poll(box, null);
  expect(events.at(-1)!.data).toMatchObject({ bounce: true, dsn: { recipients: [{ email: "gone@example.org", status: "5.1.1" }] } });
});

test("reading changes nothing in the mailbox", async () => {
  const box = await newBox();
  await deliverAndWait(box, raw({ from: "kim@example.org", to: box.email, subject: "Reply" }));
  const state = () =>
    withBox(box, async (c) => {
      const lock = await c.getMailboxLock("INBOX", { readOnly: true });
      try {
        const out: [number, string[]][] = [];
        for await (const m of c.fetch("1:*", { uid: true, flags: true })) out.push([m.uid, [...(m.flags ?? [])].sort()]);
        return out;
      } finally {
        lock.release();
      }
    });
  const before = await state();
  await poll(box, null);
  await plugin.queries["mail.from"]!({ email: "kim@example.org" }, { ...ctx, credential: box.credential as never });
  await reconcile(box, crypto.randomUUID());
  expect(await state()).toEqual(before);
  expect(before.flatMap(([, flags]) => flags)).not.toContain("\\Seen");
});

test("mail.from returns the week's mail from one address, and refuses anything else", async () => {
  const box = await newBox();
  await deliverAndWait(box, raw({ from: "kim@example.org", to: box.email, subject: "From Kim" }));
  await deliverAndWait(box, raw({ from: "lee@example.org", to: box.email, subject: "From Lee" }));
  const q = plugin.queries["mail.from"]!;
  const { events } = (await q({ email: "kim@example.org" }, { ...ctx, credential: box.credential as never })) as { events: { data: unknown }[] };
  expect(subjects(events)).toEqual(["From Kim"]);
  await expect(q({ email: "kim@example.org) OR (x" }, { ...ctx, credential: box.credential as never })).rejects.toThrow(/one email address/);
});

test("the profile signs in to both servers and names the side that failed", async () => {
  const box = await newBox();
  const profile = plugin.queries["mailbox.profile"]!;
  await expect(profile(null, { ...ctx, credential: box.credential as never })).resolves.toEqual({ emailAddress: box.email, hasSent: false });
  await withBox(box, (c) => c.mailboxCreate("Sent"));
  await expect(profile(null, { ...ctx, credential: box.credential as never })).resolves.toEqual({ emailAddress: box.email, hasSent: true });
  const secret = `wrong-${crypto.randomUUID()}`;
  const wrong = { ...box.credential, password: secret };
  const smtpSide = await profile(null, { ...ctx, credential: wrong as never }).catch((e: Error) => e.message);
  expect(smtpSide).toMatch(/refused the password/);
  expect(smtpSide).toMatch(/SMTP/);
  expect(smtpSide).not.toContain(secret);
  const imapOff = { ...box.credential, password: secret, settings: { ...box.credential.settings, smtpPort: String(fake.port) } };
  const imapSide = await createImapSmtpPlugin({ timeoutMs: 3000, test: { untrustedCerts: true, plainSmtp: true } }).queries["mailbox.profile"]!(null, { ...ctx, credential: imapOff as never }).catch((e: Error) => e.message);
  expect(imapSide).toBe("IMAP: the mail server refused the password");
});

const probeRead = (b: { credential: unknown }, actionId: string) => plugin.queries["mailbox.probe_read"]!({ actionId }, { ...ctx, credential: b.credential as never });
const flagsOf = (b: Box, folder: string) =>
  withBox(b, async (c) => {
    const lock = await c.getMailboxLock(folder, { readOnly: true });
    try {
      const out: string[] = [];
      for await (const m of c.fetch("1:*", { flags: true })) out.push(...(m.flags ?? []));
      return out;
    } finally {
      lock.release();
    }
  });

test("a probe sent to the Mailbox itself is read back from the inbox as it arrived, and stays unread", async () => {
  const box = await newBox();
  const id = crypto.randomUUID();
  const probe = plugin.effects["mailbox.probe"]!;
  const { spec } = await probe.prepare({ to: [box.email], subject: "Checking this mailbox", text: "Reply 'stop' and I won't email you again", listUnsubscribe: "https://direx.test/u/p" }, ctx);
  await expect(probe.execute(spec, { ...ctx, idempotencyKey: id, credential: box.credential as never })).resolves.toMatchObject({ kind: "sent" });
  await until(async () => (await inboxCount(box)) === 2);
  const r = (await probeRead(box, id)) as { found: boolean; folder: string; headers: string; text: string; html: unknown };
  expect(r).toMatchObject({ found: true, folder: "inbox", html: null });
  expect(r.headers).toContain(`X-Direx-Action: ${id}`);
  expect(r.headers).toContain("List-Unsubscribe: <https://direx.test/u/p>");
  expect(r.headers).not.toContain("\r\n\r\n");
  expect(r.text).toContain("Reply 'stop'");
  expect(await flagsOf(box, "INBOX")).not.toContain("\\Seen");
});

test("probe_read finds nothing for an unknown Action id, or one that only starts the same, and refuses a bad one", async () => {
  const box = await newBox();
  const id = crypto.randomUUID();
  await deliverAndWait(box, raw({ from: "kim@example.org", to: box.email, extra: [`X-Direx-Action: ${id}-longer`] }));
  await expect(probeRead(box, crypto.randomUUID())).resolves.toEqual({ found: false });
  await expect(probeRead(box, id)).resolves.toEqual({ found: false });
  await expect(probeRead(box, "a b")).rejects.toThrow(/Action id/);
  await expect(probeRead({ credential: null }, id)).rejects.toThrow(/not connected/);
});

test("given the probe's subject, probe_read finds it that way, and still only with our exact Action id", async () => {
  const box = await newBox();
  const id = crypto.randomUUID();
  const subject = `Direx Mailbox check ${id.slice(0, 8)}`;
  // Near miss first: the same subject with someone else's id.
  await deliverAndWait(box, raw({ from: box.email, to: box.email, subject, extra: [`X-Direx-Action: ${crypto.randomUUID()}`] }));
  const read = (s: unknown) => plugin.queries["mailbox.probe_read"]!({ actionId: id, subject: s }, { ...ctx, credential: box.credential as never });
  await expect(read(subject)).resolves.toEqual({ found: false });
  await deliverAndWait(box, raw({ from: box.email, to: box.email, subject, extra: [`X-Direx-Action: ${id}`] }));
  await expect(read(subject)).resolves.toMatchObject({ found: true, folder: "inbox" });
  await expect(read("two\r\nlines")).rejects.toThrow(/one line/);
});

test("a probe filed as junk is found there, with its HTML, and left where it is", async () => {
  const box = await newBox();
  const id = crypto.randomUUID();
  const b = "b2";
  const message = raw({ from: box.email, to: box.email, extra: [`X-Direx-Action: ${id}`, `Content-Type: multipart/alternative; boundary="${b}"`], body: [`--${b}`, "Content-Type: text/plain", "", "Plain", `--${b}`, "Content-Type: text/html", "", "<p>Rich</p>", `--${b}--`, ""].join("\r\n") })
    .replace("Content-Type: text/plain; charset=UTF-8\r\n", "");
  // Junk by name only: imapflow treats it as the junk folder when the server has no SPECIAL-USE, as GreenMail does.
  await withBox(box, async (c) => {
    await c.mailboxCreate("Junk");
    await c.append("Junk", message);
  });
  const r = await probeRead(box, id);
  expect(r).toMatchObject({ found: true, folder: "junk", text: "Plain", html: "<p>Rich</p>" });
  expect(await flagsOf(box, "Junk")).not.toContain("\\Seen");
  expect(await inboxCount(box)).toBe(1);
});
