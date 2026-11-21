// SPDX-License-Identifier: AGPL-3.0-only
// The Better Auth instance: password, magic link, Google and Microsoft sign-in, sessions in auth.*.
import { isIP } from "node:net";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { authDb, authSchema } from "@direx/db/auth";
import { INVITE_COOKIE, type Admission, type AdmitResult } from "../domain/admission";
import { isDevOrTest, mailerFromEnv, type Mailer } from "./mail";

type Env = Record<string, string | undefined>;

export type AuthConfig = {
  baseURL: string;
  secret: string;
  /** Mail only reaches the log, so nothing can be verified. Unset means the strict rules. */
  devMode?: boolean;
  mailer: Mailer;
  /** Reverse proxies whose X-Forwarded-For is believed, as addresses or CIDRs. None: only the socket's address is. */
  trustedProxies?: string[];
  /** Days without use before a sign-in ends (DIREX_SESSION_DAYS). Unset, 30. */
  sessionDays?: number;
  google?: { clientId: string; clientSecret: string };
  microsoft?: { clientId: string; clientSecret: string };
};

const DEV_SECRET = "dev-only-auth-secret-never-used-outside-dev-and-test";
const DAY_S = 86_400;
/** A sign-in ends this long after it was made, however much it is used (ADR 0037 rule 003). */
export const SESSION_CAP_MS = 90 * DAY_S * 1000;

/**
 * How recent a sign-in step-up asks for (ADR 0037 rule 004). `short` for an action that creates,
 * shows, replaces or removes a secret or credential, sets a password, changes a role or Server admin
 * standing, installs or removes a plugin, deletes a Workspace or ends sessions; `long` for every
 * other action behind step-up.
 */
export const STEP_UP_WINDOWS = { short: 10 * 60_000, long: 60 * 60_000 } as const;
export type StepUpWindow = keyof typeof STEP_UP_WINDOWS;

/**
 * DIREX_SESSION_DAYS, read once at start (ADR 0037 rule 001). Cloud runs the default, so the
 * variable there is a mistake. From 2 days, as with 1 a day-old renewal would come only once the
 * session had already ended.
 */
export function sessionDaysFromEnv(env: Env = process.env): number {
  const raw = env.DIREX_SESSION_DAYS;
  if (!raw) return 30;
  if (env.DIREX_DEPLOYMENT === "cloud") throw new Error("DIREX_SESSION_DAYS is for a self-hosted Direx only; unset it on cloud");
  const days = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(days >= 2 && days <= 90)) throw new Error(`DIREX_SESSION_DAYS must be a whole number of days from 2 to 90, not ${raw}`);
  return days;
}

/**
 * DIREX_TRUSTED_PROXIES as a list. A bad entry stops the start: Better Auth would drop it in
 * silence, and then every sign-in behind that proxy shares one rate limit bucket.
 */
export function trustedProxiesFromEnv(env: Env = process.env): string[] {
  const list = (env.DIREX_TRUSTED_PROXIES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const entry of list) {
    const [address = "", prefix, ...rest] = entry.split("/");
    const bits = isIP(address) === 6 ? 128 : 32;
    const ok = isIP(address) !== 0 && rest.length === 0 && (prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= bits));
    if (!ok) throw new Error(`DIREX_TRUSTED_PROXIES has "${entry}", which is not an IP address or a CIDR range such as 10.0.0.0/8.`);
  }
  return list;
}

/** `stored` comes from the vault. Env supplies secrets only in dev and test. */
export function authConfigFromEnv(env: Env = process.env, stored: { authSecret?: string; smtpUrl?: string; googleSecret?: string; microsoftSecret?: string } = {}): AuthConfig {
  const secret = stored.authSecret ?? (isDevOrTest(env) ? (env.DIREX_AUTH_SECRET ?? DEV_SECRET) : undefined);
  if (!secret || secret.length < 32) throw new Error("auth.secret is missing or shorter than 32 characters. Run: bun apps/api/src/secrets.ts set auth.secret");
  const dev = isDevOrTest(env);
  const pair = (id?: string, s?: string) => (id && s ? { clientId: id, clientSecret: s } : undefined);
  return {
    // The web app's address. Unset, the Vite dev server, which proxies /api to this process.
    baseURL: env.DIREX_BASE_URL ?? "http://localhost:5173",
    secret,
    devMode: isDevOrTest(env),
    mailer: mailerFromEnv(env, stored.smtpUrl),
    trustedProxies: trustedProxiesFromEnv(env),
    sessionDays: sessionDaysFromEnv(env),
    google: pair(env.DIREX_GOOGLE_CLIENT_ID, stored.googleSecret ?? (dev ? env.DIREX_GOOGLE_CLIENT_SECRET : undefined)),
    microsoft: pair(env.DIREX_MICROSOFT_CLIENT_ID, stored.microsoftSecret ?? (dev ? env.DIREX_MICROSOFT_CLIENT_SECRET : undefined)),
  };
}

