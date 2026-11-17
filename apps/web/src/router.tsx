// SPDX-License-Identifier: AGPL-3.0-only
// Every screen's URL. Routes are declared in code, with typed path and search params. Sign-in and the
// shell load with the first page; each screen loads when its route first opens, to keep the first
// page fast.
import { createContext, lazy, Suspense, useContext, useEffect, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { mayApprove, needsYouQuery } from "@/items/actions";
import { inWorkspace, queryClient } from "@/api/query";
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, Link, Navigate, Outlet, redirect, useRouter, useRouterState } from "@tanstack/react-router";
import { Placeholder, QueryBoundary } from "@/components/QueryBoundary";
import { buttonVariants } from "@/components/native";
import { EmptyState } from "@/components/layout";
import { signInOptionsQuery } from "@/identity/auth";
import { AddPassword, ResetPassword, SignIn } from "@/identity/SignIn";
import { legacyPath } from "@/shell/legacy";
import { deletedWorkspacesQuery, meQuery, workspacesQuery, type Me, type MyWorkspace } from "@/shell/session";
import { SectionNav, sectionLink } from "@/shell/SectionNav";
import { useNeeds, type Need } from "./settings/needs";
import { provideFields } from "./components/laterSource";
// Type only, so the Calendar still loads with its route.
import type { Filters as CalendarFilters } from "./items/Calendar";

const Campaign = lazyRouteComponent(() => import("./campaigns/Campaign"), "Campaign");
const Campaigns = lazyRouteComponent(() => import("./campaigns/List"), "Campaigns");
const Credentials = lazyRouteComponent(() => import("./credentials/Credentials"), "Credentials");
const Brand = lazyRouteComponent(() => import("./facts/Brand"), "Brand");
const AcceptInvite = lazyRouteComponent(() => import("./identity/AcceptInvite"), "AcceptInvite");
const ClaimServer = lazyRouteComponent(() => import("./identity/AcceptInvite"), "ClaimServer");
const NewOrg = lazyRouteComponent(() => import("./identity/CreateOrg"), "NewOrg");
const ServerPage = lazyRouteComponent(() => import("./identity/Server"), "Server");
const DeletedWorkspaces = lazyRouteComponent(() => import("./settings/DeletedWorkspaces"), "DeletedWorkspaces");
const Setup = lazyRouteComponent(() => import("./setup/Setup"), "Setup");
const Members = lazyRouteComponent(() => import("./identity/Members"), "Members");
const Calendar = lazyRouteComponent(() => import("./items/Calendar"), "Calendar");
const Home = lazyRouteComponent(() => import("./items/Home"), "Home");
const Review = lazyRouteComponent(() => import("./items/Review"), "Review");
const Models = lazyRouteComponent(() => import("./models/Models"), "Models");
const Issue = lazyRouteComponent(() => import("./newsletter/Issue"), "Issue");
const NewsletterSettings = lazyRouteComponent(() => import("./newsletter/Settings"), "Settings");
const Outreach = lazyRouteComponent(() => import("./outreach/Outreach"), "Outreach");
// The number, date, time and file fields load on first use (components/Input.tsx).
provideFields(() => import("./components/laterFields"));
const Cohorts = lazyRouteComponent(() => import("./prospecting/Cohorts"), "Cohorts");
const Handover = lazyRouteComponent(() => import("./prospecting/Cohorts"), "Handover");
const Find = lazyRouteComponent(() => import("./prospecting/Find"), "Find");
const Run = lazyRouteComponent(() => import("./prospecting/Run"), "Run");
const Seo = lazyRouteComponent(() => import("./seo/Seo"), "Seo");
const Social = lazyRouteComponent(() => import("./social/Social"), "Social");
const SettingsOverview = lazyRouteComponent(() => import("./settings/Overview"), "Overview");
const Sending = lazyRouteComponent(() => import("./settings/Sending"), "Sending");
const ReviewTime = lazyRouteComponent(() => import("./settings/ReviewTime"), "ReviewTime");
// The Item dialog loads on first open, not with Home or the Calendar. React.lazy, not
// lazyRouteComponent: it renders before anything preloads it.
const ItemDialog = lazy(() => import("./items/ItemPanel").then((m) => ({ default: m.ItemDialog })));
// The signed-in frame loads with the first signed-in page, not with sign-in.
const Shell = lazyRouteComponent(() => import("./shell/Shell"), "Shell");
const SetupFrame = lazyRouteComponent(() => import("./shell/Shell"), "SetupFrame");
const PaletteSearch = lazyRouteComponent(() => import("./shell/PaletteSearch"), "PaletteSearch");
const Rules = lazyRouteComponent(() => import("./standing-rules/Rules"), "Rules");

