// SPDX-License-Identifier: AGPL-3.0-only
import { Confirm } from "../components/Confirm";
import { StatusChip, statusTone } from "../components/StatusChip";
import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { settingsQuery as newsletterQuery } from "../newsletter/actions";
import type { components } from "../api/schema";
import { inWorkspace } from "../api/query";
import { messageForCode } from "../api/messages";
import { EmptyState, Field, Notice, Page } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAction } from "../components/useAction";
import { Button } from "@/components/Button";
import { Input, Select } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { toast } from "@/components/toast";
import { SignIn } from "../identity/SignIn";
import { MailboxPace, WorkspaceZone } from "./MailboxPace";
import { MailboxPause } from "./MailboxPause";
import { mayApprove } from "../items/actions";
import { momentWords } from "../campaigns/actions";
import { latestPlacement, Placement } from "./Placement";
import { PlacementJoin } from "./PlacementJoin";
import { WorkspacePlugins } from "./WorkspacePlugins";
import { networksQuery } from "../social/actions";
import {
  add,
  checkAgain,
  checkKey,
  connectKey,
  connectWithForm,
  credentialsQuery,
  history,
  keyServicesQuery,
  KINDS,
  mailboxChecksQuery,
  mailboxProvidersQuery,
  existingMailboxProvidersQuery,
  paceQuery,
  placementResultsQuery,
  remove,
  replaceKey,
  rotate,
  split,
  startConnect,
  type AccessEvent,
  type Credential,
  type Kind,
  type KeyCheck,
  type KeyService,
  type MailboxCheck,
  type MailboxProvider,
} from "./actions";

type S = components["schemas"];
export type Tab = "mailboxes" | "workspace" | "mine";
const TABS: [Tab, string][] = [
  ["mailboxes", "Email accounts"],
  ["workspace", "Shared with the team"],
  ["mine", "Only mine"],
];

const MESSAGES: Record<string, string> = {
  duplicate_key: "That key is already in use here. Pick another.",
  stale_version: "Someone changed this credential while you were editing. Reload and try again.",
  bad_value: "That value isn't in the right form for this kind of credential.",
  bad_meta: "One of the plain fields isn't in the right form.",
  missing: "We couldn't find that credential. It may have been removed.",
  unknown_connection: "Direx isn't set up to connect that provider.",
  check_failed: "The service didn't accept the key, or couldn't be reached. Nothing was saved. Check the key and try again.",
  denied: "The connection was cancelled. Nothing was saved.",
  missing_scope: "Google didn't grant permission to send email. Connect again and allow everything asked for.",
  no_refresh_token: "Google didn't let Direx stay connected. Connect again.",
  expired: "The connect link expired. Start again.",
  state_mismatch: "That connect attempt didn't match this browser. Start again.",
  bad_cookie: "That connect attempt didn't match this browser. Start again.",
  wrong_user: "You came back signed in as someone else. Sign in as the person who started, then start again.",
  not_member: "You're no longer a member of that Workspace.",
  exchange_failed: "Google didn't finish the connection. Try again in a minute.",
  bad_id_token: "Google didn't confirm the email address. Try again.",
  daily_limit: "You can check an email account five times a day.",
  provider_refused_recently: "Your provider refused the last test email. Try again tomorrow.",
  stale_wording: "This page is out of date. Reload it and try again.",
  not_a_mailbox: "That credential isn't an email account.",
};

