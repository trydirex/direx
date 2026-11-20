// SPDX-License-Identifier: AGPL-3.0-only
// System mail: magic links and invites. Not a Touch and not a ledger Action; it goes out
// before anyone is signed in. SMTP everywhere except dev and test, where it is logged.
import { createTransport } from "nodemailer";

export type Mail = { to: string; subject: string; text: string };
/** `verify`, when present, says whether mail can go out now; a mailer without it has nothing to check (the log). */
export type Mailer = ((m: Mail) => Promise<void>) & { verify?: () => Promise<boolean> };

/** How long a mail check waits for the SMTP server to connect and accept the login. */
export const MAIL_CHECK_MS = 10_000;
type Env = Record<string, string | undefined>;

/** Dev and test only: logs each message and keeps it, so tests can follow the link. */
export function logMailer(outbox: Mail[] = []): Mailer {
  return async (m) => {
    outbox.push(m);
    if (process.env.NODE_ENV !== "test") console.log(`mail to ${m.to}: ${m.subject}\n${m.text}`);
  };
}

export function smtpMailer(url: string, from: string): Mailer {
  const transport = createTransport(url);
  const send: Mailer = async (m) => {
    await transport.sendMail({ from, ...m });
  };
  // Connects and logs in, sending nothing (ADR 0024: the policy waits for mail).
  send.verify = () =>
    Promise.race([
      transport.verify().then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), MAIL_CHECK_MS).unref?.()),
    ]);
  return send;
}

export type SmtpCheck = { ok: true } | { ok: false; line: string };
type SmtpError = Error & { code?: string; originalCode?: string; responseCode?: number; response?: string };

/** The line a failed check prints, from nodemailer's error code and the server's reply (spec Part B, point 3). */
export function smtpFailure(err: SmtpError, step: "login" | "send", at: { host: string; port: number }, user: string): string {
  if (step === "send" && err.responseCode) return `${at.host} refused the test email: ${err.response ?? err.message}`;
  if (err.code === "EAUTH") return `${at.host} refused the login for ${user}`;
  // A failed handshake on smtps:// arrives as a socket error, so its own code or message says TLS.
  const tls = err.code === "ETLS" || (err.code === "ESOCKET" && /tls|ssl|certificate/i.test(`${err.originalCode ?? ""} ${err.message}`));
  if (tls) return `TLS failed on ${at.host}:${at.port}; check the port`;
  if (["EDNS", "ECONNECTION", "ETIMEDOUT", "ESOCKET"].includes(err.code ?? "")) return `couldn't reach ${at.host}:${at.port}`;
  return `${at.host} refused: ${err.message}`;
}

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Logs in within MAIL_CHECK_MS and, with `testTo`, sends one test email from `from`. Unlike
 * `verify`, says why it failed, in one line that never holds the password or the URL.
 */
export async function checkSmtp(url: string, from: string, testTo?: string): Promise<SmtpCheck> {
  const invalid = { ok: false, line: "that isn't an smtp:// or smtps:// URL" } as const;
  if (!/^smtps?:/i.test(url)) return invalid;
  // Nodemailer treats a slashless SMTP URL as an authority, where URL sees an opaque path.
  const normalized = url.replace(/^(smtps?:)(?!\/\/)(?=[\s\S])/i, "$1//");
  const u = URL.canParse(normalized) ? new URL(normalized) : null;
  if (!u) return invalid;
  const at = { host: u.hostname, port: Number(u.port) || (u.protocol === "smtps:" ? 465 : 587) };
  // A server's reply can echo what it was sent, so every line loses the URL and the password.
  const secrets = [url, u.password, decode(u.password)].filter(Boolean);
  const clean = (line: string) => secrets.reduce((l, s) => l.replaceAll(s, "***"), line).replace(/\s+/g, " ");
  const within = <T>(p: Promise<T>) =>
    Promise.race([
      p,
      new Promise<never>((_, reject) => setTimeout(() => reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), MAIL_CHECK_MS).unref?.()),
    ]);
  let transport: ReturnType<typeof createTransport> | undefined;
  let step: "login" | "send" = "login";
  try {
    // Nodemailer gives URL options precedence over defaults. Keep protocol replies off the console.
    const diagnostics = ["logger", "debug", "transactionLog"].filter((key) => u.searchParams.has(key));
    for (const key of diagnostics) u.searchParams.delete(key);
    const probeUrl = diagnostics.length ? u.href : normalized;
    if (probeUrl !== url) secrets.push(probeUrl);
    transport = createTransport(probeUrl);
    if (transport.transporter.name !== "SMTP" && transport.transporter.name !== "SMTP (pool)") {
      return { ok: false, line: "that URL doesn't select an SMTP transport" };
    }
    if ((await within(transport.verify())) !== true) {
      return { ok: false, line: "SMTP verification did not succeed" };
    }
    if (testTo) {
      step = "send";
      const base = process.env.DIREX_BASE_URL;
      const text = `This test email came from Direx${base ? ` at ${base}` : ""}. Sign-in links, invites and notices to Admins will come from this address.`;
      await within(transport.sendMail({ from, to: testTo, subject: "Direx sign-in mail works", text }));
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, line: clean(smtpFailure(e as SmtpError, step, at, decode(u.username))) };
  } finally {
    transport?.close();
  }
}

export const isDevOrTest = (env: Env) => env.NODE_ENV === "development" || env.NODE_ENV === "test";

/** SMTP when configured; the log only in dev and test; otherwise a refusal to start. */
export function mailerFromEnv(env: Env = process.env, storedUrl?: string): Mailer {
  const url = storedUrl ?? (isDevOrTest(env) ? env.DIREX_SMTP_URL : undefined);
  if (url && env.DIREX_MAIL_FROM) return smtpMailer(url, env.DIREX_MAIL_FROM);
  if (isDevOrTest(env)) return logMailer();
  throw new Error("Outside development and test, set DIREX_MAIL_FROM and run: bun apps/api/src/secrets.ts set smtp.url");
}