type Lazy = { preload?: () => Promise<void> | undefined };
/**
 * A route loader that loads its screens' code before the route renders. It must wait: a lazy screen
 * that renders before its code arrives suspends in a way React then rejects, and stays on its skeleton.
 * Data is not waited for; each screen shows its own skeleton while its data loads.
 */
const preloading = (...screens: Lazy[]) => async () => {
  await Promise.all(screens.map((s) => s.preload?.()));
};

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const here = () => location.pathname + location.search;

/** What every route's loader can use. */
type RouterContext = { queryClient: QueryClient };
const rootRoute = createRootRouteWithContext<RouterContext>()({ component: Outlet });

const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset-password",
  validateSearch: (s: Record<string, unknown>): { token?: string } => ({ token: str(s.token) }),
  component: function ResetRoute() {
    return <ResetPassword token={resetRoute.useSearch().token ?? null} />;
  },
});

/** Everything below needs a signed-in person; anyone else gets sign-in, then comes back here. */
const signedInRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "signed-in",
  component: function SignedIn() {
    const me = useQuery(meQuery);
    // Sign-in waits for its buttons, so it opens once, without them shifting the card.
    const options = useQuery(signInOptionsQuery);
    const invite = useRouterState({ select: (s) => s.location.pathname.startsWith("/invite/") });
    const claim = useRouterState({ select: (s) => s.location.pathname.startsWith("/claim/") });
    // A Workspace invite's or the bootstrap link's token, held for sign-up (ADR 0024).
    const inviteToken = useRouterState({ select: (s) => /^\/(?:invite\/[^/]+|claim)\/([0-9a-f]{64})$/.exec(s.location.pathname)?.[1] });
    // Outside the shell, so the loading and error states get their own margin.
    if (me.data === undefined || (me.data === null && options.isPending)) {
      return (
        <div className="mx-auto max-w-content p-6">
          <QueryBoundary query={me}>{() => null}</QueryBoundary>
        </div>
      );
    }
    return me.data ? (
      <MeContext.Provider value={me.data}>
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
      </MeContext.Provider>
    ) : (
      <SignIn title={invite ? "Sign in to accept your invite" : claim ? "Sign in to claim this server" : undefined} callbackURL={here()} inviteToken={inviteToken} />
    );
  },
});

/** While a screen's code arrives. */
function Loading() {
  return (
    <div role="status">
      <span className="sr-only">Loading</span>
      <Placeholder className="h-24 w-full" />
    </div>
  );
}

const MeContext = createContext<Me | null>(null);
const WorkspaceContext = createContext<MyWorkspace | null>(null);
/** The signed-in person and the Workspace in the URL. Only for routes inside a Workspace. */
function useWorkspace() {
  const me = useContext(MeContext);
  const workspace = useContext(WorkspaceContext);
  if (!me || !workspace) throw new Error("useWorkspace outside a Workspace route");
  return { me, workspace, workspaceId: workspace.id, role: workspace.role };
}

/** "/" itself, and the old query-string links, which redirect for good. */
const indexRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/",
  component: function Index() {
    const workspaces = useQuery(workspacesQuery);
    // With no Workspace left, an Owner who deleted one still finds its export (ADR 0030 rule 008).
    const deleted = useQuery({ ...deletedWorkspacesQuery, enabled: workspaces.data?.length === 0 });
    // Read once: while the redirect runs this screen renders again with the new search.
    const searchNow = useRouterState({ select: (s) => s.location.searchStr });
    const [search] = useState(searchNow);
    return (
      <QueryBoundary query={workspaces}>
        {(list) => {
          const old = legacyPath(search, list[0]?.id);
          if (old) return <Redirect href={old} />;
          if (list[0]) return <Navigate to="/w/$workspaceId" params={{ workspaceId: list[0].id }} replace />;
          if (deleted.isPending) return null;
          return deleted.data?.length ? <Navigate to="/deleted-workspaces" replace /> : <Navigate to="/new-org" replace />;
        }}
      </QueryBoundary>
    );
  },
});