/** A Mailbox's unsubscribe check, in words. A Mailbox never checked shows as "unchecked". */
const CHECK_STATE: Record<MailboxCheck["state"], string> = {
  passed: "Unsubscribe check passed",
  pending: "Checking unsubscribe links",
  unchecked: "Not checked yet. Cold email from it waits.",
  replies_only: "Replies only. Your provider changes unsubscribe links, so Direx won't send cold email from this email account.",
  failed: "The test email couldn't be sent",
  inconclusive: "The test email didn't arrive within a day. Cold email from it waits.",
};
const CHECK_REASON: Record<string, string> = {
  sign_in_not_email: "Its sign-in isn't an email address, so Direx can't send it a test email.",
  sender_identity_missing: "Add your sender name and postal address, then check again.",
  provider_cannot_check: "This provider can't be checked yet.",
  settings_changed: "Its settings changed since the last check.",
  provider_refused: "your provider refused it",
  probe_not_found: "it never arrived",
};
const CHECK_WARNING: Record<string, string> = {
  message_id_replaced: "Your provider replaces the ID on each email, so some replies may not be matched to the email they answer.",
  text_added: "Your provider adds its own text to every email.",
};
const mailboxCheckWords = (c: Pick<MailboxCheck, "state" | "reason">) => {
  const reason = c.reason ? CHECK_REASON[c.reason] : undefined;
  if (c.state === "failed") return `${CHECK_STATE.failed}${reason ? `: ${reason}` : "."}`;
  return reason && c.state === "unchecked" ? `${CHECK_STATE.unchecked} ${reason}` : CHECK_STATE[c.state];
};
export const message = (code: string) => messageForCode(code, MESSAGES);
const STATUS: Record<Credential["status"], string> = { active: "Working", needs_reauth: "Reconnect needed", revoked: "Revoked" };

/** A write-only value field: typed once, sent once, cleared. The same field as every other, so Field labels it the same way. */
export function Secret(p: { value: string; onChange: (e: ChangeEvent<HTMLInputElement>) => void; label?: string; hint?: ReactNode }) {
  return <Input type="password" autoComplete="new-password" required label={p.label} hint={p.hint} value={p.value} onChange={p.onChange} />;
}
Object.assign(Secret, { astryxField: true });

/**
 * A Workspace's credentials, in three tabs. A value is typed into a password field, sent
 * once and cleared; nothing on this page ever shows one.
 */
