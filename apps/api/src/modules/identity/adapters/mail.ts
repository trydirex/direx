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

export const isDevOrTest = (env: Env) => env.NODE_ENV === "development" || env.NODE_ENV === "test";

/** SMTP when configured; the log only in dev and test; otherwise a refusal to start. */
export function mailerFromEnv(env: Env = process.env, storedUrl?: string): Mailer {
  const url = storedUrl ?? (isDevOrTest(env) ? env.DIREX_SMTP_URL : undefined);
  if (url && env.DIREX_MAIL_FROM) return smtpMailer(url, env.DIREX_MAIL_FROM);
  if (isDevOrTest(env)) return logMailer();
  throw new Error("Outside development and test, set DIREX_MAIL_FROM and run: bun apps/api/src/secrets.ts set smtp.url");
}
