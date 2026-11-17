// SPDX-License-Identifier: AGPL-3.0-only
// Who may create an account (ADR 0024). Admission is a port: core ships the self-host
// implementation, and cloud supplies its own through runServer's extensions (DX-R-0024-011).

export type SignupPolicy = "invite_only" | "domains" | "anyone";

/** The httpOnly cookie that carries a raw invite or bootstrap token into every sign-up route. */
export const INVITE_COOKIE = "direx_invite";

export type ServerStatus = { claimed: boolean; policy: SignupPolicy; domains: string[] };

/** How an account got in, or why it didn't. `closed` carries the domains a refusal may name. */
export type AdmitResult =
  | { ok: true; via: "open" | "bootstrap" | "invite" | "policy" }
  | { ok: false; reason: "unverified" }
  | { ok: false; reason: "closed"; policy: SignupPolicy; domains: string[] };

export type AdmitInput = {
  email: string;
  /** Verified by the route: a confirmed password email, or the provider's verified flag. */
  emailVerified: boolean;
  /** The raw invite or bootstrap token from the invite cookie, if any. */
  token?: string | null;
};

export type Admission = {
  admit(input: AdmitInput): Promise<AdmitResult>;
  canCreateOrganization(userId: string): Promise<boolean>;
  status(): Promise<ServerStatus>;
};