export function Credentials(p: { workspace: S["MyWorkspace"]; me: string; tab?: string; onTab?: (tab: Tab) => void; notice?: string; providers?: MailboxProvider[]; services?: KeyService[]; credentials?: Credential[]; checks?: MailboxCheck[] }) {
  const { workspace, me } = p;
  const manage = workspace.role === "owner" || workspace.role === "admin";
  const mayConnect = workspace.role !== "viewer";
  const client = useQueryClient();
  // Props seed the page all at once (tests, a server render): a list not given is then empty.
  const seeded = p.credentials ?? p.providers ?? p.services ?? p.checks;
  const seed = <T,>(x: T[] | undefined) => x ?? (seeded ? [] : undefined);
  const credentials = useQuery({ ...credentialsQuery(workspace.id), initialData: seed(p.credentials) });
  const providers = useQuery({ ...mailboxProvidersQuery(workspace.id), initialData: seed(p.providers) }).data ?? [];
  const services = useQuery({ ...keyServicesQuery(workspace.id), initialData: seed(p.services) }).data ?? [];
  const existingProviders = useQuery({ ...existingMailboxProvidersQuery(workspace.id), initialData: seed(p.providers) }).data ?? [];
  const checks = useQuery({ ...mailboxChecksQuery(workspace.id), initialData: seed(p.checks) }).data ?? [];
  // A newsletter tool's key is set up, replaced and removed on the Newsletter page, so it shows here only as a pointer.
  const letterTools = new Set((useQuery({ ...newsletterQuery(workspace.id), enabled: !seeded }).data?.platforms ?? []).map((x) => x.connection));
  const keyed = services.filter((s) => !letterTools.has(s.connection));
  const letters = services.filter((s) => letterTools.has(s.connection));
  // A connected network account has its own page, and it isn't a Mailbox.
  const networks = (useQuery({ ...networksQuery(workspace.id), initialData: seeded ? [] : undefined }).data ?? []).map((n) => n.connection);
  const [tab, setTab] = useState<Tab>(TABS.find(([t]) => t === p.tab)?.[0] ?? "mailboxes");
  const [error, setError] = useState(p.notice && message(p.notice));
  const [stepUp, setStepUp] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState<string>();

  const reload = () => client.invalidateQueries({ queryKey: inWorkspace(workspace.id) });

  /** Shows the outcome of a change; true when it worked. */
  async function settle(code: string | null) {
    if (code === "step_up_required") {
      setStepUp(true);
      return false;
    }
    setError(code ? message(code) : undefined);
    await reload();
    return code === null;
  }

  async function connect(provider: MailboxProvider) {
    if (provider.connect === "form") return setOpen(open === provider.connection ? null : provider.connection);
    setStarting(provider.connection);
    const r = await startConnect(workspace.id, provider.connection).finally(() => setStarting(undefined));
    if ("url" in r) location.assign(r.url);
    else setError(message(r.error));
  }

  // The value is not kept while the person signs in again, so they make the change once more.
  if (stepUp) {
    return (
      <SignIn
        title="Confirm it's you"
        note="Changing a Workspace credential needs a recent sign-in. Sign in again, then make the change once more."
        callbackURL={location.pathname + location.search}
      />
    );
  }

  const rowsOf = (all: Credential[]) => split(all, me, networks, services.map((s) => s.connection), existingProviders.map((x) => x.connection));
  const may = (c: Credential, mayChange: boolean) => ({ workspaceId: workspace.id, c, mayChange, mayRotate: mayChange && c.kind !== "oauth2" && (c.scope === "workspace" || c.ownerUserId === me), settle });
  const row = (c: Credential, mailbox: boolean, mayChange: boolean) => <Row key={c.id} mailbox={mailbox} {...may(c, mayChange)} />;
  const loaded = (children: (all: Credential[]) => ReactNode) => (
    <QueryBoundary query={credentials} skeleton={<Skeleton className="h-32 w-full" />} messages={MESSAGES}>
      {children}
    </QueryBoundary>
  );
  // Under Advanced the lists wait for the same read; its loading and error show once, above.
  const quiet = (children: (all: Credential[]) => ReactNode) => credentials.data && children(credentials.data);

  return (
    <Page title="Email and keys">
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-col gap-6">
        <section aria-label="Email accounts" className="flex flex-col gap-4 text-base">
          <p className="text-muted-foreground">Each email account here belongs to one person. Direx sends from it only what someone approved.</p>
          {mayConnect && providers.length > 0 && (
            <div className="flex flex-col gap-4">
              {providers.map((provider) => (
                <div key={provider.connection} className="flex flex-col items-start gap-4">
                  <Button
                    variant="outline"
                    aria-expanded={provider.connect === "form" ? open === provider.connection : undefined}
                    pending={starting === provider.connection}
                    onClick={() => void connect(provider)}
                  >
                    {provider.label}
                  </Button>
                  {open === provider.connection && <MailboxForm workspaceId={workspace.id} provider={provider} done={async () => void (await reload())} />}
                </div>
              ))}
            </div>
          )}
          {loaded((all) => {
            const mailboxes = rowsOf(all).mailboxes;
            const waiting = mailboxes.filter((c) => checks.find((k) => k.credentialId === c.id)?.state !== "passed").length;
            return (
              <>
                {waiting > 0 && (
                  <Notice>
                    {waiting === 1
                      ? "1 email account hasn't passed the unsubscribe check, so no cold email goes from it yet. Press Check again on its card below. If it fails again, the line under it says what to fix."
                      : `${waiting} email accounts haven't passed the unsubscribe check, so no cold email goes from them yet. Press Check again on each card below. If one fails again, the line under it says what to fix.`}
                  </Notice>
                )}
                {mailboxes.length > 0 && <WorkspaceZone workspaceId={workspace.id} mayEdit={manage} />}
                {mailboxes.length === 0 ? (
                  <EmptyState title="No email account is connected yet.">{mayConnect ? "Connect one above to send email from it." : undefined}</EmptyState>
                ) : (
                  <ul className="grid items-start gap-3 lg:grid-cols-2">
                    {mailboxes.map((c) => (
                      <MailboxCard
                        key={c.id}
                        workspaceId={workspace.id}
                        c={c}
                        pace={
                        <>
                          <MailboxPace workspaceId={workspace.id} credentialId={c.id} name={c.name} mayEdit={mayConnect && (c.ownerUserId === me || manage)} />
                          <MailboxPause workspaceId={workspace.id} credentialId={c.id} name={c.name} mayPause={mayConnect} mayResume={mayApprove(workspace.role)} />
                          <PlacementJoin workspaceId={workspace.id} credentialId={c.id} name={c.name} me={me} />
                          <Placement workspaceId={workspace.id} credentialId={c.id} name={c.name} />
                        </>
                      }
                        actions={<Actions {...may(c, c.ownerUserId === me || manage)} />}
                        check={checks.find((k) => k.credentialId === c.id)}
                        mayCheck={mayConnect && (c.ownerUserId === me || manage)}
                        again={async () => void (await settle(await checkAgain(workspace.id, c.id)))}
                      />
                    ))}
                  </ul>
                )}
              </>
            );
          })}
        </section>

        <WorkspacePlugins workspace={workspace} />

        {/* A native disclosure: no Astryx component fits a closed "Advanced" block (ADR 0020). */}
        <details
          open={tab !== "mailboxes"}
          className="group rounded-card border border-border bg-card p-6"
          onToggle={(e) => {
            const next: Tab = e.currentTarget.open ? (tab === "mine" ? "mine" : "workspace") : "mailboxes";
            if (next !== tab) {
              setTab(next);
              p.onTab?.(next);
            }
          }}
        >
          <summary className="cursor-pointer font-medium group-open:mb-6">Advanced: API keys</summary>
          <div className="flex flex-col gap-8">
            <section aria-label="Shared with the team" className="flex flex-col gap-4 text-base">
              <h2>Shared with the team</h2>
              <p className="text-muted-foreground">Shared by everyone in this Workspace. Only Owners and Admins can add or change them.</p>
              {quiet((all) => (
                <>
                  {keyed.map((s) => (
                    <ServiceKey key={s.connection} workspaceId={workspace.id} service={s} c={all.find((c) => c.scope === "workspace" && c.connection === s.connection)} manage={manage} settle={settle} />
                  ))}
                  {letters.length > 0 && (
                    <p className="text-muted-foreground">
                      {`${letters.map((s) => s.name).join(", ")}: set up on the `}
                      <Link to="/w/$workspaceId/newsletter" params={{ workspaceId: workspace.id }} className="underline underline-offset-4">
                        Newsletter page
                      </Link>
                      .
                    </p>
                  )}
                  <List
                    rows={rowsOf(all).workspace}
                    empty="No Workspace credential yet."
                    hint={manage ? "Add one with the form below." : "An Owner or Admin can add one."}
                    render={(c) => row(c, false, manage)}
                  />
                </>
              ))}
              {manage && <AddForm title="Add a Workspace credential" scope="workspace" workspaceId={workspace.id} settle={settle} />}
            </section>

            <section aria-label="Only mine" className="flex flex-col gap-4 text-base">
              <h2>Only mine</h2>
              <p className="text-muted-foreground">Yours alone. If you leave this Workspace, nothing uses them.</p>
              {quiet((all) => (
                <List rows={rowsOf(all).mine} empty="You haven't added a credential yet." hint={mayConnect ? "Add one with the form below." : undefined} render={(c) => row(c, false, true)} />
              ))}
              {mayConnect && <AddForm title="Add a credential" scope="user" workspaceId={workspace.id} settle={settle} />}
            </section>
          </div>
        </details>
      </div>
    </Page>
  );
}

