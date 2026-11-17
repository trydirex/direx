// SPDX-License-Identifier: AGPL-3.0-only
// The frame every signed-in screen sits in: a rail of named icons with the Workspace menu at its top,
// Pause all sending, a notice to everyone while sending is paused, and a skip link to the content. On a phone the rail becomes a top bar with a menu, so what
// needs you and the pause stay on screen.
// Astryx's stylesheet comes with the shell, so the sign-in page loads without it.
import "@/astryx.css";
import { AstryxProvider } from "@/components/astryx";
import { useState, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { CalendarIcon, InboxIcon, MegaphoneIcon, SettingsIcon, SparklesIcon, UsersIcon } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { signOut } from "@/identity/auth";
import { WorkspaceSwitcher } from "@/identity/WorkspaceSwitcher";
import { serverStatusQuery } from "@/identity/actions";
import { mayApprove, needsYouQuery, useWaitingByWorkspace } from "@/items/actions";
import { PauseAll } from "@/outreach/PauseAll";
import { outreachQuery } from "@/outreach/actions";
import { Notice } from "@/components/layout";
import { AgentStatus } from "@/agents/Status";
import { AskButton, AskProvider } from "@/ask/Panel";
import { Button } from "@/components/Button";
import { Drawer } from "@astryxdesign/core/Drawer";
import { Popover } from "@astryxdesign/core/Popover";
import { RailTip, railButton } from "./RailTip";
import { Toaster } from "@/components/toast";
import { CommandPalette } from "./CommandPalette";
import { CommandsProvider } from "./commands";
import { deletedWorkspacesQuery, meQuery, type MyWorkspace } from "./session";

type Section = "home" | "calendar" | "campaigns" | "people" | "brand" | "settings";

/** Which nav item a path inside a Workspace belongs to. Newsletter and SEO are Campaign work, and a plan's old link leads to its Campaign. */
export function sectionOf(pathname: string): Section {
  const first = pathname.split("/")[3] ?? "";
  if (first === "newsletter" || first === "seo" || first === "plans") return "campaigns";
  return (["calendar", "campaigns", "people", "brand", "settings"] as const).find((s) => s === first) ?? "home";
}

// The count of what needs you, the same pill in the rail and in the phone menu.
// Peach, as every "needs you" mark is (StateChip); ink is for the one main button.
const badge = "min-w-4 rounded-full bg-peach px-1 text-center text-xs leading-4 text-peach-foreground tabular-nums";
// A rail link: its icon with the section's name under it.
const railLink = "relative flex w-16 flex-col items-center gap-0.5 rounded-control py-1.5 text-xs font-medium text-muted-foreground no-underline hover:bg-accent hover:text-foreground aria-[current=page]:bg-primary-tint aria-[current=page]:text-primary";

const item = "flex min-h-9 items-center rounded-control px-3 text-muted-foreground no-underline hover:bg-accent hover:text-foreground aria-[current=page]:bg-primary-tint aria-[current=page]:text-primary";

type Dest = { section: Section; to: "/w/$workspaceId" | "/w/$workspaceId/calendar" | "/w/$workspaceId/campaigns" | "/w/$workspaceId/people" | "/w/$workspaceId/brand" | "/w/$workspaceId/settings"; label: string; Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }> };
const MAIN: Dest[] = [
  { section: "home", to: "/w/$workspaceId", label: "Home", Icon: InboxIcon },
  { section: "calendar", to: "/w/$workspaceId/calendar", label: "Calendar", Icon: CalendarIcon },
  { section: "campaigns", to: "/w/$workspaceId/campaigns", label: "Campaigns", Icon: MegaphoneIcon },
  { section: "people", to: "/w/$workspaceId/people", label: "Audience", Icon: UsersIcon },
];
const PINNED: Dest[] = [
  { section: "brand", to: "/w/$workspaceId/brand", label: "Brand", Icon: SparklesIcon },
  { section: "settings", to: "/w/$workspaceId/settings", label: "Settings", Icon: SettingsIcon },
];

/** Setup's frame: the same styles and toasts as the shell, without the rail or menu, so a new Workspace's first steps have the screen to themselves. */
export function SetupFrame(p: { children: ReactNode }) {
  return (
    <AstryxProvider>
      <main id="content" className="mx-auto min-h-screen w-full max-w-form p-4 md:py-10">
        {p.children}
      </main>
      <Toaster />
    </AstryxProvider>
  );
}

