// SPDX-License-Identifier: AGPL-3.0-only
import { Confirm } from "../components/Confirm";
import { StatusChip, statusTone } from "../components/StatusChip";
import { ChannelMark, channelOf } from "../components/ChannelMark";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { inWorkspace } from "../api/query";
import { messageForCode } from "../api/messages";
import { EmptyState, Field, Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Table, TableBody, TableCell, TableRow } from "@astryxdesign/core/Table";
import { startConnect } from "../credentials/actions";
import { dayWords } from "../seo/actions";
import { Secret } from "../credentials/Credentials";
import { Wizard } from "./Wizard";
import { SignIn } from "../identity/SignIn";
import {
  accountsQuery,
  addTargets,
  connectForm,
  disconnect,
  linksQuery,
  lowerLimits,
  makeLink,
  markEstablished,
  networksQuery,
  reportRemoved,
  saveAbout,
  saveApp,
  targets as loadTargets,
  unpause,
  type Account,
  type ConnectLink,
  type Network,
  type Target,
} from "./actions";

type S = components["schemas"];

const MESSAGES: Record<string, string> = {
  unknown_connection: "Direx isn't set up to connect that network yet.",
  denied: "The connection was cancelled. Nothing was saved.",
  missing_scope: "The network didn't grant everything Direx asked for. Connect again and allow it all.",
  no_refresh_token: "The network didn't let Direx stay connected. Connect again.",
  identity_failed: "The network didn't say which account this is. Nothing was saved. Try again.",
  exchange_failed: "The network didn't finish the connection. Try again in a minute.",
  expired: "The connect link expired. Start again.",
  state_mismatch: "That connect attempt didn't match this browser. Start again.",
  bad_cookie: "That connect attempt didn't match this browser. Start again.",
  wrong_user: "You came back signed in as someone else. Sign in as the person who started, then start again.",
  not_member: "You're no longer a member of that Workspace.",
  duplicate_key: "This Workspace already has an app for that network.",
  unknown_target: "The network doesn't offer that account to this login. Reload and try again.",
  angle_required: "Say what this account is for. This network allows several accounts only when each has its own purpose.",
  too_many_links: "You have five open links for this network. Use one, or wait 15 minutes for them to expire.",
  not_at_floor: "Only an account still at its starting limit, and not paused, can start higher.",
};
const message = (code: string) => messageForCode(code, MESSAGES);

const AVAILABILITY: Record<Network["availability"], string> = {
  available: "Available",
  awaiting_approval: "Waiting for the network to approve Direx",
  not_built: "Coming later",
  not_available: "Not available",
};
/** A network connected by a form or through the Workspace's own app needs no platform to approve Direx's app, so it reads as open. */
const availabilityWords = (n: Network) => (n.canConnect && n.availability === "awaiting_approval" && (n.connect === "form" || n.app === "own") ? (n.app === "own" ? "Through your own app" : "Available") : AVAILABILITY[n.availability]);
const STATUS: Record<string, string> = { active: "Working", needs_reauth: "Reconnect needed", revoked: "Revoked" };
const SUMMARY = "cursor-pointer font-medium";
const FEATURE: Record<string, string> = { publish: "posts", links: "links", follow_ups: "follow-up comments", video: "video", image: "images", analytics: "stats", comments: "comments" };
const CAN_DO: Record<Account["canDo"][number]["status"], string> = { available: "Can use", coming: "Coming later", needs_own_app: "Needs your own app (advanced)", reconnect: "Reconnect to turn on" };
/** What an account can do, one group per status in a fixed order: "Can use: posts, links. Coming later: video." */
const canDoWords = (canDo: Account["canDo"]) =>
  (Object.keys(CAN_DO) as (keyof typeof CAN_DO)[])
    .map((status) => [status, canDo.filter((c) => c.status === status).map((c) => FEATURE[c.feature] ?? c.feature)] as const)
    .filter(([, features]) => features.length)
    .map(([status, features]) => `${CAN_DO[status]}: ${features.join(", ")}.`)
    .join(" ");
