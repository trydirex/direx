// SPDX-License-Identifier: AGPL-3.0-only
// The Server page, for Server admins (ADR 0024): who may sign up, who runs the server, and every
// account on it. Server-wide, so it sits outside any Workspace and shows no Workspace data.
// Outside the shell, so it brings Astryx's stylesheet and provider itself.
import "@/astryx.css";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { Button } from "@/components/Button";
import { Confirm } from "@/components/Confirm";
import { Input } from "@/components/Input";
import { Field, Notice, Page, Section } from "@/components/layout";
import { QueryBoundary } from "@/components/QueryBoundary";
import { messageFor } from "../api/messages";
import { ApiError } from "../api/query";
import { accountsQuery, addServerAdmin, mailStatusQuery, policyQuery, removeServerAdmin, setPolicy, type Account, type SignupPolicy } from "./actions";
import { message, MESSAGES } from "./messages";
import { AstryxProvider } from "@/components/astryx";
import { SignIn } from "./SignIn";
import { ServerPlugins, type Run } from "./ServerPlugins";

const POLICIES: { value: SignupPolicy["policy"]; label: string; does: string }[] = [
  { value: "invite_only", label: "Invite only", does: "Only people invited to a Workspace can make an account." },
  { value: "domains", label: "Allowed domains", does: "Invited people, and anyone with an address at the domains you list. They sign up with an email link." },
  { value: "anyone", label: "Anyone", does: "Anyone who can reach this server can make an account." },
];
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

export function Server({ me }: { me: string }) {
  const client = useQueryClient();
  const accounts = useQuery(accountsQuery);
  const policy = useQuery(policyQuery);
  const mail = useQuery(mailStatusQuery);
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState(false);

  /** Runs a change and reloads the page's data; a stale sign-in asks for a fresh one. */
  async function run(change: Promise<string | null>) {
    const code = await change;
    if (code === "step_up_required") return setStepUp(true);
    setError(code ? message(code) : undefined);
    await client.invalidateQueries({ queryKey: ["server"] });
    return code;
  }

  if (stepUp) {
    return (
      <SignIn
        title="Confirm it's you"
        note="Changing Server admins or plugins needs a recent sign-in. Sign in again, then make the change again."
        callbackURL={location.pathname}
      />
    );
  }

  // The API refuses every Server call to anyone who isn't a Server admin; say that once.
  const notAdmin = [accounts, policy, mail].some((q) => q.error instanceof ApiError && q.error.status === 403);
  const back = (
    <Link to="/" className="text-sm underline">
      Back to your Workspace
    </Link>
  );

  return (
    <AstryxProvider>
    <div className="mx-auto w-full max-w-form p-4 md:py-10">
      {notAdmin ? (
        <Page title="Server" actions={back}>
          <Notice tone="info">Only Server admins can open this page. Ask whoever runs this server if something here needs to change.</Notice>
        </Page>
      ) : (
      <Page
        title="Server"
        description="Settings for this whole Direx server. They don't open any Workspace: being a Server admin shows you no one's marketing."
        actions={back}
      >
        {error && <Notice tone="error">{error}</Notice>}
        <SignUp run={run} />
        <QueryBoundary query={accounts} messages={MESSAGES} skeleton={<Skeleton className="h-40 w-full" />}>
          {(list) => (
            <>
              <Admins list={list.filter((a) => a.serverAdmin)} me={me} run={run} />
              <Accounts list={list} />
            </>
          )}
        </QueryBoundary>
        <ServerPlugins run={run} />
      </Page>
      )}
    </div>
    </AstryxProvider>
  );
}

