// SPDX-License-Identifier: AGPL-3.0-only
// External tokens in Settings (ADR 0032 rule 005): every member sees the list and revokes a token in
// one click; Owners and Admins make one after a recent sign-in. A new token shows once, here only.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { inWorkspace } from "../api/query";
import { Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { StatusChip, type Tone } from "../components/StatusChip";
import { Button } from "@/components/Button";
import { Input, Select } from "@/components/Input";
import { toast } from "@/components/toast";
import { membersQuery } from "../identity/actions";
import { SignIn } from "../identity/SignIn";
import type { Role } from "../items/actions";
import { makeToken, revokeToken, tokenRequestsQuery, tokensQuery, type ExternalToken, type TokenChoices } from "./actions";

type Words = { label: string; hint: string };
/** What each reader lets a token see, in the form's words. */
export const READER_WORDS: Record<string, Words> = {
  read_changes: { label: "State changes", hint: "When an email or post moves from one state to another." },
  read_needs_you: { label: "Needs you", hint: "What waits for a person here. Titles can name someone." },
  read_schedule: { label: "Calendar", hint: "What is planned between two dates. Titles can name someone." },
  read_campaign: { label: "Campaigns", hint: "Each Campaign's goal, dates, steps and counts." },
};
/** What each proposal kind lets a token suggest, and where it lands. */
export const KIND_WORDS: Record<string, Words> = {
  fact_proposal: { label: "Brand facts", hint: 'Each arrives in Brand as "Add this?" and is used for nothing until a person accepts it.' },
  draft: { label: "Social posts", hint: "Each arrives on the Calendar and goes out only if a person approves it." },
};
const STATE: Record<ExternalToken["state"], [Tone, string]> = {
  live: ["good", "Active"],
  expired: ["off", "Expired"],
  revoked: ["off", "Revoked"],
  stopped: ["broken", "Stopped: its maker is no longer an Owner or Admin"],
};
const SAYS: Record<string, string> = {
  bad_name: "Give it a name of 1 to 60 characters.",
  bad_lifetime: "Pick one of the lifetimes offered.",
  unknown_reader: "Pick what it can read from the list.",
  unknown_kind: "Pick what it can suggest from the list.",
  forbidden: "Only Owners and Admins can make a token.",
};
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
/** How a door request ended, in words; the request's content is never kept. */
const OUTCOME: Record<string, string> = {
  ok: "Answered",
  invalid_input: "Refused: the request didn't fit the reader",
  reader_not_allowed: "Refused: not something this token can read",
  rate_limited: "Refused: too many requests",
  too_large: "Refused: too large",
  bad_cursor: "Refused: an old or unknown cursor",
  error: "Direx couldn't answer",
};

/** A token's last 20 requests, loaded when someone opens the list. */
function Requests(p: { workspaceId: string; tokenId: string }) {
  const rows = useQuery(tokenRequestsQuery(p.workspaceId, p.tokenId));
  return (
    <QueryBoundary query={rows} skeleton={<Skeleton className="mt-2 h-10 w-full" />}>
      {(list) =>
        list.length === 0 ? (
          <p className="mt-2 text-muted-foreground">None yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {list.map((r, i) => (
              <li key={`${r.at}-${i}`}>
                <span className="text-muted-foreground">{when(r.at)}</span> {r.reader === "mcp" ? "MCP" : (READER_WORDS[r.reader]?.label ?? r.reader)}: {OUTCOME[r.outcome] ?? r.outcome}
              </li>
            ))}
          </ul>
        )
      }
    </QueryBoundary>
  );
}

export function Tokens(p: { workspaceId: string; role: Role; me: string }) {
  const makes = p.role === "owner" || p.role === "admin";
  const tokens = useQuery(tokensQuery(p.workspaceId));
  const members = useQuery(membersQuery(p.workspaceId));
  const [shown, setShown] = useState<string>();
  const [stepUp, setStepUp] = useState(false);
  if (stepUp) return <SignIn title="Confirm it's you" note="Making a token needs a recent sign-in. Sign in again, then make it again." callbackURL={location.pathname} />;

  const maker = (userId: string) => (userId === p.me ? "you" : (members.data?.find((m) => m.userId === userId)?.email ?? "a former member"));
  return (
    <Page title="External tokens" description="A token lets a script, a connector such as Zapier, or your own agent read this Workspace and suggest work. It never approves or sends anything.">
      {shown && <Shown key={shown} token={shown} onHide={() => setShown(undefined)} />}
      <QueryBoundary query={tokens} skeleton={<Skeleton className="h-24 w-full" />}>
        {(data) => (
          <>
            <Section title="Tokens">
              {data.tokens.length === 0 ? (
                <p className="text-muted-foreground">No tokens yet.</p>
              ) : (
                <ul className="flex flex-col">
                  {data.tokens.map((t) => (
                    <Row key={t.id} workspaceId={p.workspaceId} token={t} maker={maker(t.createdBy)} />
                  ))}
                </ul>
              )}
            </Section>
            {makes ? <Make workspaceId={p.workspaceId} choices={data.choices} onMade={setShown} onStepUp={() => setStepUp(true)} /> : <p className="text-muted-foreground">Only Owners and Admins can make a token.</p>}
          </>
        )}
      </QueryBoundary>
    </Page>
  );
}

function Row(p: { workspaceId: string; token: ExternalToken; maker: string }) {
  const { token: t } = p;
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [tone, state] = STATE[t.state];
  const revoke = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await revokeToken(p.workspaceId, t.id);
    } catch {
      setError(`Could not revoke ${t.name}. Try again.`);
      return;
    } finally {
      setBusy(false);
    }
    toast.add({ title: `Revoked ${t.name}. It stops working now.` });
    await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
  };
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-t py-3 first:border-t-0">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t.name}</span>
          <code className="text-muted-foreground">dxt_{t.hint}…</code>
          <StatusChip tone={tone}>{state}</StatusChip>
        </p>
        <p className="text-sm text-muted-foreground">
          Made by {p.maker} on {day(t.createdAt)}. {t.revokedAt ? `Revoked on ${day(t.revokedAt)}.` : `Expires on ${day(t.expiresAt)}.`} {t.lastUsedAt ? `Last used on ${day(t.lastUsedAt)}.` : "Not used yet."}
        </p>
        <details className="text-sm" onToggle={(e) => setOpen(e.currentTarget.open)}>
          <summary className="cursor-pointer">Recent requests</summary>
          {open && <Requests workspaceId={p.workspaceId} tokenId={t.id} />}
        </details>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {(t.state === "live" || t.state === "stopped") && (
        <Button size="sm" variant="outline" pending={busy} label={`Revoke ${t.name}`} onClick={() => void revoke()}>
          Revoke
        </Button>
      )}
    </li>
  );
}

