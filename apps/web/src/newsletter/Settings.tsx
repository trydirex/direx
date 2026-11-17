// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { messageFor } from "../api/messages";
import { inWorkspace } from "../api/query";
import { EmptyState, Field, Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Input, Select, timeZones } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Switch } from "@astryxdesign/core/Switch";
import { toast } from "@/components/toast";
import { useAction } from "../components/useAction";
import { Button } from "@/components/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { SignIn } from "../identity/SignIn";
import { checkKey, connectKey, credentialsQuery } from "../credentials/actions";
import { checkWords, message, ServiceKey } from "../credentials/Credentials";
import type { Item, Role } from "../items/actions";
import { StateChip } from "../items/StateChip";
import { dayWords } from "../campaigns/actions";
import { accountListsQuery, clickRate, chooseList, issuesQuery, loadIssues, type IssueSummary, type IssuesPage, MESSAGES, saveSettings, say, settingsQuery, slotWords, WEEKDAYS, type AccountList, type SettingsPage } from "./actions";

const SUBSTACK = "substack";
const DONE = new Set<string>(["sent", "applied", "cancelled"]);

/**
 * Which tool and list the weekly issue goes to, and when. Setting up asks in order: the tool, its API
 * key when it isn't connected yet, the list when the account holds several, then the slot. Only an
 * Admin or Owner changes it; everyone sees it.
 */
export function Settings(p: { workspaceId: string; role: Role; initial?: SettingsPage; initialLists?: AccountList[] }) {
  const query = useQuery({ ...settingsQuery(p.workspaceId), initialData: p.initial });
  const [error, setError] = useState<string>();
  return (
    <Page title="Newsletter">
      {error && <Notice tone="error">{error}</Notice>}
      <Issues workspaceId={p.workspaceId} />
      <QueryBoundary query={query} skeleton={<Skeleton className="h-64 w-full" />} messages={MESSAGES}>
        {(data) => <Setup {...p} data={data} setError={setError} />}
      </QueryBoundary>
    </Page>
  );
}