/** Replaces the current entry with a plain path, as old links carry no typed route. */
function Redirect({ href }: { href: string }) {
  const { history } = useRouter();
  useEffect(() => history.replace(href), [history, href]);
  return null;
}

const inviteRoute = createRoute({
  getParentRoute: () => signedInRoute,
  loader: preloading(AcceptInvite),
  path: "/invite/$workspaceId/$token",
  component: function InviteRoute() {
    const { workspaceId, token } = inviteRoute.useParams();
    // A full load, so the new Workspace is in the list.
    return <AcceptInvite workspaceId={workspaceId} token={token} onJoined={() => location.assign(`/w/${workspaceId}`)} />;
  },
});

const claimRoute = createRoute({
  getParentRoute: () => signedInRoute,
  loader: preloading(ClaimServer),
  path: "/claim/$token",
  component: function ClaimRoute() {
    // A full load, so every screen sees the new Server admin.
    return <ClaimServer token={claimRoute.useParams().token} onClaimed={() => location.assign("/new-org")} />;
  },
});

const newOrgRoute = createRoute({
  getParentRoute: () => signedInRoute,
  loader: preloading(NewOrg),
  path: "/new-org",
  // A new Organization starts with its first Workspace's setup, not an empty Home.
  component: () => <NewOrg onCreated={(id, site) => location.assign(`/w/${id}/setup${site ? `?site=${encodeURIComponent(site)}` : ""}`)} />,
});

// A password for an account that has none yet (ADR 0024).
const addPasswordRoute = createRoute({ getParentRoute: () => signedInRoute, path: "/account/password", component: AddPassword });

// A deleted Workspace's export until its purge, for its Owners (ADR 0030 rule 008); outside any Workspace.
const deletedWorkspacesRoute = createRoute({ getParentRoute: () => signedInRoute, loader: preloading(DeletedWorkspaces), path: "/deleted-workspaces", component: DeletedWorkspaces });

// Server-wide settings for Server admins (ADR 0024); the API refuses anyone else.
const serverRoute = createRoute({
  getParentRoute: () => signedInRoute,
  loader: preloading(ServerPage),
  path: "/server",
  component: function ServerRoute() {
    const me = useContext(MeContext)!;
    return <ServerPage me={me.id} />;
  },
});

const workspaceRoute = createRoute({
  getParentRoute: () => signedInRoute,
  path: "/w/$workspaceId",
  loader: preloading(Shell),
  component: function WorkspaceRoute() {
    const { workspaceId } = workspaceRoute.useParams();
    const workspaces = useQuery(workspacesQuery);
    const onSetup = useRouterState({ select: (s) => s.location.pathname }) === `/w/${workspaceId}/setup`;
    return (
      <QueryBoundary query={workspaces}>
        {(list) => {
          const current = list.find((w) => w.id === workspaceId);
          if (!current) return <NoAccess workspaceId={workspaceId} first={list[0]} />;
          // Setup is a wizard of its own: no rail or menu until the person leaves it (marketer UX pass, E5).
          if (onSetup)
            return (
              <WorkspaceContext.Provider value={current}>
                <SetupFrame>
                  <Suspense fallback={<Loading />}>
                    <Outlet />
                  </Suspense>
                </SetupFrame>
              </WorkspaceContext.Provider>
            );
          return (
            <WorkspaceContext.Provider value={current}>
              <Shell workspaces={list} current={current} Search={PaletteSearch}>
                <Suspense fallback={<Loading />}>
                  <Outlet />
                </Suspense>
              </Shell>
            </WorkspaceContext.Provider>
          );
        }}
      </QueryBoundary>
    );
  },
});

/** A Workspace not in the person's list: removed from it, or an old link. Its cached data goes, and they're told why. */
function NoAccess({ workspaceId, first }: { workspaceId: string; first?: MyWorkspace }) {
  const client = useQueryClient();
  useEffect(() => client.removeQueries({ queryKey: inWorkspace(workspaceId) }), [client, workspaceId]);
  return (
    <div className="mx-auto max-w-content p-6">
      <EmptyState
        title="You don't have access to this Workspace"
        action={
          first ? (
            <Link to="/w/$workspaceId" params={{ workspaceId: first.id }} replace className={buttonVariants({ variant: "outline" })}>
              Open {first.name}
            </Link>
          ) : (
            <Link to="/new-org" replace className={buttonVariants({ variant: "outline" })}>
              Create an Organization
            </Link>
          )
        }
      >
        You may have been removed from it, or the link is old. Ask one of its Owners or Admins if you need it back.
      </EmptyState>
    </div>
  );
}