export function Shell(p: { workspaces: MyWorkspace[]; current: MyWorkspace; Search: ComponentProps<typeof CommandPalette>["Search"]; children: ReactNode }) {
  const workspaceId = p.current.id;
  const section = sectionOf(useRouterState({ select: (s) => s.location.pathname }));
  const navigate = useNavigate();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const count = useQuery(needsYouQuery(workspaceId)).data?.count ?? 0;
  const waiting = useWaitingByWorkspace(p.workspaces.map((w) => w.id));
  const approver = mayApprove(p.current.role);
  // What waits is approvals, so a Contributor or Viewer is told it waits, not that it needs them.
  const needs = approver ? "need you" : "waiting for approval";
  // Every role can read the pause; only an approver can change it.
  const qc = useQueryClient();
  const outreach = outreachQuery(workspaceId);
  const pause = useQuery(outreach);
  const current = (s: Section) => (s === section ? ("page" as const) : undefined);
  const params = { workspaceId };

  const switcher = (
    <WorkspaceSwitcher
      workspaces={p.workspaces}
      current={workspaceId}
      waiting={waiting}
      onSwitch={(id) => {
        setMenu(false);
        void (id === "new" ? navigate({ to: "/new-org" }) : navigate({ to: "/w/$workspaceId", params: { workspaceId: id } }));
      }}
    />
  );
  // The Server page, for Server admins only (ADR 0024).
  const serverAdmin = useQuery(serverStatusQuery).data?.serverAdmin === true;
  // Only for an account that signs in without a password so far.
  const noPassword = useQuery(meQuery).data?.hasPassword === false;
  // Only while a Workspace this person deleted as an Owner can still be exported.
  const deleted = (useQuery(deletedWorkspacesQuery).data?.length ?? 0) > 0;
  const accountLinks = (
    <>
      {noPassword && (
        <Link to="/account/password" className={item} onClick={() => setMenu(false)}>
          Add a password
        </Link>
      )}
      {serverAdmin && (
        <Link to="/server" className={item} onClick={() => setMenu(false)}>
          Server
        </Link>
      )}
      {deleted && (
        <Link to="/deleted-workspaces" className={item} onClick={() => setMenu(false)}>
          Deleted Workspaces
        </Link>
      )}
    </>
  );
  // The same links in the sidebar and in the phone menu; picking one closes the menu.
  const links = (
    <>
      <nav aria-label="Main" className="flex flex-col gap-1">
        <Link to="/w/$workspaceId" params={params} className={item} aria-current={current("home")} activeOptions={{ exact: true }} onClick={() => setMenu(false)}>
          Home
          {count > 0 && (
            <>
              <span aria-hidden="true" className={`ml-auto ${badge}`}>
                {count}
              </span>
              <span className="sr-only">{`(${count} ${needs})`}</span>
            </>
          )}
        </Link>
        <Link to="/w/$workspaceId/calendar" params={params} className={item} aria-current={current("calendar")} onClick={() => setMenu(false)}>
          Calendar
        </Link>
        <Link to="/w/$workspaceId/campaigns" params={params} className={item} aria-current={current("campaigns")} onClick={() => setMenu(false)}>
          Campaigns
        </Link>
        <Link to="/w/$workspaceId/people" params={params} className={item} aria-current={current("people")} onClick={() => setMenu(false)}>
          Audience
        </Link>
      </nav>
      <nav aria-label="Workspace" className="flex flex-col gap-1 md:mt-auto">
        <Link to="/w/$workspaceId/brand" params={params} className={item} aria-current={current("brand")} onClick={() => setMenu(false)}>
          Brand
        </Link>
        <Link to="/w/$workspaceId/settings" params={params} className={item} aria-current={current("settings")} onClick={() => setMenu(false)}>
          Settings
        </Link>
        {accountLinks}
        <button className={`${item} justify-start border-transparent bg-transparent font-normal`} onClick={async () => setSignOutError(await signOut())}>
          Sign out
        </button>
        {signOutError && <p role="alert">{signOutError}</p>}
      </nav>
    </>
  );

  return (
    <AstryxProvider>
    <CommandsProvider>
      <AskProvider workspaceId={workspaceId} role={p.current.role}>
      <div className="min-h-screen md:grid md:grid-cols-[auto_1fr]">
        <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-control focus:bg-card focus:px-4 focus:py-2">
          Skip to content
        </a>
        <aside className="sticky top-0 hidden h-screen flex-col items-center gap-1 border-r border-border bg-card py-3 md:flex md:w-18">
          <RailTip label={p.current.name}>
            <Popover
              label="Workspace"
              placement="end"
              alignment="start"
              width={256}
              padding={4}
              content={
                <div className="flex flex-col gap-4">
                  {switcher}
                  {accountLinks}
                  <button className={`${item} justify-start border-transparent bg-transparent font-normal`} onClick={async () => setSignOutError(await signOut())}>
                    Sign out
                  </button>
                  {signOutError && <p role="alert">{signOutError}</p>}
                </div>
              }
            >
              <button type="button" data-slot="rail" className={`${railButton} mb-3 bg-primary text-primary-foreground hover:bg-primary-hover hover:text-primary-foreground`} aria-label={`Workspace: ${p.current.name}`}>
                <span aria-hidden className="font-display text-md font-semibold">{p.current.name.slice(0, 1).toUpperCase()}</span>
              </button>
            </Popover>
          </RailTip>
          <nav aria-label="Main" className="flex flex-col items-center gap-1">
            {MAIN.map((d) => (
              <Link key={d.section} to={d.to} params={params} data-slot="rail" className={railLink} aria-current={current(d.section)} activeOptions={{ exact: d.section === "home" }}>
                <d.Icon className="size-5" aria-hidden />
                {d.label}
                {d.section === "home" && count > 0 && (
                  <>
                    <span aria-hidden className={`absolute top-0.5 right-2.5 ${badge}`}>
                      {count}
                    </span>
                    <span className="sr-only">{` (${count} ${needs})`}</span>
                  </>
                )}
              </Link>
            ))}
          </nav>
          <nav aria-label="Workspace" className="mt-auto flex flex-col items-center gap-1">
            <CommandPalette workspaceId={workspaceId} Search={p.Search} compact />
            <AskButton compact />
            {PINNED.map((d) => (
              <Link key={d.section} to={d.to} params={params} data-slot="rail" className={railLink} aria-current={current(d.section)}>
                <d.Icon className="size-5" aria-hidden />
                {d.label}
              </Link>
            ))}
          </nav>
        </aside>
        <div className="flex min-w-0 flex-col">
          {/* On a phone: the menu, the Workspace, what needs you and the pause. The Workspace's basis keeps it readable:
              the pause wraps to its own line rather than squeezing the name to a letter. On a wider screen the Workspace (so an agency
              always sees which client it is in), the agents' status and the pause. */}
          <header className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-3 md:px-6">
            <Button variant="outline" size="sm" className="md:hidden" aria-haspopup="dialog" aria-expanded={menu} onClick={() => setMenu(true)}>
              Menu
            </Button>
            <span className="min-w-0 flex-1 truncate font-medium max-md:basis-40 md:max-w-64 md:flex-none">{p.current.name}</span>
            {count > 0 && (
              <Link to="/w/$workspaceId" params={params} className="text-sm font-medium md:hidden">
                {`${count} ${needs}`}
              </Link>
            )}
            <div className="hidden min-w-0 flex-1 md:block">
              <AgentStatus workspaceId={workspaceId} />
            </div>
            {approver && !pause.isPending && <PauseAll workspaceId={workspaceId} paused={pause.data?.paused} onChange={(paused) => qc.setQueryData(outreach.queryKey, (o) => o && { ...o, paused })} />}
          </header>
          <div id="content" tabIndex={-1} className="mx-auto w-full max-w-content p-4 outline-none md:p-6">
            {pause.data?.paused && (
              <div className="mb-4">
                <Notice>Sending is paused. Nothing goes out until an Owner, Admin or Marketer turns sending back on.</Notice>
              </div>
            )}
            {p.children}
          </div>
        </div>
      </div>
      <Drawer isOpen={menu} onOpenChange={setMenu} label="Menu" side="start" width={320}>
        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-between gap-3">
            <h2>Menu</h2>
            <Button variant="outline" size="sm" onClick={() => setMenu(false)}>
              Close
            </Button>
          </div>
          {switcher}
          {links}
        </div>
      </Drawer>
      <Toaster />
      </AskProvider>
    </CommandsProvider>
    </AstryxProvider>
  );
}

export { SectionNav, sectionLink } from "./SectionNav";