/** One health chip: the login's status, or a pause when the login works but posting is stopped. */
const healthChip = (a: Account) => (a.status === "active" && a.health.paused ? <StatusChip tone="attention">Posting paused</StatusChip> : <StatusChip tone={statusTone(a.status)}>{STATUS[a.status] ?? a.status}</StatusChip>);

/** What is connected, whether it still works, what it can do, and every network Direx knows of. */
export function Social(p: { workspace: S["MyWorkspace"]; me: string; notice?: string; connected?: string; networks?: Network[]; accounts?: Account[]; offered?: Target[]; links?: ConnectLink[] }) {
  const { workspace } = p;
  const manage = workspace.role === "owner" || workspace.role === "admin";
  const mayConnect = workspace.role !== "viewer";
  const mayApprove = manage || workspace.role === "marketer";
  const client = useQueryClient();
  // Props seed the page all at once (tests, a server render): a list not given is then empty.
  const seeded = p.networks ?? p.accounts ?? p.offered;
  const networks = useQuery({ ...networksQuery(workspace.id), initialData: p.networks ?? (seeded ? [] : undefined) });
  const accounts = useQuery({ ...accountsQuery(workspace.id), initialData: p.accounts ?? (seeded ? [] : undefined) });
  const links = useQuery({ ...linksQuery(workspace.id), enabled: workspace.role !== "viewer", initialData: p.links ?? (seeded ? [] : undefined) });
  const [offered, setOffered] = useState(p.offered ?? []);
  const [login, setLogin] = useState(p.connected);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState(p.notice && message(p.notice));
  const [stepUp, setStepUp] = useState(false);
  const [starting, setStarting] = useState<string>();
  const [confirming, setConfirming] = useState<string | null>(null);

  const reload = () => client.invalidateQueries({ queryKey: inWorkspace(workspace.id) });
  // A login with one account adds it on this call, so only a choice stays on screen.
  useEffect(() => {
    if (!login) return;
    void loadTargets(workspace.id, login).then(async (t) => {
      setOffered(t.filter((x) => !x.added));
      await client.invalidateQueries({ queryKey: accountsQuery(workspace.id).queryKey });
    });
  }, [workspace.id, login, client]);

  async function settle(code: string | null) {
    if (code === "step_up_required") {
      setStepUp(true);
      return false;
    }
    setError(code ? message(code) : undefined);
    await reload();
    return code === null;
  }

  async function connect(n: Network) {
    if (n.connect === "form") return setOpen(open === n.connection ? null : n.connection);
    if (confirming !== n.connection) return setConfirming(n.connection);
    setStarting(n.connection);
    const r = await startConnect(workspace.id, n.connection).finally(() => setStarting(undefined));
    if ("url" in r) location.assign(r.url);
    else setError(message(r.error));
  }

  /** What a person can do for a network they may connect: add another account, connect one, and say yes before leaving for the network. */
  const actions = (n: Network) => (
    <div className="flex flex-col items-start gap-3">
      {(accounts.data ?? []).some((a) => a.connection === n.connection) ? (
        <AddAnother
          network={n}
          starting={starting === n.connection}
          connectHere={() => void connect(n)}
          link={async () => {
            const r = await makeLink(workspace.id, n.connection);
            if ("url" in r) {
              await client.invalidateQueries({ queryKey: linksQuery(workspace.id).queryKey });
              return r;
            }
            await settle(r.error);
            return null;
          }}
          links={(links.data ?? []).filter((l) => l.connection === n.connection)}
          finish={(credentialId) => setLogin(credentialId)}
        />
      ) : (
        <Button size="sm" variant="outline" aria-expanded={n.connect === "form" ? open === n.connection : confirming === n.connection} onClick={() => (n.connect === "form" ? void connect(n) : setConfirming(confirming === n.connection ? null : n.connection))}>
          Connect {n.label}
        </Button>
      )}
      {confirming === n.connection && n.connect === "oauth" && (
        <div role="group" aria-label={`Before you connect ${n.label}`} className="flex max-w-prose flex-col gap-2 rounded-card bg-muted p-4 text-sm">
          <p>
            <strong>Direx will:</strong> post only what you approve.
          </p>
          <p>
            <strong>Direx won't:</strong> send DMs, follow, or delete posts.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" pending={starting === n.connection} onClick={() => void connect(n)}>
              Continue to {n.label}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {open === n.connection && n.connect === "form" && (
        <SignInForm
          network={n}
          send={async (f) => {
            const r = await connectForm(workspace.id, n.connection, f);
            if ("credentialId" in r) {
              setOpen(null);
              setLogin(r.credentialId);
              return;
            }
            return r.detail ?? message(r.error);
          }}
        />
      )}
    </div>
  );

  if (stepUp) return <SignIn title="Confirm it's you" note="This change needs a recent sign-in. Sign in again, then make the change once more." callbackURL={location.pathname + location.search} />;

  return (
    <Page title="Social accounts" description="Direx posts to these accounts only what someone approved.">
      {error && <Notice tone="error">{error}</Notice>}

      {offered.length > 0 && login && (
        <Picker
          targets={offered}
          add={async (ids, about) => {
            if (await settle(await addTargets(workspace.id, login, ids, about))) {
              setOffered([]);
              setLogin(undefined);
            }
          }}
        />
      )}

      <Section title="Connected">
        <QueryBoundary query={accounts} skeleton={<Skeleton className="h-24 w-full" />} messages={MESSAGES}>
          {(list) =>
            list.length ? (
              <ul className="flex flex-col gap-3" aria-label="Connected accounts">
                  {list.map((a) => (
                    <AccountCard
                      key={a.id}
                      a={a}
                      mine={a.ownerUserId === p.me}
                      manage={manage}
                      remove={async () => void (await settle(await disconnect(workspace.id, a.credentialId)))}
                      about={async (b) => void (await settle(await saveAbout(workspace.id, a.id, b)))}
                      established={async () => void (await settle(await markEstablished(workspace.id, a.id)))}
                      health={
                        mayApprove
                          ? {
                              unpause: async () => void (await settle(await unpause(workspace.id, a.id))),
                              removed: async () => void (await settle(await reportRemoved(workspace.id, a.id, null))),
                              lower: async (limits) => void (await settle(await lowerLimits(workspace.id, a.id, limits))),
                            }
                          : null
                      }
                    />
                  ))}
              </ul>
            ) : (
              <EmptyState title="No account is connected yet.">{mayConnect ? "Connect one from the networks below." : undefined}</EmptyState>
            )
          }
        </QueryBoundary>
      </Section>

      <Section title="Networks">
        <QueryBoundary query={networks} skeleton={<Skeleton className="h-48 w-full" />} messages={MESSAGES}>
          {(list) => {
            const ready = list.filter((n) => n.canConnect);
            // A network this server connects through the person's own app is set up below, not waited for.
            const own = list.filter((n) => n.wizard);
            const later = list.filter((n) => !n.canConnect && !n.wizard);
            const rows = (shown: Network[]) => (
              <Table>
                <TableBody>
                  {shown.map((n) => (
                    <TableRow key={n.connection}>
                      <TableCell className="font-medium">{n.label}</TableCell>
                      <TableCell className="text-muted-foreground">{availabilityWords(n)}</TableCell>
                      <TableCell className="whitespace-normal">{mayConnect && n.canConnect && actions(n)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            );
            return (
              <>
                <h3 className="font-medium">Ready to connect</h3>
                {ready.length ? rows(ready) : <p className="text-muted-foreground">No network can be connected yet.</p>}
                {own.length > 0 && (
                  <>
                    <h3 className="font-medium">Set up with your own app</h3>
                    <p className="text-sm text-muted-foreground">This server connects these networks through an app you register with each one.</p>
                    <div className="flex flex-col gap-3">
                      {manage ? own.map((n) => <Wizard key={n.connection} label={n.label} wizard={n.wizard!} callbackProblem={n.callbackProblem} save={async (f) => void (await settle(await saveApp(workspace.id, n, f)))} />) : <p className="text-sm text-muted-foreground">An Owner or Admin can set these up: {own.map((n) => n.label).join(", ")}.</p>}
                    </div>
                  </>
                )}
                {later.length > 0 && (
                  <details>
                    <summary className={SUMMARY}>{`Coming later (${later.length})`}</summary>
                    <div className="mt-3">{rows(later)}</div>
                  </details>
                )}
              </>
            );
          }}
        </QueryBoundary>
      </Section>
    </Page>
  );
}

type HealthActions = { unpause: () => Promise<void>; removed: () => Promise<void>; lower: (l: { posts?: number; links?: number }) => Promise<void> };

/** A pause and its Lift, then the daily budget and the account's settings behind one disclosure. The budget lowers the risk of a restriction; it can't rule one out. */
function HealthLine({ name, h, act, children }: { name: string; h: Account["health"]; act: HealthActions | null; children?: ReactNode }) {
  const [posts, setPosts] = useState(h.budget.posts);
  const [links, setLinks] = useState(h.budget.links);
  const [pending, setPending] = useState<"lift" | "lower">();
  const during = (which: "lift" | "lower", work: Promise<void>) => {
    setPending(which);
    void work.finally(() => setPending(undefined));
  };
  return (
    <>
      {h.paused && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm font-medium">Paused: {h.paused.detail ?? h.paused.reason}. Posts wait until a person lifts the pause.</p>
          {act && (
            <Button size="sm" aria-label={`Lift the pause on ${name}`} pending={pending === "lift"} onClick={() => during("lift", act.unpause())}>
              Lift the pause
            </Button>
          )}
        </div>
      )}
      <details className="text-sm">
        <summary className={SUMMARY} aria-label={`Limits and settings for ${name}`}>
          Limits and settings
        </summary>
        <div className="mt-3 flex flex-col items-start gap-3">
          <p className="text-muted-foreground">
            Direx keeps each account under a daily budget, here {h.budget.posts} posts and {h.budget.links} links, to lower the risk of a restriction.
          </p>
          {act && (
            <>
              {!h.paused && (
                <Confirm
                  title={`Report a removed post or restriction on ${name}?`}
                  body="Direx pauses posting to this account until someone turns it back on."
                  confirm="Report and pause"
                  onConfirm={act.removed}
                  trigger={
                    <Button size="sm" variant="outline" aria-label={`A post was removed or the account restricted: ${name}`}>
                      A post was removed or the account restricted
                    </Button>
                  }
                />
              )}
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(e: FormEvent) => {
                  e.preventDefault();
                  during("lower", act.lower({ posts, links }));
                }}
              >
                <Field label="Posts a day">
                  <Input type="number" min={0} max={h.budget.posts} value={posts} onChange={(e) => setPosts(Number(e.target.value))} className="w-28" />
                </Field>
                <Field label="Links a day">
                  <Input type="number" min={0} max={h.budget.links} value={links} onChange={(e) => setLinks(Number(e.target.value))} className="w-28" />
                </Field>
                <Button type="submit" size="sm" variant="outline" aria-label={`Lower the limit for ${name}`} pending={pending === "lower"}>
                  Lower the limit
                </Button>
              </form>
            </>
          )}
          {children}
        </div>
      </details>
    </>
  );
}

const LINK_STATUS: Record<ConnectLink["status"], string> = {
  open: "Waiting to be opened",
  claimed: "Being connected",
  connected: "Connected",
  failed: "Used, nothing connected",
  expired: "Expired",
};

/** A second account on a network: here, if this browser can sign in to it, or through a link opened where it is signed in. */
function AddAnother(p: {
  network: Network;
  starting: boolean;
  connectHere: () => void;
  link: () => Promise<{ url: string; expiresAt: string } | null>;
  links: ConnectLink[];
  finish: (credentialId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [made, setMade] = useState<{ url: string; expiresAt: string } | null>(null);
  const [making, setMaking] = useState(false);
  const [copied, setCopied] = useState(false);
  const n = p.network;
  return (
    <div className="flex flex-col items-start gap-2">
      <Button size="sm" variant="outline" aria-expanded={open} onClick={() => setOpen(!open)}>
        Add another {n.label} account
      </Button>
      {open && (
        <div className="flex max-w-prose flex-col gap-3 text-sm">
          {n.connect === "oauth" && (
            <p className="text-muted-foreground">
              Direx connects whichever {n.label} account this browser is signed in to. Log out of {n.label} or use a private window, or make a link to open where the other account is signed in.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" pending={p.starting} onClick={p.connectHere}>
              Connect here
            </Button>
            {n.connect === "oauth" && (
              <Button
                size="sm"
                variant="outline"
                pending={making}
                onClick={() => {
                  setMaking(true);
                  void p
                    .link()
                    .then(setMade)
                    .finally(() => setMaking(false));
                }}
              >
                Make a link for whoever is signed in to that account
              </Button>
            )}
          </div>
          {made && (
            <div className="flex flex-col gap-2">
              <Field label="Connect link">
                <Input readOnly value={made.url} onFocus={(e) => e.currentTarget.select()} />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(made.url).then(() => setCopied(true))}>
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <span className="text-muted-foreground">Works once, until {new Date(made.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Then come back here to finish.</span>
              </div>
            </div>
          )}
        </div>
      )}
      {p.links.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label={`Your ${n.label} connect links`}>
          {p.links.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2">
              <span>
                {LINK_STATUS[l.status]}
                {l.accountName ? `: ${l.accountName}` : ""}
              </span>
              {l.status === "connected" && l.credentialId && (
                <Button size="sm" onClick={() => p.finish(l.credentialId!)}>
                  Finish adding {l.accountName ?? "it"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Shown only beside the Workspace's other accounts on the same network: where this one says who runs it, and what it is for. */
function About({ a, save }: { a: Account; save: (b: { runBy: string | null; angle: string | null }) => Promise<void> }) {
  const [runBy, setRunBy] = useState(a.runBy ?? "");
  const [angle, setAngle] = useState(a.angle ?? "");
  const [pending, setPending] = useState(false);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setPending(true);
        void save({ runBy: runBy.trim() || null, angle: angle.trim() || null }).finally(() => setPending(false));
      }}
    >
      <Field label="Run by" hint="Where the account itself names the brand, such as its bio">
        <Input value={runBy} maxLength={200} onChange={(e) => setRunBy(e.target.value)} className="w-64" />
      </Field>
      {a.asksAngle && (
        <Field label="Angle" hint="What this account is for, beside the others">
          <Input value={angle} maxLength={200} onChange={(e) => setAngle(e.target.value)} className="w-64" />
        </Field>
      )}
      <Button type="submit" size="sm" variant="outline" aria-label={`Save who runs ${a.name}`} pending={pending}>
        Save
      </Button>
    </form>
  );
}

/** One connected account: what it is and whether it works, what it can do today, and the rest behind Limits and settings. */
function AccountCard({
  a,
  mine,
  manage,
  remove,
  health,
  about,
  established,
}: {
  a: Account;
  mine: boolean;
  manage: boolean;
  remove: () => Promise<void>;
  health: HealthActions | null;
  about: (b: { runBy: string | null; angle: string | null }) => Promise<void>;
  established: () => Promise<void>;
}) {
  const [marking, setMarking] = useState(false);
  const h = a.health;
  return (
    <li className="flex flex-col items-start gap-2 rounded-card border border-border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <ChannelMark channel={channelOf(a.connection)} />
        <h3 className="font-medium">{a.name}</h3>
        <span className="text-sm text-muted-foreground">{a.network}</span>
        {healthChip(a)}
      </div>
      <p className="text-sm text-muted-foreground">
        {canDoWords(a.canDo)} Today: {h.used.posts} of {h.budget.posts} posts, {h.used.links} of {h.budget.links} links.
        {a.warning && <strong className="text-foreground"> Reconnect by {dayWords(a.warning.endsAt.slice(0, 10))}.</strong>}
      </p>
      {a.ownAppLimits.length > 0 && (
        <ul className="text-sm text-muted-foreground">
          {a.ownAppLimits.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      <HealthLine name={a.name} h={h} act={health}>
        {(mine || manage) && a.establishable && (
          <Button
            size="sm"
            variant="link"
            className="h-auto px-0"
            aria-label={`${a.name} is an established account`}
            pending={marking}
            onClick={() => {
              setMarking(true);
              void established().finally(() => setMarking(false));
            }}
          >
            This is an established account (older than 6 months, already posting)
          </Button>
        )}
        {(mine || manage) && a.siblings > 0 && <About a={a} save={about} />}
        {(mine || manage) && (
          <Confirm
            title={`Disconnect ${a.name}?`}
            body="Direx can't post to it or read its stats after this."
            confirm="Disconnect"
            onConfirm={remove}
            trigger={
              <Button size="sm" variant="outline" aria-label={`Disconnect ${a.name}`}>
                Disconnect
              </Button>
            }
          />
        )}
      </HealthLine>
    </li>
  );
}

type PickedAbout = { established?: string[]; angles?: Record<string, string> };

/** Picking is what adds an account, so it is also where a person says whether it is new, and its angle where the network asks. */
function Picker({ targets, add }: { targets: Target[]; add: (ids: string[], about: PickedAbout) => Promise<void> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [established, setEstablished] = useState<string[]>([]);
  const [angles, setAngles] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  const missingAngle = targets.some((t) => t.needsAngle && picked.includes(t.id) && !angles[t.id]?.trim());
  return (
    <form
      aria-label="Which accounts should Direx post to?"
      className="flex flex-col gap-4 rounded-card border border-border bg-card p-6"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setPending(true);
        const older = established.filter((id) => picked.includes(id));
        const stated = Object.fromEntries(Object.entries(angles).filter(([id, a]) => picked.includes(id) && a.trim()));
        void add(picked, { ...(older.length ? { established: older } : {}), ...(Object.keys(stated).length ? { angles: stated } : {}) }).finally(() => setPending(false));
      }}
    >
      <h2>Which accounts should Direx post to?</h2>
      <div className="flex flex-col gap-3">
        {targets.map((t) => (
          <div key={t.id} className="flex flex-col gap-1">
            <label className="flex min-h-9 items-center gap-2">
              <input type="checkbox" className="size-4 accent-primary" checked={picked.includes(t.id)} onChange={(e) => setPicked(toggle(picked, t.id, e.target.checked))} /> {t.name}
            </label>
            {picked.includes(t.id) && (
              <div className="ml-6 flex flex-col gap-2">
                <label className="flex min-h-9 items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-primary" checked={established.includes(t.id)} onChange={(e) => setEstablished(toggle(established, t.id, e.target.checked))} />
                  {`${t.name} is established: older than 6 months and already posting. It starts with a higher daily limit.`}
                </label>
                {t.needsAngle && (
                  <Field label={`What is ${t.name} for?`} hint="This network allows several accounts only when each has its own purpose, such as pricing tips">
                    <Input value={angles[t.id] ?? ""} maxLength={200} required onChange={(e) => setAngles({ ...angles, [t.id]: e.target.value })} className="w-72" />
                  </Field>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div>
        <Button type="submit" disabled={!picked.length || missingAngle} pending={pending}>
          Add
        </Button>
      </div>
    </form>
  );
}

function SignInForm({ network, send }: { network: Network; send: (f: { username: string; password: string }) => Promise<string | undefined> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [refused, setRefused] = useState<string>();
  const [pending, setPending] = useState(false);
  const label = (name: string) => network.fields?.find((f) => f.name === name)?.label ?? name;
  return (
    <form
      className="flex w-full max-w-md flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        // Said here, beside the button, or a refusal looks like nothing happened.
        setPending(true);
        setRefused(await send({ username, password }).finally(() => setPending(false)));
        setPassword("");
      }}
    >
      <Field label={label("username")}>
        <Input required autoComplete="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
      </Field>
      <Field label={label("password")}>
        <Secret value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      <div>
        <Button type="submit" size="sm" pending={pending}>
          Connect
        </Button>
      </div>
      {refused && <Notice tone="error">{refused}</Notice>}
    </form>
  );
}