/**
 * An email account as a card: its name and state, one line with its unsubscribe check, pace and latest
 * Placement check, its buttons, then the check's warnings, the pace form and the Placement table under Details.
 */
function MailboxCard(p: { workspaceId: string; c: Credential; actions: ReactNode; pace: ReactNode; check: MailboxCheck | undefined; mayCheck: boolean; again: () => Promise<void> }) {
  const { c } = p;
  const check = p.check ?? { state: "unchecked" as const, reason: null, warnings: [] };
  const again = useAction();
  const pace = useQuery(paceQuery(p.workspaceId, c.id)).data?.pace;
  const placement = latestPlacement(useQuery(placementResultsQuery(p.workspaceId, c.id)).data);
  const warnings = check.warnings.filter((w) => CHECK_WARNING[w]);
  return (
    <li aria-label={c.name} className="flex flex-col gap-3 rounded-card border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 break-all font-medium">{c.name}</span>
        <StatusChip tone={statusTone(c.status)}>{STATUS[c.status]}</StatusChip>
      </div>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span>{mailboxCheckWords(check)}</span>
        {pace && <span>Up to {pace.dailyLimit} a day</span>}
        {placement && <span>Latest Placement check, {placement}</span>}
        <span>{c.lastUsedAt ? `Last used ${momentWords(c.lastUsedAt)}` : "Not used yet"}</span>
      </p>
      {p.mayCheck && check.state !== "pending" && check.state !== "passed" && (
        <div>
          <Button size="sm" variant="outline" aria-label={`Check again: ${c.name}`}
            pending={again.pending}
            onClick={() =>
              void again.run(async () => {
                await p.again();
                return null;
              })
            }
          >
            Check again
          </Button>
        </div>
      )}
      {p.actions}
      <details className="group text-sm">
        <summary className="cursor-pointer text-muted-foreground group-open:mb-3" aria-label={`Details: ${c.name}`}>
          Details
        </summary>
        <div className="flex flex-col gap-3">
          {warnings.length > 0 && <p className="text-muted-foreground">{warnings.map((w) => CHECK_WARNING[w]).join(" ")}</p>}
          {p.pace}
        </div>
      </details>
    </li>
  );
}