// Signing in proves who someone is and nothing more: provider tokens are never kept.
// Mailbox access is a separate consent through the credential vault.
const NO_TOKENS = { accessToken: null, refreshToken: null, idToken: null };

type Ctx = { path?: string; getCookie?: (name: string) => string | null | undefined; context?: { internalAdapter: { countTotalUsers: () => Promise<number> } } } | null | undefined;

/**
 * Why an account was refused, as a 400 with a code. Not 403: email sign-up turns a 403 from this
 * hook into its generic "check your mail" answer, which would hide the refusal (ADR 0024, rule 001).
 * Magic link and the OAuth callback redirect with this code as `error`.
 */
function refusal(r: Exclude<AdmitResult, { ok: true }> | { ok: false; reason: "use_link" }): APIError {
  if (r.reason === "unverified")
    return new APIError("BAD_REQUEST", { code: "SIGNUP_UNVERIFIED", message: "Your sign-in provider didn't confirm this email address. Sign up with your email address instead." });
  if (r.reason === "use_link") return new APIError("BAD_REQUEST", { code: "SIGNUP_USE_LINK", message: "Use the email link to sign up." });
  const base = "This server takes invited people only. Ask whoever runs it for an invite.";
  const message = r.policy === "domains" && r.domains.length ? `${base} It also takes addresses at ${r.domains.join(", ")}.` : base;
  return new APIError("BAD_REQUEST", { code: "SIGNUP_REFUSED", message });
}