/** A screen route. `screens` start downloading as soon as the route matches, beside its data. */
const page = <P extends string>(path: P, component: () => React.ReactNode, ...screens: Lazy[]) =>
  createRoute({ getParentRoute: () => workspaceRoute, path, component, loader: preloading(...screens) });

// Home's and Review's list starts loading with the route, beside its code, so the first page is ready sooner.
const queueLoader = (screen: Lazy, { context, params }: { context: RouterContext; params: { workspaceId: string } }) => {
  void context.queryClient.prefetchQuery(needsYouQuery(params.workspaceId));
  return preloading(screen)();
};
const homeRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/",
  loader: (o) => queueLoader(Home, o),
  component: function HomeRoute() {
    const w = useWorkspace();
    return <Home workspaceId={w.workspaceId} role={w.role} />;
  },
});
// One Item open in Review's queue, so a link elsewhere can lead straight to it.
const reviewItemRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "review/$itemId",
  loader: (o) => queueLoader(Review, o),
  component: function ReviewItemRoute() {
    const w = useWorkspace();
    const navigate = reviewItemRoute.useNavigate();
    const { itemId } = reviewItemRoute.useParams();
    // Not keyed by the Item: J and K change the address, and the queue stays as it is.
    return <Review workspaceId={w.workspaceId} role={w.role} open={itemId} onOpen={(id) => void navigate({ to: "/w/$workspaceId/review/$itemId", params: { workspaceId: w.workspaceId, itemId: id }, replace: true })} />;
  },
});
// The whole queue, the first Item open; older `?item=` links land on that Item.
const reviewRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "review",
  validateSearch: (s: Record<string, unknown>): { item?: string } => ({ item: str(s.item) }),
  beforeLoad: ({ params, search }) => {
    if (search.item) throw redirect({ to: "/w/$workspaceId/review/$itemId", params: { workspaceId: params.workspaceId, itemId: search.item }, replace: true });
  },
  loader: (o) => queueLoader(Review, o),
  component: function ReviewRoute() {
    const w = useWorkspace();
    const navigate = reviewRoute.useNavigate();
    return <Review workspaceId={w.workspaceId} role={w.role} onOpen={(id) => void navigate({ to: "/w/$workspaceId/review/$itemId", params: { workspaceId: w.workspaceId, itemId: id }, replace: true })} />;
  },
});
const calendarRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  loader: preloading(Calendar),
  path: "calendar",
  // The day and view shown, so reload, Back and a shared link keep them.
  // `item` is the open Item, so a link can lead straight to it. The filters too, so a link is a saved view.
  validateSearch: (s: Record<string, unknown>): { date?: string; view?: string; item?: string } & CalendarFilters => ({
    date: str(s.date),
    view: str(s.view),
    item: str(s.item),
    hide: str(s.hide),
    // The router reads `needs=true` as a boolean; `needs=1`, typed by hand, as a number.
    needs: s.needs === true || s.needs === 1 || undefined,
    campaign: str(s.campaign),
    network: str(s.network),
  }),
  component: function CalendarRoute() {
    const w = useWorkspace();
    const navigate = calendarRoute.useNavigate();
    const { date, view, item, ...filters } = calendarRoute.useSearch();
    return (
      <Calendar
        workspaceId={w.workspaceId}
        role={w.role}
        ItemView={ItemDialog}
        date={date}
        view={view}
        // Moving to another day or view keeps the filters.
        onNavigate={(to) => void navigate({ search: (s) => ({ ...to, hide: s.hide, needs: s.needs, campaign: s.campaign, network: s.network }) })}
        item={item}
        onItem={(id) => void navigate({ search: (s) => ({ ...s, item: id }) })}
        filters={filters}
        // A filter change replaces the entry, so Back leaves the Calendar rather than undoing clicks.
        onFilters={(f) => void navigate({ search: (s) => ({ ...s, ...f }), replace: true })}
      />
    );
  },
});
// ADR 0023 rule 004: a plan shows only inside its Campaign. Plan was its own nav item; its links still lead
// there, a plan's to its Campaign's Plan tab with the drafting run or its refusal, and the list to Campaigns.
const plansRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "plans",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/w/$workspaceId/campaigns", params, replace: true });
  },
});
const planRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "plans/$planId",
  validateSearch: (s: Record<string, unknown>): { run?: string; notice?: string } => ({ run: str(s.run), notice: str(s.notice) }),
  beforeLoad: async ({ params, search }) => {
    const { campaignOfPlan } = await import("./campaigns/actions");
    const campaignId = await campaignOfPlan(params.workspaceId, params.planId);
    // A plan with no Campaign here (deleted, or another Workspace's) has nothing to open; Campaigns does.
    throw campaignId
      ? redirect({ to: "/w/$workspaceId/campaigns/$campaignId", params: { workspaceId: params.workspaceId, campaignId }, search: { tab: "plan", run: search.run, notice: search.notice }, replace: true })
      : redirect({ to: "/w/$workspaceId/campaigns", params: { workspaceId: params.workspaceId }, replace: true });
  },
});

