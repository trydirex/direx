// SPDX-License-Identifier: AGPL-3.0-only
// Better Auth's own endpoints are not in the OpenAPI document, so these calls are written by
// hand. `callbackURL` is a path on this site; sign-in returns there.
import { queryOptions } from "@tanstack/react-query";
import { api } from "@/client";

const post = (path: string, body: unknown) =>
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const TRY_LATER = "That's too many tries. Wait a minute and try again.";

// The server's sign-up refusals (ADR 0024), and Better Auth's code for a bad, expired or used
// email link. Fixed text per code, so a crafted ?error= link can't put its own words on the card.
const REFUSALS: Record<string, string> = {
  SIGNUP_REFUSED: "This server takes invited people only. Ask whoever runs it for an invite.",
  SIGNUP_UNVERIFIED: "Your sign-in provider didn't confirm this email address. Sign up with your email address instead.",
  SIGNUP_USE_LINK: "Use the email link to sign up.",
  INVALID_TOKEN: "That sign-in link has expired or was already used. Ask for a new one below.",
};

/** The refusal named by a sign-in page's `?error=`, after a magic link or Google or Microsoft. */
export const signupRefusal = (search: string): string | undefined => REFUSALS[new URLSearchParams(search).get("error") ?? ""];

/** Hands an invite or bootstrap token to the server, which keeps it in a cookie for sign-up. */
export async function holdInviteToken(token: string): Promise<void> {
  const res = await post("/api/admission/token", { token }).catch(() => undefined);
  if (!res?.ok) throw new Error("We couldn't save the code from your link. Try again.");
}

/** `firstRun` is set only while the server has no accounts (`sign_up` in dev, `needs_link` outside it). */
type SignInOptions = { google: boolean; microsoft: boolean; firstRun?: "sign_up" | "needs_link" | null };

/**
 * Which of Google and Microsoft this server is set up for, or null when the server can't say. Fetched
 * with who is signed in (index.html preloads it), so the sign-in page opens with the right buttons.
 */
export const signInOptionsQuery = queryOptions({
  queryKey: ["sign-in-options"],
  queryFn: async (): Promise<SignInOptions | null> => (await api.GET("/api/sign-in-options").catch(() => undefined))?.data ?? null,
  staleTime: Infinity,
  meta: { sameForAnyone: true },
});

export async function signInWithPassword(email: string, password: string, callbackURL: string): Promise<void> {
  const res = await post("/api/auth/sign-in/email", { email, password, callbackURL });
  if (res.status === 403) throw new Error("Confirm your email address first. We sent you a new link.");
  if (res.status === 429) throw new Error(TRY_LATER);
  if (!res.ok) throw new Error("That email and password don't match.");
}

/**
 * "signed_in" when the session is ready; "verified" when the account needs no confirmation but sign-up
 * made no session (an invite or bootstrap link); "confirm" when an email link has to be followed first.
 */
export async function signUpWithPassword(email: string, password: string, callbackURL: string): Promise<"signed_in" | "verified" | "confirm"> {
  const res = await post("/api/auth/sign-up/email", { email, password, name: "", callbackURL });
  if (res.status === 429) throw new Error(TRY_LATER);
  if (res.status === 422) throw new Error("That email address already has a sign-in. Sign in, or reset your password.");
  if (res.status === 400) {
    const { code, message } = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    if (code?.startsWith("SIGNUP_") && message) throw new Error(message);
  }
  if (!res.ok) throw new Error("We couldn't sign you up. Check your email address, and use a password of at least 12 characters.");
  const { token, user } = (await res.json()) as { token?: string | null; user?: { emailVerified?: boolean } };
  return token ? "signed_in" : user?.emailVerified ? "verified" : "confirm";
}

export async function sendPasswordReset(email: string): Promise<void> {
  const res = await post("/api/auth/request-password-reset", { email, redirectTo: "/reset-password" });
  if (res.status === 429) throw new Error(TRY_LATER);
  if (!res.ok) throw new Error("We couldn't send the reset link. Try again in a minute.");
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const res = await post("/api/auth/reset-password", { token, newPassword });
  if (res.status === 429) throw new Error(TRY_LATER);
  if (!res.ok) throw new Error("That didn't work. Use at least 12 characters. If the link has expired, ask for a new one.");
}

/** Leaves the page only once the server has ended the session; otherwise says so. */
export async function signOut(next = "/"): Promise<string | null> {
  const res = await post("/api/auth/sign-out", {}).catch(() => null);
  if (!res?.ok) return "We couldn't sign you out. Try again.";
  location.assign(next);
  return null;
}

export async function sendSignInLink(email: string, callbackURL: string): Promise<void> {
  const res = await post("/api/auth/sign-in/magic-link", { email, callbackURL, errorCallbackURL: callbackURL });
  if (!res.ok) throw new Error("We couldn't send the sign-in link. Try again in a minute.");
}

export async function signInWith(provider: "google" | "microsoft", callbackURL: string): Promise<void> {
  const res = await post("/api/auth/sign-in/social", { provider, callbackURL, errorCallbackURL: callbackURL });
  const url = res.ok ? ((await res.json()) as { url?: string }).url : undefined;
  if (!url) throw new Error("That sign-in option isn't set up on this server.");
  location.assign(url);
}