function List({ rows, empty, hint, render }: { rows: Credential[]; empty: string; hint?: string | undefined; render: (c: Credential) => ReactNode }) {
  return rows.length ? (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>Name</TableHeaderCell>
          <TableHeaderCell>Type</TableHeaderCell>
          <TableHeaderCell>Status</TableHeaderCell>
          <TableHeaderCell>Last used</TableHeaderCell>
          <TableHeaderCell>
            <span className="sr-only">Actions</span>
          </TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>{rows.map(render)}</TableBody>
    </Table>
  ) : (
    <EmptyState title={empty}>{hint}</EmptyState>
  );
}

type Settle = (code: string | null) => Promise<boolean>;

type Can = { workspaceId: string; c: Credential; mayChange: boolean; mayRotate: boolean; settle: Settle };

/** A Workspace's own OAuth app, kept as a username and password: its client id and client secret. */
const ownApp = (c: Credential) => c.scope === "workspace" && c.kind === "basic" && c.key.startsWith("oauth_app:");

function Row(p: Can & { mailbox: boolean }) {
  const { c } = p;
  const kind = c.kind === "oauth2" ? (p.mailbox ? "Email account" : "Access you granted") : ownApp(c) ? "Own app" : KINDS[c.kind as Kind].label;
  // A typed key is saved as typed: Direx keeps no test of it, so "active" only means it hasn't been revoked.
  const unchecked = c.kind !== "oauth2" && c.status === "active";
  return (
    <TableRow>
      <TableCell className="font-medium">{c.name}</TableCell>
      <TableCell>{kind}</TableCell>
      <TableCell>
        <StatusChip tone={unchecked ? "off" : statusTone(c.status)}>{unchecked ? "Not checked" : STATUS[c.status]}</StatusChip>
      </TableCell>
      <TableCell className="text-muted-foreground">{c.lastUsedAt ? `Last used ${momentWords(c.lastUsedAt)}` : "Not used yet"}</TableCell>
      <TableCell className="whitespace-normal">
        <Actions {...p} />
      </TableCell>
    </TableRow>
  );
}