function SignUp({ run }: { run: Run }) {
  const policy = useQuery(policyQuery);
  const mail = useQuery(mailStatusQuery);
  return (
    <Section title="Sign-up" description="Who may make an account on this server. Invited people can always join.">
      {mail.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Checking this server's mail…
        </p>
      ) : mail.data ? (
        <p className="text-sm text-muted-foreground">Mail is working, so new accounts can confirm their email.</p>
      ) : mail.isError ? (
        <Notice tone="error">{messageFor(mail.error, MESSAGES)}</Notice>
      ) : (
        <Notice tone="error">
          This server can't send mail, so nobody new could confirm their email. The sign-up rule stays as it is until mail works. Run <code>bun run doctor</code> to see why.
        </Notice>
      )}
      <QueryBoundary query={policy} messages={MESSAGES} skeleton={<Skeleton className="h-24 w-full" />}>
        {(p) => <PolicyForm key={`${p.policy}:${p.domains.join(",")}`} saved={p} locked={mail.data !== true} run={run} />}
      </QueryBoundary>
    </Section>
  );
}

function PolicyForm({ saved, locked, run }: { saved: SignupPolicy; locked: boolean; run: Run }) {
  const [policy, setPolicyChoice] = useState(saved.policy);
  const [domains, setDomains] = useState(saved.domains.join(", "));
  const [pending, setPending] = useState(false);
  const list = domains.split(/[\s,]+/).filter(Boolean);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        setPending(true);
        void run(setPolicy({ policy, domains: policy === "domains" ? list : [] })).finally(() => setPending(false));
      }}
    >
      {/* Native radios: three fixed choices with a line each; no Astryx component fits (ADR 0020 lists none for radios). */}
      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">Who may sign up</legend>
        {POLICIES.map((o) => (
          <label key={o.value} className="flex items-start gap-2">
            <input type="radio" name="policy" value={o.value} checked={policy === o.value} disabled={locked} onChange={() => setPolicyChoice(o.value)} className="mt-1 size-4 accent-primary" />
            <span>
              {o.label}
              <small className="block text-xs text-muted-foreground">{o.does}</small>
            </span>
          </label>
        ))}
        {policy === "domains" && (
          <Field label="Domains">
            <Input required disabled={locked} autoComplete="off" spellCheck={false} placeholder="example.com, example.org" value={domains} onChange={(e) => setDomains(e.target.value)} />
          </Field>
        )}
      </fieldset>
      <div>
        <Button type="submit" pending={pending} disabled={locked}>
          Save
        </Button>
      </div>
    </form>
  );
}

function Admins({ list, me, run }: { list: Account[]; me: string; run: Run }) {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Section title="Server admins" description="They set the sign-up rule, add and remove Server admins, and create Organizations.">
      <ul className="flex flex-col gap-2">
        {list.map((a) => (
          <li key={a.userId} className="flex flex-wrap items-center justify-between gap-2">
            <span>{a.email}</span>
            {a.userId === me ? (
              <span className="text-sm text-muted-foreground">You</span>
            ) : (
              <Confirm
                title={`Remove ${a.email} as Server admin?`}
                body="Their account and Workspaces stay. They can no longer change this page or create Organizations."
                confirm="Remove"
                onConfirm={() => run(removeServerAdmin(a.userId)).then(() => undefined)}
                trigger={
                  <Button size="sm" variant="outline" aria-label={`Remove ${a.email} as Server admin`}>
                    Remove
                  </Button>
                }
              />
            )}
          </li>
        ))}
      </ul>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setPending(true);
          void run(addServerAdmin(email))
            .then((code) => code === null && setEmail(""))
            .finally(() => setPending(false));
        }}
      >
        <Field label="Email of an existing account">
          <Input type="email" required autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Button type="submit" pending={pending}>
          Add Server admin
        </Button>
      </form>
    </Section>
  );
}

function Accounts({ list }: { list: Account[] }) {
  return (
    <Section title="Accounts" description="Everyone with an account on this server, oldest first.">
      <div className="overflow-x-auto rounded-card border border-border bg-card px-2">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>Email</TableHeaderCell>
              <TableHeaderCell>Joined</TableHeaderCell>
              <TableHeaderCell>Email confirmed</TableHeaderCell>
              <TableHeaderCell>Server admin</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((a) => (
              <TableRow key={a.userId}>
                <TableCell>{a.email}</TableCell>
                <TableCell className="text-muted-foreground">{day(a.createdAt)}</TableCell>
                <TableCell>{a.emailVerified ? "Yes" : "No"}</TableCell>
                <TableCell>{a.serverAdmin ? "Yes" : "No"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Section>
  );
}
