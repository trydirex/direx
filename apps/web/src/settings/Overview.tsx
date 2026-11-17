// SPDX-License-Identifier: AGPL-3.0-only
// Settings' first page: what needs someone now, each area's state in a line, and what no setting changes.
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { Page } from "../components/layout";
import { StatusChip, type Tone } from "../components/StatusChip";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { dayWords } from "../campaigns/actions";
import { dollars } from "../models/actions";
import { ME } from "../api/query";
import { SignIn } from "../identity/SignIn";
import { DeleteWorkspace } from "./DeleteWorkspace";
import { ExportData } from "./ExportData";
import { useNeeds, type Need } from "./needs";

type S = components["schemas"];
type To = Need["to"];

/** The Hard floors, in a marketer's words. */
const FLOORS = ["Send marketing email without a way to opt out", "Email someone who opted out", "Send without your name and postal address", "Approve anything for you", "Keep sending after the emergency pause"];

function Card(p: { title: string; to: To; workspaceId: string; chip?: [Tone, string] | undefined; big?: ReactNode; children?: ReactNode }) {
  return (
    <Link to={p.to} params={{ workspaceId: p.workspaceId }} className="flex flex-col gap-2 rounded-card border border-border bg-card p-5 text-foreground no-underline hover:border-input">
      <span className="flex items-center justify-between gap-2">
        <span className="font-medium">{p.title}</span>
        {p.chip && <StatusChip tone={p.chip[0]}>{p.chip[1]}</StatusChip>}
      </span>
      {p.big === undefined ? <Skeleton className="h-8 w-24" /> : <span className="font-display text-lg tabular-nums">{p.big}</span>}
      {p.children && <span className="text-sm text-muted-foreground">{p.children}</span>}
    </Link>
  );
}

const small = "font-sans text-sm text-muted-foreground";

export function Overview(p: { workspace: S["MyWorkspace"]; me: string }) {
  const id = p.workspace.id;
  const { mailboxes, accounts, usage, rules, list } = useNeeds(p.workspace, p.me);
  const sending = mailboxes?.filter((m) => m.status === "active").length ?? 0;
  // Sending, but cold email waits until the account passes its unsubscribe check.
  const unchecked = list.filter((n) => n.act === "Check it").length;
  const working = accounts?.filter((a) => a.status === "active" && !a.warning).length ?? 0;
  const live = rules?.filter((r) => r.status === "active") ?? [];
  const nextEnd = live.map((r) => r.expiresAt).sort()[0];
  const share = usage ? Number(usage.settledMicros) / Math.max(Number(usage.budgetMicros), 1) : 0;
  const [stepUp, setStepUp] = useState(false);
  const navigate = useNavigate();
  const client = useQueryClient();
  // Gone from the person's Workspaces, it shows among the deleted ones, where its export stays until the purge.
  const deleted = async () => {
    await navigate({ to: "/deleted-workspaces" });
    await client.invalidateQueries({ queryKey: ME });
  };

  if (stepUp)
    return <SignIn title="Confirm it's you" note="Deleting a Workspace needs a recent sign-in. Sign in again, then delete it again." callbackURL={location.pathname} />;

  return (
    <Page title="Settings" description="Where Direx sends from, and what it may do without asking you.">
      {list.length > 0 && (
        <section aria-label="Needs you" className="flex flex-col gap-3 rounded-card bg-peach p-5 text-peach-foreground">
          <h2>{list.length === 1 ? "1 thing needs you" : `${list.length} things need you`}</h2>
          <ul className="flex flex-col">
            {list.map((n) => (
              <li key={n.key} className="flex flex-wrap items-center justify-between gap-3 border-t border-peach-foreground/15 py-3 last:pb-0">
                <p className="min-w-0 flex-1 basis-64 text-sm">
                  <strong className="font-semibold">{n.what}</strong> {n.why}
                </p>
                <Link to={n.to} params={{ workspaceId: id }} className="flex min-h-9 items-center rounded-control border border-peach-foreground px-3 text-sm font-medium text-peach-foreground no-underline">
                  {n.act}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          title="Email accounts"
          to="/w/$workspaceId/settings/credentials"
          workspaceId={id}
          chip={mailboxes && (mailboxes.length === 0 ? ["off", "None yet"] : sending < mailboxes.length ? ["broken", `${mailboxes.length - sending} not sending`] : unchecked ? ["attention", `${unchecked} not checked`] : ["good", "All sending"])}
          big={mailboxes && <>{sending} <small className={small}>of {mailboxes.length} sending</small></>}
        >
          {mailboxes?.length === 0 ? "Add one so Direx can send the emails you approve." : unchecked ? "Cold email waits until each passes its unsubscribe check." : "Direx sends only what someone approved."}
        </Card>
        <Card
          title="Social accounts"
          to="/w/$workspaceId/settings/social"
          workspaceId={id}
          chip={accounts && (accounts.length === 0 ? ["off", "None yet"] : working < accounts.length ? ["attention", `${accounts.length - working} need you`] : ["good", "All working"])}
          big={accounts && <>{working} <small className={small}>of {accounts.length} working</small></>}
        >
          {accounts && [...new Set(accounts.map((a) => a.network))].join(", ")}
        </Card>
        <Card
          title="AI this month"
          to="/w/$workspaceId/settings/models"
          workspaceId={id}
          chip={usage && (share >= 1 ? ["broken", "Budget used up"] : share >= 0.8 ? ["attention", "Near the budget"] : ["good", "On budget"])}
          big={usage && <>{dollars(usage.settledMicros)} <small className={small}>of {dollars(usage.budgetMicros)}</small></>}
        />
        <Card
          title="Auto-approve"
          to="/w/$workspaceId/settings/rules"
          workspaceId={id}
          chip={rules && (live.length ? ["good", `${live.length} on`] : ["off", "Off"])}
          big={rules && <>{live.reduce((n, r) => n + r.total, 0)} <small className={small}>approved without asking</small></>}
        >
          {nextEnd ? `The next rule ends ${dayWords(nextEnd.slice(0, 10))}.` : rules && "Every email waits for someone's yes."}
        </Card>
      </div>

      <section aria-label="Never, whatever the settings say" className="flex flex-col gap-3 rounded-card bg-muted p-5">
        <h2 className="font-sans text-base font-medium">Direx never does these, whatever the settings say</h2>
        <ul className="grid list-disc gap-x-8 gap-y-1 pl-5 text-sm sm:grid-cols-2">
          {FLOORS.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </section>

      {p.workspace.role === "owner" && (
        <>
          <ExportData workspaceId={id} />
          <DeleteWorkspace workspaceId={id} name={p.workspace.name} onStepUp={() => setStepUp(true)} onDeleted={() => void deleted()} />
        </>
      )}
    </Page>
  );
}