/** History, Disconnect or Delete, and Replace for a key, each naming the credential. */
function Actions({ workspaceId, c, mayChange, mayRotate, settle }: Can) {
  const [events, setEvents] = useState<AccessEvent[]>();
  const [value, setValue] = useState("");
  const replace = useAction();

  async function toggleHistory() {
    if (events) return setEvents(undefined);
    const r = await history(workspaceId, c.id);
    if (typeof r === "string") await settle(r);
    else setEvents(r);
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" aria-label={`${events ? "Hide history" : "History"} of ${c.name}`} aria-expanded={!!events} onClick={() => void toggleHistory()}>
          {events ? "Hide history" : "History"}
        </Button>
        {mayChange && (
          <Confirm
            title={`${c.kind === "oauth2" ? "Disconnect" : "Delete"} ${c.name}?`}
            body="Direx can't use it after this. Anything that needs it waits until it's connected again."
            confirm={c.kind === "oauth2" ? "Disconnect" : "Delete"}
            onConfirm={async () => settle(await remove(workspaceId, c.id))}
            trigger={
              <Button size="sm" variant="outline" aria-label={`${c.kind === "oauth2" ? "Disconnect" : "Delete"} ${c.name}`}>
                {c.kind === "oauth2" ? "Disconnect" : "Delete"}
              </Button>
            }
          />
        )}
      </div>
      {mayRotate && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const v = value;
            setValue("");
            await replace.run(async () => {
              await settle(await rotate(workspaceId, c, v));
              return null;
            });
          }}
        >
          <Field label={ownApp(c) ? "New client secret" : `New ${KINDS[c.kind as Kind].value.label.toLowerCase()}`}>
            <Secret value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Button type="submit" size="sm" variant="outline" aria-label={`Replace ${c.name}`} pending={replace.pending}>
            Replace
          </Button>
        </form>
      )}
      {events && (
        <ol className="flex max-h-64 flex-col gap-1 overflow-y-auto pl-4 text-sm text-muted-foreground">
          {events.map((e, i) => (
            <li key={i}>
              {momentWords(e.at)}: {e.consumer}, {e.outcome}
              {e.errorCode && ` (${e.errorCode})`}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** What a key check found: a verification service's credits, or a newsletter list's name and size. */
export function checkWords(name: string, r: KeyCheck): string {
  if ("remainingCredits" in r) return `The key works. ${name} says ${r.remainingCredits} checks are left.`;
  const people = `${r.subscriberCount} ${r.subscriberCount === 1 ? "subscriber" : "subscribers"}`;
  const readOnly = r.canSend ? "" : ` Direx can read your subscribers. To send issues from Direx, ${name} needs its Pro plan.`;
  return `The key works. ${r.listName} has ${people}.${readOnly}`;
}

/**
 * One service a plugin reaches with the Workspace's API key: whether a key is saved, and for an
 * Owner or Admin a way to save, replace, check or remove it. The key is never shown.
 */
export function ServiceKey({ workspaceId, service, c, manage, settle }: { workspaceId: string; service: KeyService; c?: Credential; manage: boolean; settle: Settle }) {
  const [value, setValue] = useState("");
  const [checked, setChecked] = useState<string>();
  const save = useAction();
  const test = useAction();

  async function check() {
    setChecked(undefined);
    const r = await checkKey(workspaceId, service.connection);
    if ("error" in r) setChecked(message(r.error));
    else toast.add({ title: checkWords(service.name, r) });
    return null;
  }

  return (
    <section aria-label={service.name} className="flex flex-col gap-3 rounded-card border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-md font-medium tracking-tight">{service.name}</h2>
        <StatusChip tone={c ? statusTone(c.status) : "off"}>{c ? (c.status === "active" ? "Connected" : STATUS[c.status]) : "Not connected"}</StatusChip>
      </div>
      {manage && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const v = value;
            setValue("");
            setChecked(undefined);
            await save.run(async () => {
              await settle(await (c ? replaceKey : connectKey)(workspaceId, service.connection, v));
              return null;
            });
          }}
        >
          <Field label={c ? "New API key" : "API key"}>
            <Secret value={value} onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Button type="submit" variant={c ? "outline" : "default"} aria-label={`${c ? "Replace" : "Connect"} ${service.name}`} pending={save.pending}>
            {c ? "Replace" : "Connect"}
          </Button>
        </form>
      )}
      {manage && c && (
        <div className="flex flex-wrap gap-2">
          {service.canCheck && (
            <Button size="sm" variant="outline" aria-label={`Check the ${service.name} key`} pending={test.pending} onClick={() => void test.run(check)}>
              Check the key
            </Button>
          )}
          <Confirm
            title={`Disconnect ${service.name}?`}
            body="Direx can't use it after this. Anything that needs it waits until it's connected again."
            confirm="Disconnect"
            onConfirm={async () => settle(await remove(workspaceId, c.id))}
            trigger={
              <Button size="sm" variant="outline" aria-label={`Disconnect ${service.name}`}>
                Disconnect
              </Button>
            }
          />
        </div>
      )}
      {checked && <Notice>{checked}</Notice>}
    </section>
  );
}

function AddForm({ title, scope, workspaceId, settle }: { title: string; scope: "workspace" | "user"; workspaceId: string; settle: Settle }) {
  const blank = { kind: "api_key" as Kind, key: "", name: "", meta: "" };
  const [f, setF] = useState(blank);
  const [value, setValue] = useState("");
  const save = useAction();
  const k = KINDS[f.kind];

  return (
    <form
      aria-label={title}
      className="flex flex-col gap-4 rounded-card border border-border bg-card p-6"
      onSubmit={async (e) => {
        e.preventDefault();
        const v = value;
        setValue("");
        await save.run(async () => {
          if (await settle(await add(workspaceId, { ...f, scope, value: v }))) setF(blank);
          return null;
        });
      }}
    >
      <h2 className="text-md font-medium tracking-tight">{title}</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kind">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Kind })}>
            {(Object.keys(KINDS) as Kind[]).map((kind) => (
              <option key={kind} value={kind}>
                {KINDS[kind].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Name">
          <Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Reference">
          <Input required autoComplete="off" spellCheck={false} title="Letters, numbers and . _ : - only. Plugins and settings refer to it by this." pattern="[A-Za-z0-9_.:\-]{1,100}" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />
        </Field>
        {k.meta && (
          <Field label={k.meta.label}>
            <Input required value={f.meta} onChange={(e) => setF({ ...f, meta: e.target.value })} />
          </Field>
        )}
        <Field label={k.value.label}>
          <Secret value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
      </div>
      <div>
        <Button type="submit" pending={save.pending}>
          Save
        </Button>
      </div>
    </form>
  );
}

/** Asks for what the provider says it needs, then signs in before anything is saved. */
export function MailboxForm(p: { workspaceId: string; provider: MailboxProvider; done: () => Promise<void> }) {
  const fields = p.provider.fields ?? [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setOutcome(undefined);
    const settings = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
    const r = await connectWithForm(p.workspaceId, p.provider.connection, { username, password, settings });
    setBusy(false);
    if ("error" in r) return setOutcome(r.detail ? `Nothing was saved. ${r.detail}` : message(r.error));
    setPassword("");
    const sent = r.hasSent === false ? " We couldn't find a Sent folder, so if a send is ever cut off, you'll be asked to check it yourself." : "";
    setOutcome(`Connected.${sent} ${r.check ? mailboxCheckWords(r.check as Pick<MailboxCheck, "state" | "reason">) : CHECK_STATE.unchecked}`);
    await p.done();
  }

  return (
    <form className="flex w-full max-w-xl flex-col gap-4 rounded-card border border-border p-4" onSubmit={(e) => void submit(e)}>
      {p.provider.presets && (
        <Field label="Mail service">
          <Select defaultValue="" onChange={(e) => setValues({ ...values, ...p.provider.presets?.find((x) => x.label === e.target.value)?.values })}>
            <option value="">Other</option>
            {p.provider.presets.map((x) => (
              <option key={x.label}>{x.label}</option>
            ))}
          </Select>
        </Field>
      )}
      {fields.map((f) => (
        <Field key={f.name} label={f.label}>
          <Input required={!f.optional} autoComplete="off" spellCheck={false} value={values[f.name] ?? ""} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
        </Field>
      ))}
      <Field label="Sign-in name, usually your email address">
        <Input required autoComplete="username" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
      </Field>
      <Field label="App password">
        <Secret value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <p className="text-sm text-muted-foreground">
        When you connect, Direx sends one test email to {username || "this email account"} to check that your email provider leaves unsubscribe links unchanged. The unsubscribe link in that test does nothing.
        Until the check passes, cold email from this email account waits. The check can't catch a provider that changes only email sent to other people.
      </p>
      <div>
        <Button type="submit" pending={busy}>
          {busy ? "Signing in" : "Sign in and save"}
        </Button>
      </div>
      {outcome && <Notice>{outcome}</Notice>}
    </form>
  );
}