/** The next issue and the ones already sent, each opening the issue itself. Older pages load on Show more. */
function Issues({ workspaceId }: { workspaceId: string }) {
  const query = useQuery(issuesQuery(workspaceId));
  const [more, setMore] = useState<IssuesPage>();
  const [loading, setLoading] = useState(false);
  return (
    <Section title="Issues">
      <QueryBoundary query={query} skeleton={<Skeleton className="h-24 w-full" />} messages={MESSAGES}>
        {(first) => {
          const list = [...first.issues, ...(more?.issues ?? [])];
          const after = more ? more.next : first.next;
          const showMore = async () => {
            if (!after) return;
            setLoading(true);
            const r = await loadIssues(workspaceId, after).finally(() => setLoading(false));
            setMore({ issues: [...(more?.issues ?? []), ...r.issues], next: r.next });
          };
          // Newest slot first, so the next issue is the last one still open.
          const next = list.filter((i) => !DONE.has(i.state)).at(-1);
          const sent = list.filter((i) => i.state === "sent" || i.state === "applied");
          if (!next && !sent.length) return <EmptyState title="No issues yet">Each issue's draft appears here two days before it goes out.</EmptyState>;
          return (
            <>
              {next && (
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-muted-foreground">Next issue</h3>
                  <IssueRow workspaceId={workspaceId} issue={next} when={`Goes out ${dayWords(next.slot.slice(0, 10))}`} />
                </div>
              )}
              {sent.length > 0 && (
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium text-muted-foreground">Sent</h3>
                  <ul className="flex flex-col gap-2">
                    {sent.map((i) => (
                      <li key={i.itemId}>
                        <IssueRow workspaceId={workspaceId} issue={i} when={`Sent ${dayWords((i.sentAt ?? i.slot).slice(0, 10))}`} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {after && (
                <div>
                  <Button variant="outline" pending={loading} onClick={() => void showMore()}>
                    Show more
                  </Button>
                </div>
              )}
            </>
          );
        }}
      </QueryBoundary>
    </Section>
  );
}

function IssueRow({ workspaceId, issue, when }: { workspaceId: string; issue: IssueSummary; when?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Link to="/w/$workspaceId/newsletter/$issueId" params={{ workspaceId, issueId: issue.itemId }} className="font-medium underline-offset-4 hover:underline">
        {issue.title || "Untitled issue"}
      </Link>
      <StateChip state={issue.state as Item["state"]} reason={issue.state === "held" ? issue.reason : null} />
      {when && <span className="text-sm text-muted-foreground tabular-nums">{when}</span>}
      {issue.stats && <span className="text-sm text-muted-foreground tabular-nums">{`${clickRate(issue.stats).toFixed(1)}% clicked`}</span>}
    </div>
  );
}

function Setup(p: { workspaceId: string; role: Role; data: SettingsPage; initialLists?: AccountList[]; setError: (e: string | undefined) => void }) {
  const { workspaceId, role, data, setError } = p;
  const client = useQueryClient();
  const [picked, setPicked] = useState<string>();
  const [keyValue, setKeyValue] = useState("");
  /** A key change needs a recent sign-in; it asks over the form, as Auto-approve does, not at the top of the page. */
  const [stepUp, setStepUp] = useState(false);
  const connecting = useAction();
  const choosing = useAction();
  const saving = useAction();
  const [enabled, setEnabled] = useState(data.settings?.enabled ?? true);
  /** A refusal stays on the page; what worked says so once. */
  const tell = (failed: string | undefined, done: string) => {
    setError(failed);
    if (!failed) toast.add({ title: done });
  };
  const reload = () => client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });

  const s = data.settings;
  const platforms = data.platforms;
  const current = s?.list === "substack" ? SUBSTACK : platforms.find((x) => x.credentialId && x.credentialId === s?.credentialId)?.connection;
  const chosen = picked ?? current ?? platforms.find((x) => x.credentialId)?.connection ?? platforms[0]?.connection ?? SUBSTACK;
  const platform = platforms.find((x) => x.connection === chosen);
  const keyId = platform?.credentialId ?? null;
  const askList = !!keyId && !!platform?.hasLists;

  // A tool whose account holds several lists shows them once its key is connected. The lists a test
  // or the server passed in belong to the tool shown first, so a picked tool reads its own.
  const listsQuery = useQuery({ ...accountListsQuery(workspaceId, keyId ?? ""), enabled: askList, initialData: picked ? undefined : p.initialLists });
  const lists = askList ? listsQuery.data : undefined;
  // The saved key, so it can be replaced, checked or removed here: this is the one place it is set up.
  const saved = useQuery({ ...credentialsQuery(workspaceId), enabled: !!keyId }).data?.find((c) => c.id === keyId);

  const manage = role === "owner" || role === "admin";
  const zone = s?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const listName = (id: string | null) => {
    if (!id) return "Substack";
    const x = platforms.find((y) => y.credentialId === id);
    if (!x) return data.lists.find((l) => l.credentialId === id)?.name ?? "a list that is no longer connected";
    return x.listName ? `${x.name}, list ${x.listName}` : x.name;
  };

  const pick = (connection: string) => {
    setPicked(connection);
    setError(undefined);
  };

  const connect = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!platform) return;
    const v = keyValue;
    setKeyValue("");
    await connecting.run(async () => {
      const error = await connectKey(workspaceId, platform.connection, v);
      if (error === "step_up_required") {
        setStepUp(true);
        return null;
      }
      if (error) {
        setError(message(error));
        return null;
      }
      const r = await checkKey(workspaceId, platform.connection);
      if ("error" in r) setError(message(r.error));
      else tell(undefined, checkWords(platform.name, r));
      await reload();
      return null;
    });
  };

  const choose = async (listId: string) => {
    if (!keyId || !platform) return;
    await choosing.run(async () => {
      const error = await chooseList(workspaceId, keyId, listId);
      tell(error ? say(error) : undefined, `Saved. The newsletter goes to the ${platform.name} list ${lists?.find((l) => l.id === listId)?.name ?? ""}.`);
      if (!error) await reload();
      return null;
    });
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await saving.run(async () => {
      const error = await saveSettings(workspaceId, {
        list: keyId ? "connected" : "substack",
        credentialId: keyId,
        weekday: Number(f.get("weekday")),
        sendTime: String(f.get("sendTime")),
        timeZone: String(f.get("timeZone")),
        enabled,
      });
      tell(error ? say(error) : undefined, "Saved.");
      if (!error) await reload();
      return null;
    });
  };

  /** Once set up, the switch saves on its own; before that, the first Save carries it. */
  const turn = async (on: boolean) => {
    setEnabled(on);
    if (!s) return;
    await saving.run(async () => {
      const error = await saveSettings(workspaceId, { list: s.list, credentialId: s.credentialId, weekday: s.weekday, sendTime: s.sendTime, timeZone: s.timeZone, enabled: on });
      tell(error ? say(error) : undefined, "Saved.");
      if (error) setEnabled(!on);
      else await reload();
      return null;
    });
  };

  return (
    <>
      {/* Signing in again reloads this page (SignIn sends the browser to callbackURL), so the dialog only has to sit over it until then. */}
      <Dialog isOpen={stepUp} onOpenChange={setStepUp} purpose="form" width={448} aria-label="Confirm it's you">
        {stepUp && <SignIn title="Confirm it's you" note="Changing a newsletter key needs a recent sign-in. Sign in again, then paste the key once more." callbackURL={location.pathname + location.search} />}
      </Dialog>
      {s?.readOnlyReason && (
        <Notice tone="error">{`Your newsletter tool won't send for Direx: it needs ${s.readOnlyReason}. Until you upgrade, or replace the key below, you'll copy each issue in by hand.`}</Notice>
      )}
      {data.quiet && <p className="text-muted-foreground">It has been more than a month since your last issue. Readers forget a quiet list, so expect a few more unsubscribes on the next one.</p>}
      {s && (
        <p>
          {s.enabled && data.nextSlot
            ? `Next issue: ${slotWords(data.nextSlot, s.timeZone)} (${s.timeZone}), to ${listName(s.credentialId)}. Its draft appears two days before. It goes out only if someone approves it by then; if nobody does, that week's issue is skipped and you're told.`
            : "The weekly issue is off."}
        </p>
      )}

      <details open={!s}>
        <summary className="cursor-pointer font-medium">Where and when it sends</summary>
        {!manage ? (
          <p className="mt-4 text-muted-foreground">{`${s ? `${WEEKDAYS[s.weekday - 1]}s at ${s.sendTime} (${s.timeZone}), to ${listName(s.credentialId)}.` : "Not set up yet."} Only an Admin or Owner can change this.`}</p>
        ) : (
          <section aria-label="Set up" className="mt-4 flex max-w-2xl flex-col gap-6 rounded-card border border-border bg-card p-6">
            <Switch label="Send a weekly issue" value={enabled} isDisabled={saving.pending} onChange={(on) => void turn(on)} />
            <ol className="flex list-decimal flex-col gap-6 pl-5 marker:text-muted-foreground">
              <li>
                <Field label="Newsletter tool">
                  <Select value={chosen} onChange={(e) => pick(e.target.value)}>
                    {platforms.map((x) => (
                      <option key={x.connection} value={x.connection}>
                        {x.credentialId ? x.name : `${x.name} (not connected yet)`}
                      </option>
                    ))}
                    <option value={SUBSTACK}>Substack (you copy and paste each issue)</option>
                  </Select>
                </Field>
              </li>

              {platform && !keyId && (
                <li>
                  <form className="flex flex-col gap-3" onSubmit={connect}>
                    <p className="text-sm text-muted-foreground">{`Paste your ${platform.name} API key. Direx checks it with ${platform.name}, then keeps it encrypted. You can replace or remove it here later.`}</p>
                    <Field label={`${platform.name} API key`}>
                      <Input type="password" autoComplete="new-password" required value={keyValue} onChange={(e) => setKeyValue(e.target.value)} />
                    </Field>
                    {/* A native button: the base layer styles it like the ui Button. */}
                    <div>
                      <button disabled={connecting.pending} aria-busy={connecting.pending || undefined}>{`Connect ${platform.name}`}</button>
                    </div>
                  </form>
                </li>
              )}

              {platform && saved && (
                <li>
                  <ServiceKey
                    workspaceId={workspaceId}
                    service={{ connection: platform.connection, name: platform.name, canCheck: true }}
                    c={saved}
                    manage
                    settle={async (code) => {
                      if (code === "step_up_required") {
                        setStepUp(true);
                        return false;
                      }
                      setError(code ? message(code) : undefined);
                      if (!code) await reload();
                      return !code;
                    }}
                  />
                </li>
              )}

              {askList && (
                <li className="flex flex-col gap-3">
                  {listsQuery.isError && !lists && <Notice tone="error">{messageFor(listsQuery.error, MESSAGES)}</Notice>}
                  {!lists && !listsQuery.isError && <p role="status" className="text-muted-foreground">{`Reading your ${platform!.name} lists.`}</p>}
                  {lists?.length === 1 && <p>{`${platform!.name} has one list, ${lists[0]!.name}, so the newsletter goes there.`}</p>}
                  {lists && lists.length > 1 && (
                    <>
                      <Field label={`Which ${platform!.name} list gets the newsletter`}>
                        <Select value={platform!.listId ?? ""} disabled={choosing.pending} onChange={(e) => void choose(e.target.value)}>
                          <option value="" disabled>
                            Choose a list
                          </option>
                          {lists.map((l) => (
                            <option key={l.id} value={l.id}>{`${l.name} (${l.subscriberCount.toLocaleString("en")} subscribers)`}</option>
                          ))}
                        </Select>
                      </Field>
                      {!platform!.listId && <p className="text-muted-foreground">{`Choose which ${platform!.name} list gets the newsletter. No issue is made until you do.`}</p>}
                    </>
                  )}
                </li>
              )}

              {(!platform || keyId) && (
                <li>
                  <form key={JSON.stringify(s)} className="flex flex-wrap items-end gap-3" onSubmit={submit}>
                    <Field label="Day">
                      <Select name="weekday" defaultValue={s?.weekday ?? 2}>
                        {WEEKDAYS.map((d, i) => (
                          <option key={d} value={i + 1}>
                            {d}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Time">
                      <Input name="sendTime" type="time" defaultValue={s?.sendTime ?? "09:00"} required />
                    </Field>
                    <Field label="Time zone">
                      <Select name="timeZone" defaultValue={zone}>
                        {timeZones(zone).map((z) => (
                          <option key={z} value={z}>
                            {z}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <button disabled={saving.pending} aria-busy={saving.pending || undefined}>
                      Save
                    </button>
                  </form>
                </li>
              )}
            </ol>
          </section>
        )}
      </details>
    </>
  );
}