function Make(p: { workspaceId: string; choices: TokenChoices; onMade: (token: string) => void; onStepUp: () => void }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const make = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setError(undefined);
    let r: Awaited<ReturnType<typeof makeToken>>;
    try {
      r = await makeToken(p.workspaceId, { name: String(f.get("name") ?? ""), days: Number(f.get("days")), readers: f.getAll("reader").map(String), kinds: f.getAll("kind").map(String) });
    } catch {
      await client.invalidateQueries({ queryKey: tokensQuery(p.workspaceId).queryKey });
      setError("We couldn't confirm whether the token was made. Check the token list before trying again. If it appears there, revoke it before making another: its secret cannot be shown again.");
      return;
    } finally {
      setBusy(false);
    }
    if ("error" in r) {
      if (r.error === "step_up_required") return p.onStepUp();
      return setError(SAYS[r.error] ?? "The token could not be made. Try again.");
    }
    setError(undefined);
    form.reset();
    p.onMade(r.token);
    await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
  };
  const box = (name: string, value: string, words: Words | undefined, checked: boolean) => (
    <label key={value} className="flex items-start gap-2">
      <input type="checkbox" className="mt-1 accent-primary" name={name} value={value} defaultChecked={checked} />
      <span>
        {words?.label ?? value}
        {words && <span className="block text-sm text-muted-foreground">{words.hint}</span>}
      </span>
    </label>
  );

  return (
    <Section title="Make a token" description="Choose what it can read and suggest. You can't change that later: make a new token and revoke this one.">
      <form className="flex flex-col gap-4" onSubmit={(e) => void make(e)}>
        <div className="flex flex-wrap items-end gap-3">
          <Input name="name" label="Name" hint="Where it's used, such as Zapier." maxLength={60} required />
          <Select name="days" label="Expires after" defaultValue="30">
            {p.choices.lifetimes.map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </Select>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">What it can read</legend>
          {p.choices.readers.map((r) => box("reader", r.name, READER_WORDS[r.name], !r.personal))}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 font-medium">What it can suggest</legend>
          {p.choices.kinds.map((k) => box("kind", k, KIND_WORDS[k], false))}
        </fieldset>
        {error && <Notice tone="error">{error}</Notice>}
        <div>
          <Button type="submit" pending={busy}>
            Make token
          </Button>
        </div>
      </form>
    </Section>
  );
}

function Shown(p: { token: string; onHide: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Section title="Your new token" description="Copy it now. You won't see this again.">
      <div className="flex flex-wrap items-center gap-3">
        <code className="min-w-0 break-all">{p.token}</code>
        <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(p.token).then(() => setCopied(true))}>
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" variant="ghost" onClick={p.onHide}>
          Hide it
        </Button>
      </div>
    </Section>
  );
}