// Campaigns, with Newsletter and SEO as Campaign work.
function CampaignNav() {
  const params = { workspaceId: useWorkspace().workspaceId };
  return (
    <SectionNav label="Campaign work">
      <Link to="/w/$workspaceId/campaigns" params={params} className={sectionLink} activeOptions={{ exact: true }}>
        Campaigns
      </Link>
      <Link to="/w/$workspaceId/newsletter" params={params} className={sectionLink}>
        Newsletter
      </Link>
      <Link to="/w/$workspaceId/seo" params={params} className={sectionLink}>
        SEO
      </Link>
    </SectionNav>
  );
}
const campaignsRoute = page("campaigns", function CampaignsRoute() {
  const w = useWorkspace();
  return (
    <>
      <CampaignNav />
      <Campaigns workspaceId={w.workspaceId} role={w.role} />
    </>
  );
}, Campaigns);
const campaignRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  loader: preloading(Campaign),
  path: "campaigns/$campaignId",
  // `run` and `notice` are a plan drafting run's progress or refusal, shown on the Plan tab.
  validateSearch: (s: Record<string, unknown>): { tab?: string; run?: string; notice?: string } => ({ tab: str(s.tab), run: str(s.run), notice: str(s.notice) }),
  component: function CampaignRoute() {
    const w = useWorkspace();
    const { campaignId } = campaignRoute.useParams();
    const { tab, run, notice } = campaignRoute.useSearch();
    return <Campaign workspaceId={w.workspaceId} id={campaignId} role={w.role} tab={tab ?? null} run={run} notice={notice} />;
  },
});
const newsletterRoute = page("newsletter", function NewsletterRoute() {
  const w = useWorkspace();
  return (
    <>
      <CampaignNav />
      <NewsletterSettings workspaceId={w.workspaceId} role={w.role} />
    </>
  );
}, NewsletterSettings);
const issueRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  loader: preloading(Issue),
  path: "newsletter/$issueId",
  component: function IssueRoute() {
    const w = useWorkspace();
    return <Issue workspaceId={w.workspaceId} itemId={issueRoute.useParams().issueId} role={w.role} />;
  },
});
const seoRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  loader: preloading(Seo),
  path: "seo",
  validateSearch: (s: Record<string, unknown>): { connect_error?: string } => ({ connect_error: str(s.connect_error) }),
  component: function SeoRoute() {
    const w = useWorkspace();
    return (
      <>
        <CampaignNav />
        <Seo workspaceId={w.workspaceId} role={w.role} notice={seoRoute.useSearch().connect_error} />
      </>
    );
  },
});

