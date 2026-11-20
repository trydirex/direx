// SPDX-License-Identifier: AGPL-3.0-only
// Server admission through the system functions of migration 0126: no Workspace is set, and the
// tables themselves have no grants (DX-R-0024-010). The one exception, `serverHasAccounts`, reads
// an auth table, which direx_app may.
import { withSystem } from "@direx/db";
import { authSchema } from "@direx/db/auth";
import { sql } from "drizzle-orm";
import type { ServerStatus, SignupPolicy } from "../domain/admission";

export type Verdict = "bootstrap" | "invite" | "policy" | "refused";

export async function signupAdmission(email: string, tokenHash: string | null): Promise<Verdict> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select system.signup_admission(${email}, ${tokenHash}) as r`));
  return (rows[0] as { r: Verdict }).r;
}

export async function isServerAdmin(userId: string): Promise<boolean> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select system.is_server_admin(${userId}::uuid) as r`));
  return (rows[0] as { r: boolean }).r;
}

/**
 * Makes the claimant the first Server admin (DX-R-0024-005). An expired, revoked or used link and
 * an already claimed server read the same to the person: the link can't be used.
 */
export async function claimBootstrap(userId: string, tokenHash: string): Promise<"ok" | "link_unusable" | "unverified_email"> {
  try {
    await withSystem((tx) => tx.execute(sql`select system.claim_bootstrap(${userId}::uuid, ${tokenHash})`));
    return "ok";
  } catch (e) {
    const code = pgCode(e);
    if (code === "DXCLM" || code === "DX404") return "link_unusable";
    if (code === "DXUNV") return "unverified_email";
    throw e;
  }
}

const pgCode = (e: unknown) => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err.code ?? err.cause?.code;
};

/** Runs a Server admin's change; the function's refusal comes back as its code, success as null. */
async function refusable(q: ReturnType<typeof sql>, refusals: Record<string, string>): Promise<string | null> {
  try {
    await withSystem((tx) => tx.execute(q));
    return null;
  } catch (e) {
    const reason = refusals[pgCode(e) ?? ""];
    if (reason) return reason;
    throw e;
  }
}

export const setSignupPolicy = (actor: string, policy: SignupPolicy, domains: string[]) =>
  refusable(sql`select system.set_signup_policy(${actor}::uuid, ${policy}, ${sql.param(domains)}::text[])`, { DX403: "forbidden", DXDOM: "bad_domain" });

/** Every grant and removal is recorded by the function; two admins removing each other at once leave one (DX-R-0024-009). */
export const setServerAdmin = (actor: string, target: string, makeAdmin: boolean) =>
  refusable(sql`select system.set_server_admin(${actor}::uuid, ${target}::uuid, ${makeAdmin})`, { DX403: "forbidden", DX404: "not_found", DXLST: "last_server_admin" });

export type Account = { userId: string; email: string; emailVerified: boolean; createdAt: string; serverAdmin: boolean };

/** Every account, for a Server admin; null for anyone else. Account fields only (DX-R-0024-007). */
export async function listAccounts(actor: string): Promise<Account[] | null> {
  try {
    const { rows } = await withSystem((tx) => tx.execute(sql`select * from system.list_accounts(${actor}::uuid)`));
    return (rows as { user_id: string; email: string; email_verified: boolean; created_at: string | Date; server_admin: boolean }[]).map((r) => ({
      userId: r.user_id,
      email: r.email,
      emailVerified: r.email_verified,
      createdAt: new Date(r.created_at).toISOString(),
      serverAdmin: r.server_admin,
    }));
  } catch (e) {
    if (pgCode(e) === "DX403") return null;
    throw e;
  }
}

export async function serverStatus(): Promise<ServerStatus> {
  const { rows } = await withSystem((tx) => tx.execute(sql`select * from system.server_status()`));
  const r = rows[0] as { claimed: boolean; signup_policy: SignupPolicy; allowed_domains: string[] };
  return { claimed: r.claimed, policy: r.signup_policy, domains: r.allowed_domains };
}

/** Whether anyone has an account yet. Read directly: direx_app may read the auth tables (migration 0012). */
export async function serverHasAccounts(): Promise<boolean> {
  const rows = await withSystem((tx) => tx.select({ id: authSchema.user.id }).from(authSchema.user).limit(1));
  return rows.length > 0;
}
