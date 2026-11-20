// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Field, Notice, Page } from "../components/layout";
import { NativeButton, NativeInput } from "@/components/native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ME } from "@/api/query";
import { addPassword } from "./actions";
import { message } from "./messages";
import { holdInviteToken, resetPassword, sendPasswordReset, sendSignInLink, signInOptionsQuery, signInWith, signInWithPassword, signUpWithPassword, signupRefusal } from "./auth";

type Mode = "sign_in" | "sign_up" | "forgot";

const SUBMIT: Record<Mode, string> = { sign_in: "Sign in", sign_up: "Sign up", forgot: "Email me a reset link" };

/** A narrow card centred on the page, for the screens that sit outside the shell. */
export function Narrow(p: { children: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-sm px-4 py-12">
      {/* A 48px page title would wrap in a card this narrow, so titles here are section-sized. */}
      <div className="rounded-card border border-border bg-card p-6 [&_h1]:text-lg">{p.children}</div>
      {/* The API sends this to wherever this server's source is published (AGPL section 13). */}
      <p className="mt-4 text-center text-xs text-muted-foreground">
        Direx is open source. <a href="/api/source">Get the source code</a>.
      </p>
    </div>
  );
}

/** Google or Microsoft first (most people have one), then email and password, then an email link. Also the step-up prompt, with its own title. */
export function SignIn({
  title = "Sign in to Direx",
  signUpTitle = "Sign up for Direx",
  note,
  callbackURL,
  initialMode = "sign_in",
  inviteToken,
  offerSignUp = false,
}: {
  title?: string;
  signUpTitle?: string;
  note?: string;
  callbackURL: string;
  initialMode?: Mode;
  /** From an invite or bootstrap link: held by the server so any way of signing up carries it. */
  inviteToken?: string;
  /** Only the signed-out pages offer a new sign-up; a step-up prompt is for someone already signed in. */
  offerSignUp?: boolean;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [sent, setSent] = useState<string>();
  const [error, setError] = useState<string | undefined>(() => signupRefusal(location.search));
  const tokenHeld = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => {
    tokenHeld.current = inviteToken ? holdInviteToken(inviteToken) : undefined;
  }, [inviteToken]);
  // Both buttons show until the server says which it is set up for, so a server that has them never loses them.
  const providers = useQuery(signInOptionsQuery).data ?? { google: true, microsoft: true };
  const [pending, setPending] = useState<"submit" | "link">();
  const fail = (e: Error) => setError(e.message);
  const signedIn = () => location.assign(callbackURL);

  // The tokenless claim page relies on the cookie set by the hold response.
  const claimTokenHeld = () => callbackURL === "/claim" ? tokenHeld.current : undefined;
  const social = async (provider: "google" | "microsoft") => {
    await claimTokenHeld();
    await signInWith(provider, callbackURL);
  };
  const magicLink = async () => {
    await claimTokenHeld();
    await sendSignInLink(email, callbackURL);
  };
  const submit = async () => {
    if (mode !== "forgot") await claimTokenHeld();
    if (mode === "sign_in") {
      await signInWithPassword(email, password, callbackURL);
      signedIn();
    } else if (mode === "sign_up") {
      const result = await signUpWithPassword(email, password, callbackURL);
      if (result === "confirm") return setSent(`Check ${email} for a link to confirm your address, then sign in.`);
      if (result === "verified") await signInWithPassword(email, password, callbackURL);
      signedIn();
    } else {
      await sendPasswordReset(email);
      setSent(`If ${email} has a sign-in here, we sent it a reset link. It works once and expires in 1 hour.`);
    }
  };
  const go = (next: Mode) => () => {
    setMode(next);
    setError(undefined);
  };

  if (sent)
    return (
      <Narrow>
        <Notice>{sent}</Notice>
        <NativeButton type="button" variant="ghost" size="sm" onClick={() => setSent(undefined)}>
          Use a different email
        </NativeButton>
      </Narrow>
    );
  return (
    <Narrow>
      <Page title={mode === "sign_up" ? signUpTitle : mode === "forgot" ? "Reset your password" : title} description={note ?? (mode !== "forgot" ? "Plans and drafts your marketing. Nothing goes out until you approve it." : undefined)}>
        {(providers.google || providers.microsoft) && (
          <div className="flex flex-col gap-2">
            {providers.google && (
              <NativeButton type="button" variant="outline" onClick={() => social("google").catch(fail)}>
                Continue with Google
              </NativeButton>
            )}
            {providers.microsoft && (
              <NativeButton type="button" variant="outline" onClick={() => social("microsoft").catch(fail)}>
                Continue with Microsoft
              </NativeButton>
            )}
            <p className="text-center text-sm text-muted-foreground">or use email</p>
          </div>
        )}
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(undefined);
            setPending("submit");
            submit()
              .catch(fail)
              .finally(() => setPending(undefined));
          }}
        >
          <Field label="Email">
            <NativeInput type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {mode !== "forgot" && (
            <Field label="Password" hint={mode === "sign_up" ? "Use at least 12 characters." : undefined}>
              <NativeInput
                type="password"
                required
                minLength={mode === "sign_up" ? 12 : undefined}
                autoComplete={mode === "sign_up" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          )}
          <NativeButton type="submit" pending={pending === "submit"}>
            {SUBMIT[mode]}
          </NativeButton>
          {error && <Notice tone="error">{error}</Notice>}
        </form>
        <div className="flex flex-wrap gap-2">
          {mode === "sign_in" ? (
            <>
              {offerSignUp && (
                <NativeButton type="button" variant="ghost" size="sm" onClick={go("sign_up")}>
                  New here? Sign up
                </NativeButton>
              )}
              <NativeButton type="button" variant="ghost" size="sm" onClick={go("forgot")}>
                Forgot your password?
              </NativeButton>
            </>
          ) : (
            <NativeButton type="button" variant="ghost" size="sm" onClick={go("sign_in")}>
              Back to sign in
            </NativeButton>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <NativeButton
            type="button"
            variant="outline"
            pending={pending === "link"}
            onClick={() => {
              if (!email) return setError("Enter your email address first.");
              setPending("link");
              magicLink()
                .then(() => setSent(`Check ${email} for a sign-in link. It works once and expires in 5 minutes.`), fail)
                .finally(() => setPending(undefined));
            }}
          >
            Email me a sign-in link
          </NativeButton>
        </div>
      </Page>
    </Narrow>
  );
}

/**
 * A production server nobody has signed up to yet: only the bootstrap link gets in (ADR 0024), so a
 * form here could only fail. The page can't tell how Direx was installed, so it shows both commands.
 */
export function NotSetUp() {
  return (
    <Narrow>
      <Page title="This Direx isn't set up yet">
        <p className="text-sm">
          The person who installed it becomes its first Server admin by opening the one-time link the install printed. If that's you, open that link.
        </p>
        <p className="text-sm">If the link was lost or has expired, make a new one on the server, from the root of the Direx checkout.</p>
        <p className="text-sm">
          Installed with Docker Compose: <code className="break-all">docker compose -f deploy/compose/compose.yml exec direx bun run server-admin --invite</code>
        </p>
        <p className="text-sm">
          Installed from the source code: <code className="break-all">bun run server-admin --invite</code>
        </p>
      </Page>
    </Narrow>
  );
}

/** Where a password reset email lands. The API puts `token` in the address, or `error` if the link is bad. */
export function ResetPassword({ token }: { token: string | null }) {
  const [password, setPassword] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [again, setAgain] = useState(false);

  if (!token && again) return <SignIn callbackURL="/" initialMode="forgot" offerSignUp />;
  if (!token)
    return (
      <Narrow>
        <Notice tone="error">This reset link has expired or was already used.</Notice>
        <NativeButton type="button" variant="ghost" size="sm" onClick={() => setAgain(true)}>
          Send me a new link
        </NativeButton>
      </Narrow>
    );
  if (saved)
    return (
      <Narrow>
        <Notice>
          Your password is changed. <a href="/">Sign in</a>.
        </Notice>
      </Narrow>
    );
  return (
    <Narrow>
      <Page title="Choose a new password">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            resetPassword(token, password)
              .then(() => setSaved(true), (err: Error) => setError(err.message))
              .finally(() => setPending(false));
          }}
        >
          <Field label="New password" hint="Use at least 12 characters. This signs you out everywhere else.">
            <NativeInput type="password" required minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <NativeButton type="submit" pending={pending}>
            Change password
          </NativeButton>
        </form>
        {error && <Notice tone="error">{error}</Notice>}
      </Page>
    </Narrow>
  );
}

/** For an account that signs in by email link, Google or Microsoft: a password as well (ADR 0024). Needs a recent sign-in. */
export function AddPassword() {
  const client = useQueryClient();
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"form" | "saved" | "step_up">("form");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  if (state === "step_up")
    return <SignIn title="Confirm it's you" note="Adding a password needs a recent sign-in. Sign in again, then add it." callbackURL={location.pathname} />;
  if (state === "saved")
    return (
      <Narrow>
        <Notice>
          Your password is set. Next time, you can sign in with your email address and this password. <a href="/">Back to Direx</a>
        </Notice>
      </Narrow>
    );
  return (
    <Narrow>
      <Page title="Add a password">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            addPassword(password)
              .then(async (code) => {
                if (code === "step_up_required") return setState("step_up");
                if (code) return setError(message(code));
                await client.invalidateQueries({ queryKey: ME });
                setState("saved");
              })
              .finally(() => setPending(false));
          }}
        >
          <Field label="Password" hint="Use at least 12 characters.">
            <NativeInput type="password" required minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <NativeButton type="submit" pending={pending}>
            Add password
          </NativeButton>
        </form>
        {error && <Notice tone="error">{error}</Notice>}
      </Page>
    </Narrow>
  );
}