// Audience, in the order the work runs: find companies, make segments, then the People. The section opens on People.
function PeopleNav() {
  const params = { workspaceId: useWorkspace().workspaceId };
  return (
    <SectionNav label="Audience">
      <Link to="/w/$workspaceId/people/find" params={params} className={sectionLink}>
        Find companies
      </Link>
      <Link to="/w/$workspaceId/people/cohorts" params={params} className={sectionLink}>
        Segments
      </Link>
      <Link to="/w/$workspaceId/people" params={params} className={sectionLink} activeOptions={{ exact: true }}>
        People
      </Link>
    </SectionNav>
  );
}
const peopleRoute = page("people", function PeopleRoute() {
  const w = useWorkspace();
  return (
    <>
      <PeopleNav />
      <Outreach workspaceId={w.workspaceId} role={w.role} />
    </>
  );
}, Outreach);
const findRoute = page("people/find", function FindRoute() {
  const w = useWorkspace();
  return (
    <>
      <PeopleNav />
      <Find workspaceId={w.workspaceId} role={w.role} />
    </>
  );
}, Find);
const runRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  loader: preloading(Run),
  path: "people/find/$runId",
  component: function RunRoute() {
    const w = useWorkspace();
    return (
      <>
        <PeopleNav />
        <Run workspaceId={w.workspaceId} role={w.role} id={runRoute.useParams().runId} />
      </>
    );
  },
});
const cohortsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  loader: preloading(Cohorts),
  path: "people/cohorts",
  // `runs`: the searches a new segment starts from, read by Cohorts (presetRuns).
  validateSearch: (s: Record<string, unknown>): { runs?: string } => ({ runs: str(s.runs) }),
  component: function CohortsRoute() {
    const w = useWorkspace();
    return (
      <>
        <PeopleNav />
        <Cohorts workspaceId={w.workspaceId} role={w.role} />
      </>
    );
  },
});
const cohortRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  loader: preloading(Cohorts),
  path: "people/cohorts/$cohortId",
  component: function CohortRoute() {
    const w = useWorkspace();
    return (
      <>
        <PeopleNav />
        <Cohorts workspaceId={w.workspaceId} role={w.role} id={cohortRoute.useParams().cohortId} />
      </>
    );
  },
});
const handoverRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  loader: preloading(Handover),
  path: "people/handovers/$handoverId",
  component: function HandoverRoute() {
    return (
      <>
        <PeopleNav />
        <Handover workspaceId={useWorkspace().workspaceId} id={handoverRoute.useParams().handoverId} />
      </>
    );
  },
});

const setupRoute = page("setup", function SetupRoute() {
  const w = useWorkspace();
  return <Setup workspaceId={w.workspaceId} workspaceName={w.workspace.name} role={w.role} />;
}, Setup);
const brandRoute = page("brand", function BrandRoute() {
  const w = useWorkspace();
  return (
    <Brand workspaceId={w.workspaceId} role={w.role} />
  );
}, Brand);
// Lessons sit on Brand under How we sound; their old link opens Brand on them.
const lessonsRoute = page("brand/lessons", function LessonsRoute() {
  const w = useWorkspace();
  return <Brand workspaceId={w.workspaceId} role={w.role} open="lessons" />;
}, Brand);

