// SPDX-License-Identifier: AGPL-3.0-only
// Sending over SMTP. A reply from the server is a definite answer, and so is a failure before the
// send began. Anything else that cuts off once the send began throws: the message may have gone
// out, so the ledger holds the Action and reconciles rather than resend.
//
// This uses nodemailer's SMTPConnection, not its transport. After a dropped connection the
// transport's error says command "CONN" whether or not the message was handed over, so only
// keeping track of the phase here can tell the two apart.
import SMTPConnection from "nodemailer/lib/smtp-connection";
import { tlsOptions, type ConnectOptions, type Connection } from "./connection";

export type SmtpRefusal = { ok: false; permanent: boolean; retryable: boolean; detail: string; providerLimit?: "sending_limit" | "abuse" };

// ponytail: words and enhanced codes, a heuristic. Servers phrase these freely; add a provider's own codes when one is missed.
const LIMIT = /\b(4\.7\.0|5\.4\.5)\b|\b(rate|limit|quota|too many)\b/i;
const ABUSE = /\b5\.7\.\d+\b[^]*\b(spam|abus\w*|reputation|blocklist\w*|blacklist\w*)\b/i;
/** Whether a refusal says the sender is over a limit or looks like abuse, from the server's reply. */
export function providerLimitOf(response: string): "sending_limit" | "abuse" | undefined {
  if (ABUSE.test(response)) return "abuse";
  // A message too big for the server is about this email, not the sender.
  if (/\bsize\b/i.test(response)) return undefined;
  if (LIMIT.test(response)) return "sending_limit";
  return undefined;
}

type Phase = "before_send" | "sending";
type MailError = Error & { code?: string; responseCode?: number; response?: string };

function open(c: Connection, o: ConnectOptions) {
  // 465 is TLS from the first byte; any other port must upgrade with STARTTLS or fail.
  const secure = (c.smtpPort === 465 || c.smtpPort === o.test?.implicitTlsPort) && !o.test?.plainSmtp;
  return new SMTPConnection({
    host: c.smtpHost,
    port: c.smtpPort,
    secure,
    requireTLS: !secure && !o.test?.plainSmtp,
    ignoreTLS: !!o.test?.plainSmtp,
    connectionTimeout: o.timeoutMs,
    greetingTimeout: o.timeoutMs,
    socketTimeout: o.timeoutMs,
    ...tlsOptions(o),
  });
}

/** Connects, signs in, then runs `then`; settles once with where it failed, if it did. */
function run(c: Connection, o: ConnectOptions, then?: (conn: SMTPConnection, done: (e?: MailError | null) => void) => void) {
  return new Promise<{ error: MailError; phase: Phase } | null>((resolve) => {
    const conn = open(c, o);
    let phase: Phase = "before_send";
    let settled = false;
    const finish = (error?: MailError | null) => {
      if (settled) return;
      settled = true;
      if (error) {
        conn.close();
        return resolve({ error, phase });
      }
      conn.quit();
      resolve(null);
    };
    conn.on("error", finish);
    conn.connect(() => {
      conn.login({ user: c.username, pass: c.password }, (e) => {
        if (e) return finish(e);
        if (!then) return finish();
        phase = "sending";
        then(conn, finish);
      });
    });
  });
}

/** A definite refusal, or null when the outcome is unknown. */
function refusalOf(e: MailError, phase: Phase): SmtpRefusal | null {
  const reply = e.responseCode ? `SMTP ${e.responseCode}: ${(e.response ?? "").slice(0, 200)}` : `SMTP: ${e.code ?? "connection failed"}`;
  if (e.code === "EAUTH") return { ok: false, permanent: false, retryable: false, detail: `the mail server refused the password. ${reply}` };
  if (phase === "before_send") return { ok: false, permanent: false, retryable: true, detail: reply };
  const limit = e.responseCode ? providerLimitOf(`${e.responseCode} ${e.response ?? ""}`) : undefined;
  const named = limit ? { providerLimit: limit } : {};
  if (e.responseCode && e.responseCode >= 500) return { ok: false, permanent: true, retryable: false, detail: reply, ...named };
  if (e.responseCode && e.responseCode >= 400) return { ok: false, permanent: false, retryable: true, detail: reply, ...named };
  return null;
}

/** Sends the bytes as they are. Throws when the outcome is unknown. */
export async function sendRaw(c: Connection, o: ConnectOptions, envelope: { from: string; to: string[] }, raw: string): Promise<{ ok: true } | SmtpRefusal> {
  const failed = await run(c, o, (conn, done) => conn.send(envelope, raw, (e) => done(e)));
  if (!failed) return { ok: true };
  const refusal = refusalOf(failed.error, failed.phase);
  if (refusal) return refusal;
  throw new Error(`SMTP: the connection was lost during the send (${failed.error.code ?? "unknown"})`);
}

/** Signs in without sending. Throws a message naming what failed. */
export async function checkSmtp(c: Connection, o: ConnectOptions): Promise<void> {
  const failed = await run(c, o);
  if (failed) throw new Error(refusalOf(failed.error, failed.phase)?.detail ?? "SMTP: connection failed");
}