export function createAuth(cfg: AuthConfig, admission: () => Admission) {
  const tokenFrom = (ctx: Ctx) => ctx?.getCookie?.(INVITE_COOKIE) ?? null;

  /**
   * Every new account passes here (DX-R-0024-001). A password sign-up counts as verified because
   * no session exists until the email is confirmed; under a closed policy it needs an invite token
   * (DX-R-0024-004). A Workspace invite token for this email proves the mailbox. A bootstrap token
   * proves the person runs the server, which skips the confirmation for the server's first account
   * only (DX-R-0024-002): the token lasts until a claim, and any later account made with it would be
   * a verified address nobody proved, with a password a mailbox owner's first magic link wouldn't clear.
   */
  async function admitNewUser<U extends { email: string; emailVerified: boolean }>(u: U, ctx: Ctx): Promise<U> {
    const viaPassword = ctx?.path === "/sign-up/email";
    const verdict = await admission().admit({ email: u.email, emailVerified: viaPassword || u.emailVerified, token: tokenFrom(ctx) });
    if (!verdict.ok) throw refusal(verdict);
    if (viaPassword && verdict.via === "policy" && (await admission().status()).policy === "domains") throw refusal({ ok: false, reason: "use_link" });
    // A later magic link deletes the password of an unverified user, which is the takeover
    // defence outside dev. In dev nothing can be verified, so it would only lose the password.
    // ponytail: two sign-ups racing on an empty server could both count as first; both need the bootstrap link.
    const firstAccount = verdict.via === "bootstrap" && (await ctx?.context?.internalAdapter.countTotalUsers()) === 0;
    const verified = verdict.via === "invite" || firstAccount || (cfg.devMode === true && viaPassword);
    return verified ? { ...u, emailVerified: true } : u;
  }

  /** A link goes to an existing account, or to a new address admission would let in; else nothing is sent. */
  async function mayMailLink(email: string, ctx: (NonNullable<Ctx> & { context?: { internalAdapter: { findUserByEmail: (e: string) => Promise<unknown> } } }) | undefined) {
    if (await ctx?.context?.internalAdapter.findUserByEmail(email)) return true;
    return (await admission().admit({ email, emailVerified: true, token: tokenFrom(ctx) })).ok;
  }

  const authBasePath = new URL(cfg.baseURL).pathname.replace(/\/+$/, "") || "/api/auth";
  const rateLimitPaths = new Set<string>();
  const auth = betterAuth({
    baseURL: cfg.baseURL,
    secret: cfg.secret,
    telemetry: { enabled: false },
    database: drizzleAdapter(authDb(), { provider: "pg", schema: authSchema }),
    // The server sets X-Forwarded-For from the socket (withClientIp in startup.ts), so the rate
    // limit never keys on an address the client chose.
    advanced: { database: { generateId: "uuid" }, ipAddress: { trustedProxies: cfg.trustedProxies ?? [] } },
    // Counts live in auth.rate_limit, not process memory: API processes behind one load balancer
    // share them, and a restart or deploy doesn't reset an attacker's attempts.
    rateLimit: {
      enabled: !cfg.devMode,
      storage: "database",
      // Better Auth runs the limiter before matching a route. Only persist counters for its endpoints.
      customRules: {
        "/**": (request, rule) => {
          const pathname = new URL(request.url).pathname;
          if (!pathname.startsWith(`${authBasePath}/`)) return false;
          const path = pathname.slice(authBasePath.length).replace(/\/+$/, "");
          if (rateLimitPaths.has(path)) return rule;
          if (rateLimitPaths.has("/reset-password/:token") && /^\/reset-password\/[^/]+$/.test(path)) return rule;
          if (rateLimitPaths.has("/callback/:id") &&
              ((cfg.google && path === "/callback/google") || (cfg.microsoft && path === "/callback/microsoft"))) return rule;
          return false;
        },
      },
    },
    // Each day of use pushes the end out (ADR 0037 rule 001). No cookie cache: it would let a
    // revoked session, or one past SESSION_CAP_MS, keep working until the cache expired. Better Auth's
    // own fresh-session routes ask for the short step-up window.
    session: { expiresIn: (cfg.sessionDays ?? 30) * DAY_S, updateAge: DAY_S, cookieCache: { enabled: false }, freshAge: STEP_UP_WINDOWS.short / 1000 },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      requireEmailVerification: !cfg.devMode,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) =>
        cfg.mailer({ to: user.email, subject: "Reset your Direx password", text: `Choose a new password:\n${url}\n\nThe link works once and expires in 1 hour.` }),
    },
    emailVerification: {
      sendOnSignIn: true,
      // Sign-up mails a confirmation even to an account admission already verified; that one needs none.
      sendVerificationEmail: async ({ user, url }) => {
        if (user.emailVerified) return;
        await cfg.mailer({ to: user.email, subject: "Confirm your email for Direx", text: `Confirm your email address:\n${url}` });
      },
    },
    socialProviders: {
      ...(cfg.google && { google: cfg.google }),
      ...(cfg.microsoft && { microsoft: { ...cfg.microsoft, tenantId: "common" } }),
    },
    databaseHooks: {
      user: {
        create: { before: async (u, ctx) => ({ data: await admitNewUser(u, ctx) }) },
      },
      account: {
        create: { before: async (a) => ({ data: { ...a, ...NO_TOKENS } }) },
        update: { before: async (a) => ({ data: { ...a, ...NO_TOKENS } }) },
      },
    },
    plugins: [
      magicLink({
        // A database read must not hand over a working sign-in link.
        storeToken: "hashed",
        // A refused new address gets the same reply as a sent link, so nobody learns the policy
        // from it, and no mail leaves the server.
        sendMagicLink: async ({ email, url }, ctx) => {
          if (!(await mayMailLink(email, ctx))) return;
          await cfg.mailer({ to: email, subject: "Sign in to Direx", text: `Sign in to Direx:\n${url}\n\nThe link works once and expires in 5 minutes.` });
        },
      }),
    ],
  });
  for (const endpoint of Object.values(auth.api)) if (endpoint.path) rateLimitPaths.add(endpoint.path);
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