// Settings.
function SettingsNav() {
  const w = useWorkspace();
  const params = { workspaceId: w.workspaceId };
  const flagged = new Set(useNeeds(w.workspace, w.me.id).list.map((n) => n.to));
  // A dot on each screen where something needs someone, with words for a screen reader.
  const link = (to: Need["to"], label: string) => (
    <Link to={to} params={params} className={sectionLink}>
      {label}
      {flagged.has(to) && (
        <>
          {/* Sienna, the "needs you" ink; red is kept for errors and the pause. */}
          <span aria-hidden className="ml-1.5 size-2 rounded-full bg-peach-foreground" />
          <span className="sr-only">, needs you</span>
        </>
      )}
    </Link>
  );
  return (
    <SectionNav label="Settings">
      <Link to="/w/$workspaceId/settings" params={params} activeOptions={{ exact: true }} className={sectionLink}>
        Overview
      </Link>
      {/* Where Direx sends, then how it works, then who is in the Workspace. */}
      {link("/w/$workspaceId/settings/credentials", "Email and keys")}
      <Link to="/w/$workspaceId/settings/sending" params={params} className={sectionLink}>
        Who is sending
      </Link>
      {link("/w/$workspaceId/settings/social", "Social accounts")}
      {link("/w/$workspaceId/settings/models", "AI models")}
      {link("/w/$workspaceId/settings/rules", "Auto-approve")}
      {mayApprove(w.role) && (
        <Link to="/w/$workspaceId/settings/review-time" params={params} className={sectionLink}>
          Review time
        </Link>
      )}
      <Link to="/w/$workspaceId/settings/members" params={params} className={sectionLink}>
        Members
      </Link>
    </SectionNav>
  );
}
const connectSearch = (s: Record<string, unknown>): { connect_error?: string; connected?: string } => ({ connect_error: str(s.connect_error), connected: str(s.connected) });
const settingsRoute = page("settings", function SettingsRoute() {
  const w = useWorkspace();
  return (
    <>
      <SettingsNav />
      <SettingsOverview workspace={w.workspace} me={w.me.id} />
    </>
  );
}, SettingsOverview);
const reviewTimeRoute = page("settings/review-time", function ReviewTimeRoute() {
  const w = useWorkspace();
  return (
    <>
      <SettingsNav />
      <ReviewTime workspaceId={w.workspaceId} role={w.role} />
    </>
  );
}, ReviewTime);
const sendingRoute = page("settings/sending", function SendingRoute() {
  const w = useWorkspace();
  return (
    <>
      <SettingsNav />
      <Sending workspaceId={w.workspaceId} role={w.role} />
    </>
  );
}, Sending);
const membersRoute = page("settings/members", function MembersRoute() {
  const w = useWorkspace();
  return (
    <>
      <SettingsNav />
      <Members workspace={w.workspace} me={w.me.id} />
    </>
  );
}, Members);
const credentialsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  loader: preloading(Credentials),
  path: "settings/credentials",
  validateSearch: (s: Record<string, unknown>): ReturnType<typeof connectSearch> & { tab?: string } => ({ ...connectSearch(s), tab: str(s.tab) }),
  component: function CredentialsRoute() {
    const w = useWorkspace();
    const s = credentialsRoute.useSearch();
    const navigate = credentialsRoute.useNavigate();
    // The tab is in the address, so a reload, Back, or a sign-in in between comes back to it.
    return (
      <>
        <SettingsNav />
        <Credentials workspace={w.workspace} me={w.me.id} tab={s.tab} onTab={(tab) => void navigate({ search: (old) => ({ ...old, tab }), replace: true })} notice={s.connect_error} />
      </>
    );
  },
});
const socialRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  loader: preloading(Social),
  path: "settings/social",
  validateSearch: connectSearch,
  component: function SocialRoute() {
    const w = useWorkspace();
    const s = socialRoute.useSearch();
    return (
      <>
        <SettingsNav />
        <Social workspace={w.workspace} me={w.me.id} notice={s.connect_error} connected={s.connected} />
      </>
    );
  },
});
const modelsRoute = page("settings/models", function ModelsRoute() {
  return (
    <>
      <SettingsNav />
      <Models workspace={useWorkspace().workspace} />
    </>
  );
}, Models);
const rulesRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  loader: preloading(Rules),
  path: "settings/rules",
  validateSearch: (s: Record<string, unknown>): { campaign?: string; step?: string; mode?: string } => ({ campaign: str(s.campaign), step: str(s.step), mode: str(s.mode) }),
  component: function RulesRoute() {
    const w = useWorkspace();
    const s = rulesRoute.useSearch();
    return (
      <>
        <SettingsNav />
        <Rules workspaceId={w.workspaceId} role={w.role} grantFor={s.campaign && s.step ? { campaignId: s.campaign, stepKey: s.step } : undefined} agentWritten={s.mode === "agent_written"} />
      </>
    );
  },
});

export const routeTree = rootRoute.addChildren([
  resetRoute,
  signedInRoute.addChildren([
    indexRoute,
    inviteRoute,
    claimRoute,
    newOrgRoute,
    serverRoute,
    addPasswordRoute,
    deletedWorkspacesRoute,
    workspaceRoute.addChildren([
      homeRoute,
      setupRoute,
      reviewRoute,
      reviewItemRoute,
      calendarRoute,
      plansRoute,
      planRoute,
      campaignsRoute,
      campaignRoute,
      newsletterRoute,
      issueRoute,
      seoRoute,
      peopleRoute,
      findRoute,
      runRoute,
      cohortsRoute,
      cohortRoute,
      handoverRoute,
      brandRoute,
      lessonsRoute,
      settingsRoute,
      sendingRoute,
      membersRoute,
      credentialsRoute,
      socialRoute,
      modelsRoute,
      rulesRoute,
      reviewTimeRoute,
    ]),
  ]),
]);

/** A link that leads nowhere still shows where you are and the way back. */
export function NotFound() {
  return (
    <EmptyState
      title="This page doesn't exist"
      action={
        <Link to="/" className={buttonVariants({ variant: "outline" })}>
          Go to Home
        </Link>
      }
    >
      The link may be old, or the page was removed.
    </EmptyState>
  );
}

/** How URLs match, shared with the tests' routers. */
export const routerOptions = { trailingSlash: "never", defaultNotFoundComponent: NotFound } as const;

export const router = createRouter({ routeTree, defaultPreload: "intent", ...routerOptions, context: { queryClient } });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
