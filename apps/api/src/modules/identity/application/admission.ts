// SPDX-License-Identifier: AGPL-3.0-only
// The self-host Admission (ADR 0024, Decision). Order: dev and test admit everyone; then an
// unverified email is refused; then a valid token or the policy admits.
import { domainToASCII } from "node:url";
import * as repo from "../adapters/admission-repo";
import type { Admission, SignupPolicy } from "../domain/admission";
import { hashInviteToken } from "../domain/invite";

/** Lowercased, trimmed, with an international domain as punycode, so domain checks compare one form. */
export function asciiEmail(email: string): string {
  const addr = email.trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  if (at < 0) return addr;
  const ascii = domainToASCII(addr.slice(at + 1));
  return ascii ? `${addr.slice(0, at)}@${ascii}` : addr;
}

export function selfHostAdmission(opts: { devMode: boolean }): Admission {
  return {
    async admit({ email, emailVerified, token }) {
      if (opts.devMode) return { ok: true, via: "open" };
      if (!emailVerified) return { ok: false, reason: "unverified" };
      const verdict = await repo.signupAdmission(asciiEmail(email), token ? await hashInviteToken(token) : null);
      if (verdict !== "refused") return { ok: true, via: verdict };
      const { policy, domains } = await repo.serverStatus();
      return { ok: false, reason: "closed", policy, domains };
    },
    canCreateOrganization: async (userId) => opts.devMode || (await repo.isServerAdmin(userId)),
    status: () => repo.serverStatus(),
  };
}

/** A Server admin sets the policy; domains are stored lowercased and as punycode, the form admission compares. */
export const setSignupPolicy = (actor: string, policy: SignupPolicy, domains: string[]) =>
  repo.setSignupPolicy(actor, policy, [...new Set(domains.map((d) => domainToASCII(d.trim().toLowerCase()) || d.trim().toLowerCase()))]);

/** Makes the account with `email` a Server admin. It must already exist. */
export async function addServerAdmin(actor: string, email: string): Promise<string | null> {
  // ponytail: reads every account to find one email; a lookup function when servers hold many thousands.
  const accounts = await repo.listAccounts(actor);
  if (!accounts) return "forbidden";
  const target = accounts.find((a) => a.email.toLowerCase() === email.trim().toLowerCase());
  return target ? repo.setServerAdmin(actor, target.userId, true) : "no_account";
}

export const removeServerAdmin = (actor: string, target: string) => repo.setServerAdmin(actor, target, false);
export const listAccounts = repo.listAccounts;
export const isServerAdmin = repo.isServerAdmin;

/** The bootstrap claim, for the signed-in `userId` holding the CLI's raw link token. */
export const claimServer = async (userId: string, token: string) => repo.claimBootstrap(userId, await hashInviteToken(token));

/** The Admission a deployment runs: cloud must supply its own; self-host gets the one above. */
export function pickAdmission(deployment: "self_host" | "cloud", supplied: Admission | undefined, devMode: boolean): Admission {
  if (supplied) return supplied;
  if (deployment === "cloud") throw new Error("Cloud must supply its own Admission to runServer; core's sign-up rules are for self-host only.");
  return selfHostAdmission({ devMode });
}
