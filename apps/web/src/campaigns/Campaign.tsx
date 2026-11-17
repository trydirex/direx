// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import { inWorkspace } from "../api/query";
import { Notice, Page } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button, buttonVariants } from "@/components/Button";
import { toast } from "@/components/toast";
import { useAction } from "../components/useAction";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Drawer } from "@astryxdesign/core/Drawer";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { ChannelMark, channelOf } from "../components/ChannelMark";
import { CampaignRows } from "./List";
import { Activity } from "./Activity";
import { countWords, Overview, StatusChip, stepOf, useNeedApproval, useStepCounts, useWaiting } from "./Overview";
import { isoDay, mayApprove, mayEdit, needsYouQuery, type Role } from "../items/actions";
import { ItemDialog } from "../items/ItemPanel";
import type { HoldHook } from "../outreach/actions";
import { SectionNav, sectionLink } from "../shell/Shell";
import { SignIn } from "../identity/SignIn";
import { Plan } from "../plans/Plan";
import { DmStep } from "./DmStep";
import { PersonStep } from "./PersonStep";
import { PostStep } from "./PostStep";
import { BriefStep } from "./BriefStep";
import { ClipsStep } from "./ClipsStep";
import { TemplateStep } from "./Step";
import { PlanChangeChoice } from "./PlanChange";
import { People } from "./People";
import { kindWords, LaunchLine, ManualLink, StepRow, type Box } from "./Setup";
import { CAMPAIGN_MESSAGES, campaignQuery, dayWords, deleteDraft, holdHookQuery, mailboxesQuery, progressLine, progressQuery, saveStep, say, setAdvance, setCampaignPaused, setOutsideContent, setStepDraftingMode, type Loaded, type Person, type Step } from "./actions";
import { Confirm } from "@/components/Confirm";
import { meQuery } from "@/shell/session";

const TABS = [
  ["overview", "Overview"],
  ["plan", "Plan"],
  ["drafts", "Content"],
  ["people", "People"],
] as const;
export type Tab = (typeof TABS)[number][0];
/** ADR 0023: before its plan's first approval a Campaign holds only its plan, so it shows these tabs and opens on Plan. */
const EARLY_TABS: readonly Tab[] = ["overview", "plan"];
const early = (c: Pick<Loaded, "status"> | undefined) => c?.status === "draft" || c?.status === "awaiting_signoff";
/** Which tab shows: the asked one if this Campaign has it, else Plan for a Draft and Overview for the rest. */
export function tabFor(asked: string | null | undefined, campaign: Pick<Loaded, "status"> | undefined): Tab {
  const allowed = early(campaign) ? EARLY_TABS : TABS.map(([key]) => key);
  return allowed.find((key) => key === asked) ?? (early(campaign) ? "plan" : "overview");
}
/** One campaign, opening on its Overview, or on its Plan while a Draft. The Plan tab is the plan editor; approving stays in Items. `run` and `notice` are a drafting run's progress or refusal, shown on Plan. */
// ponytail: "before its first approval" is read as nothing sent yet; HubSpot joins the check when its plugin exists.
/** A cold email step that hasn't sent, so a Workspace with no CRM connected may email someone it's talking to. */
export const blindToDeals = (c: Pick<Loaded, "sent" | "steps">) => c.sent === 0 && c.steps.some((s) => s.touchClass === "cold" && s.type !== "dm");

/** What a step sends, in the plural. */
const UNITS: Record<string, string> = { post: "posts", dm: "messages" };
const unitsOf = (s: Pick<Step, "type">) => UNITS[s.type] ?? "emails";

/** A step's channel for its mark: a DM shows its network. */
const markOf = (s: Step) => channelOf(s.type === "dm" ? (s.dmChannel ?? "linkedin") : s.type);

export function Campaign(p: { workspaceId: string; id: string; role: Role; tab?: string | null; run?: string; notice?: string; initial?: { campaign: Loaded; boxes: Box[]; people?: Person[]; hook?: HoldHook } }) {
  const { workspaceId, id, role } = p;
  const client = useQueryClient();
  const query = useQuery({ ...campaignQuery(workspaceId, id), initialData: p.initial?.campaign });
  const tab = tabFor(p.tab, query.data);
  const tabs = early(query.data) ? TABS.filter(([key]) => EARLY_TABS.includes(key)) : TABS;
  const wide = tab === "plan" || tab === "drafts";
  const boxes = useQuery({ ...mailboxesQuery(workspaceId), initialData: p.initial?.boxes }).data ?? [];
  const hook = useQuery({ ...holdHookQuery(workspaceId), initialData: p.initial?.hook }).data;
  const needApproval = useNeedApproval(workspaceId, id);
  const waiting = useQuery(needsYouQuery(workspaceId)).data?.items;
  const [error, setError] = useState<string>();
  const [drawer, setDrawer] = useState<"launch" | "settings">();
  const [openItem, setOpenItem] = useState<string>();
  const pause = useAction();
  const [stepUp, setStepUp] = useState(false);
  const edit = mayEdit(role);
  const owner = role === "owner" || role === "admin";
  const load = () => client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
  /** After a change: its refusal, or step-up sign-in, then a fresh read. */
  const settle = async (failed: string | null) => {
    if (failed === "step_up_required") return setStepUp(true);
    setError(failed ? say(failed) : undefined);
    await load();
  };
  if (stepUp) return <SignIn title="Sign in again, then change this once more" callbackURL={location.pathname + location.search} />;
  /** The one thing this Campaign needs from a person now, by its state; nothing when nothing does. */
  const primary = (campaign: Loaded): ReactNode => {
    if (!early(campaign) && needApproval > 0)
      return (
        <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId, campaignId: id }} search={{ tab: "drafts" }} className={buttonVariants()}>
          {`Review ${needApproval} ${needApproval === 1 ? "draft" : "drafts"}`}
        </Link>
      );
    if (campaign.status === "no_launch_date" && edit) return <Button onClick={() => setDrawer("launch")}>Pick a launch date</Button>;
    // The plan's version waits on Home as an Item; signing it off here opens that same Item.
    const signoff = waiting?.find((i) => i.kind === "plan_version" && i.groupKey?.startsWith(`plan:${campaign.planId}`));
    if (campaign.status === "awaiting_signoff" && signoff && mayApprove(role)) return <Button onClick={() => setOpenItem(signoff.id)}>Sign off plan</Button>;
    return null;
  };
  const menu = (campaign: Loaded) => [
    ...(edit && !early(campaign) ? [{ id: "launch", label: "Move dates", onClick: () => setDrawer("launch") }] : []),
    ...(!early(campaign) ? [{ id: "settings", label: "Campaign settings", onClick: () => setDrawer("settings") }] : []),
    ...(campaign.status !== "draft" && mayApprove(role)
      ? [
          {
            id: "pause",
            label: campaign.paused ? "Resume this campaign" : "Pause this campaign",
            onClick: () =>
              void pause.run(async () => {
                await settle(await setCampaignPaused(workspaceId, id, !campaign.paused));
                return null;
              }),
          },
        ]
      : []),
  ];
  return (
    <>
      <Link to="/w/$workspaceId/campaigns" params={{ workspaceId }} className="mb-4 inline-flex text-sm text-muted-foreground no-underline hover:text-foreground">
        <span aria-hidden>←&nbsp;</span>Campaigns
      </Link>
      {/* Plan and Content are editors: they take the full width, without the list of campaigns beside them. */}
      <div className={wide ? "grid gap-6" : "grid gap-6 split:grid-cols-4"}>
        {!wide && <CampaignRows workspaceId={workspaceId} current={id} tab={tab} />}
        <div className={wide ? "min-w-0" : "min-w-0 split:col-span-3"}>
          <QueryBoundary query={query} skeleton={<Skeleton className="h-96 w-full" />} messages={CAMPAIGN_MESSAGES}>
            {(campaign) => {
              const items = menu(campaign);
              const launched = campaign.anchor.on && campaign.anchor.on <= isoDay(new Date());
              return (
                <Page
                  title={campaign.title}
                  description={
                    <span className="flex flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <StatusChip campaign={campaign} />
                        {[campaign.startsOn && `${dayWords(campaign.startsOn)}${campaign.endsOn ? ` to ${dayWords(campaign.endsOn)}` : ""}`, campaign.goal && `Goal: ${campaign.goal}`].filter(Boolean).join(" · ")}
                      </span>
                      <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        {campaign.anchor.on ? `${launched ? "Launched" : "Launches"} ${dayWords(campaign.anchor.on)}` : "No launch date yet"}
                        {edit && (
                          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setDrawer("launch")}>
                            {campaign.anchor.on ? "Move dates" : "Pick a date"}
                          </Button>
                        )}
                      </span>
                    </span>
                  }
                  actions={
                    <>
                      {campaign.status === "draft" && <DeleteDraft workspaceId={workspaceId} id={id} role={role} createdBy={campaign.createdBy} onRefused={(e) => void settle(e)} />}
                      {items.length > 0 && (
                        <DropdownMenu button={{ label: "More actions", icon: <EllipsisIcon aria-hidden className="size-4" />, isIconOnly: true, variant: "ghost", isLoading: pause.pending }} items={items} />
                      )}
                      {primary(campaign)}
                    </>
                  }
                >
                  <SectionNav label="Campaign">
                    {tabs.map(([key, label]) => (
                      <Link key={key} to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId, campaignId: id }} search={{ tab: key }} className={sectionLink} aria-current={key === tab ? "page" : undefined}>
                        {label}
                        {key === "drafts" && needApproval > 0 && <span className="ml-1.5 rounded-full bg-peach px-1.5 text-xs text-peach-foreground tabular-nums">{needApproval}</span>}
                      </Link>
                    ))}
                  </SectionNav>
                  {campaign.paused && mayApprove(role) && <Notice>Paused: its emails are held, and each is checked again before it goes.</Notice>}
                  {hook === null && blindToDeals(campaign) && (
                    <p role="note" className="rounded-card bg-muted px-4 py-3">
                      Direx can't see your deals. People you're talking to may get this email.{" "}
                      <Link to="/w/$workspaceId/settings/sending" params={{ workspaceId }} hash="hold-hook">
                        Connect your CRM
                      </Link>
                    </p>
                  )}
                  {error && <Notice tone="error">{error}</Notice>}
                  <Drawer isOpen={drawer === "launch"} onOpenChange={(open) => !open && setDrawer(undefined)} label="Launch" side="end" width={480} experimental={{ isFullWidthOnMobile: true }}>
                    <LaunchLine workspaceId={workspaceId} id={id} campaign={campaign} edit={edit} onChange={() => void load()} />
                  </Drawer>
                  <Drawer isOpen={drawer === "settings"} onOpenChange={(open) => !open && setDrawer(undefined)} label="Campaign settings" side="end" width={480} experimental={{ isFullWidthOnMobile: true }}>
                      <div className="flex flex-col gap-6">
                        <div className="flex flex-col gap-1">
                          <label className="flex items-start gap-2">
                            <input type="checkbox" className="mt-1 size-4" checked={campaign.advance === "run"} disabled={!owner} onChange={async (e) => settle(await setAdvance(workspaceId, id, e.target.checked))} /> Start next steps on their own, as me
                          </label>
                          <small className="text-sm text-muted-foreground">
                            Drafting the text and making each person's draft starts without a Start press. Every draft still waits for approval.
                            {campaign.advanceUpToCents > 0 && ` Model cost before anyone approves: up to $${(campaign.advanceUpToCents / 100).toFixed(2)}.`}
                          </small>
                        </div>
                        {campaign.steps.some((s) => s.draftingMode === "per_person") && owner && (
                          <div className="flex flex-col gap-1">
                            <label className="flex items-start gap-2">
                              <input type="checkbox" className="mt-1 size-4" checked={campaign.outsideContentAllowed} onChange={async (e) => settle(await setOutsideContent(workspaceId, id, e.target.checked))} /> Emails shaped by each person's website and list details may go out under
                              auto-approve without anyone reading them
                            </label>
                            <small className="text-sm text-muted-foreground">What a website says can steer what the agent writes. Changing this stops any auto-approve rule on this campaign until someone re-confirms it.</small>
                          </div>
                        )}
                      </div>
                  </Drawer>
                  <ItemDialog workspaceId={workspaceId} id={openItem} role={role} onClose={() => setOpenItem(undefined)} />
                  {tab === "plan" && <Plan workspaceId={workspaceId} id={campaign.planId} role={role} runId={p.run} notice={p.notice} embedded />}
                  {tab === "overview" && <Overview workspaceId={workspaceId} campaign={campaign} edit={edit} role={role} />}
                  {tab === "people" && <People workspaceId={workspaceId} id={id} edit={edit} initial={p.initial?.people} />}
                  {tab === "drafts" && <Content workspaceId={workspaceId} id={id} role={role} campaign={campaign} boxes={boxes} settle={settle} setError={setError} load={load} />}
                </Page>
              );
            }}
          </QueryBoundary>
        </div>
      </div>
    </>
  );
}

/** The Content tab: the steps on the left, and the selected one's writing on the right with its setup behind Step settings. */
function Content(p: { workspaceId: string; id: string; role: Role; campaign: Loaded; boxes: Box[]; settle: (failed: string | null) => Promise<void>; setError: (e: string | undefined) => void; load: () => Promise<void> }) {
  const { workspaceId, id, role, campaign } = p;
  const load = () => void p.load();
  const edit = mayEdit(role);
  const owner = role === "owner" || role === "admin";
  const drafted = useQuery(progressQuery(workspaceId, id)).data ?? [];
  const counts = useStepCounts(workspaceId, campaign);
  const waiting = useWaiting(workspaceId, id);
  const [picked, setPicked] = useState<string>();
  const [settings, setSettings] = useState(false);
  // A refused save shows inside the drawer, where the person is looking, not on the page behind it.
  const [settingsError, setSettingsError] = useState<string>();
  // Text saved, or any draft made from it: the API then refuses a new "Written as" (drafting_mode_locked).
  const written = (x: Step) => !!x.template || Object.values(counts[x.key] ?? {}).some(Boolean);
  // Opens on the first step that needs approval, so the writing waiting for a yes is what shows.
  const first = campaign.steps.find((s) => waiting.some((i) => i.state === "needs_approval" && stepOf(id, i) === s.key) || counts[s.key]?.needs_approval) ?? campaign.steps[0];
  const s = campaign.steps.find((x) => x.key === picked) ?? first;
  const line = (x: Step) => countWords(counts[x.key]) || progressLine(drafted.find((d) => d.stepKey === x.key)) || kindWords(x);
  return (
    <div className="grid gap-6 lg:grid-cols-4">
      <div className="flex min-w-0 flex-col gap-6">
        <nav aria-label="Steps">
          <ul className="flex flex-col overflow-hidden rounded-card border border-border bg-card">
            {campaign.steps.map((x) => (
              <li key={x.key} className="border-b border-border last:border-b-0">
                <button type="button" aria-current={x.key === s?.key ? "true" : undefined} onClick={() => setPicked(x.key)} className="flex w-full items-start gap-3 rounded-none border-0 bg-transparent px-4 py-3 text-left hover:bg-muted aria-[current=true]:bg-primary-tint">
                  <ChannelMark channel={markOf(x)} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{x.title ?? x.key}</span>
                    <span className="text-xs text-muted-foreground">{[x.on && dayWords(x.on), x.cancelled ? "Cancelled" : x.inPlan ? line(x) : "No longer in the plan"].filter(Boolean).join(" · ")}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <Activity workspaceId={workspaceId} id={id} edit={edit} />
      </div>
      {s && (
        <section aria-label={s.title ?? s.key} className="flex min-w-0 flex-col gap-4 lg:col-span-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <h2 className="text-lg">{s.title ?? s.key}</h2>
              <p className="text-sm text-muted-foreground">
                {[s.on && dayWords(s.on), kindWords(s), s.dependsOnStepKey && `goes out after ${campaign.steps.find((o) => o.key === s.dependsOnStepKey)?.title ?? s.dependsOnStepKey} goes live`].filter(Boolean).join(" · ")}
              </p>
            </div>
            {edit && s.inPlan && (
              <Button variant="outline" size="sm" onClick={() => setSettings(true)}>
                Step settings
              </Button>
            )}
          </div>
          {edit && s.inPlan && (
          <Drawer isOpen={settings} onOpenChange={setSettings} label={`Settings for ${s.title ?? s.key}`} side="end" width={480} experimental={{ isFullWidthOnMobile: true }}>
              <div className="flex flex-col gap-6">
                {settingsError && <Notice tone="error">{settingsError}</Notice>}
                <StepRow
                  key={s.key}
                  step={s}
                  steps={campaign.steps}
                  boxes={p.boxes}
                  edit={edit}
                  unfolded
                  withMode={!written(s)}
                  onSave={async (setup, mode) => {
                    // One Save: the setup first, then the writing mode if it changed, so a refused setup changes nothing.
                    let failed = await saveStep(workspaceId, id, s.key, setup);
                    if (!failed && mode && mode !== (s.draftingMode ?? "template")) failed = await setStepDraftingMode(workspaceId, id, s.key, mode);
                    if (failed === "step_up_required") return p.settle(failed);
                    setSettingsError(failed ? say(failed) : undefined);
                    if (!failed) {
                      toast.add({ title: `Saved ${(s.title ?? s.key).replace(/\.$/, "")}.` });
                      setSettings(false);
                    }
                    await p.load();
                  }}
                />
                {s.type === "email" && !s.cancelled && written(s) && <p className="text-sm">{`Written as: ${s.draftingMode === "per_person" ? "personalised for each person" : "the same email for everyone"}. This step already has writing in it, so that can't change now.`}</p>}
                {s.type === "email" && s.draftingMode === "template" && owner && (
                  <p>
                    <Link to="/w/$workspaceId/settings/rules" params={{ workspaceId }} search={{ campaign: id, step: s.key }}>
                      Set up auto-approve
                    </Link>
                  </p>
                )}
                {s.type === "email" && s.draftingMode === "per_person" && campaign.outsideContentAllowed && owner && (
                  <p>
                    <Link to="/w/$workspaceId/settings/rules" params={{ workspaceId }} search={{ campaign: id, step: s.key, mode: "agent_written" }}>
                      Set up auto-approve for emails no one reads
                    </Link>
                  </p>
                )}
              </div>
          </Drawer>
          )}
          {(() => {
            const d = drafted.find((x) => x.stepKey === s.key);
            const total = d ? d.written + d.toWrite : 0;
            return total > 0 && <ProgressBar label={`${s.title ?? s.key}: drafts written`} isLabelHidden value={d!.written} max={total} />;
          })()}
          {s.inPlan && s.type === "manual" && <ManualLink workspaceId={workspaceId} id={id} step={s} edit={edit} onSaved={load} />}
          {s.planChange && (
            <div role="region" aria-label={`Plan changed ${s.title ?? s.key}`} className="flex flex-col gap-3">
              <p role="status">{`The plan changed this step. Its ${unitsOf(s)} wait until you choose.`}</p>
              <PlanChangeChoice workspaceId={workspaceId} campaignId={id} stepKey={s.key} itemId={s.planChange.itemId} kinds={s.planChange.kinds} current={s.template} suggested={s.planChange.suggestedTemplate} expired={s.planChange.expired} edit={edit} onDone={load} />
            </div>
          )}
          {s.cancelled && <Notice>{`Cancelled. Its unsent ${unitsOf(s)} were cancelled too.`}</Notice>}
          {s.waived && <Notice>Going ahead without the link it waited for.</Notice>}
          {s.inPlan && s.waitingOn && <Notice>{`Waiting for the link from ${campaign.steps.find((o) => o.key === s.waitingOn)?.title ?? s.waitingOn}. Drafts can be made once it's added.`}</Notice>}
          {s.inPlan && s.type === "email" && s.draftingMode === "template" && !s.cancelled && <TemplateStep key={s.key} workspaceId={workspaceId} id={id} step={s} edit={edit} onChange={load} />}
          {s.inPlan && s.type === "dm" && <DmStep key={s.key} workspaceId={workspaceId} id={id} step={s} edit={edit} />}
          {s.inPlan && s.type === "post" && <PostStep key={s.key} workspaceId={workspaceId} id={id} step={s} edit={edit} approve={mayApprove(role)} onChange={load} />}
          {s.inPlan && s.type === "seo_brief" && (
            <BriefStep key={s.key} workspaceId={workspaceId} id={id} step={s} edit={edit}>
              <ManualLink workspaceId={workspaceId} id={id} step={s} edit={edit} label="WordPress draft link" onSaved={load} />
            </BriefStep>
          )}
          {s.inPlan && s.type === "clips" && <ClipsStep key={s.key} workspaceId={workspaceId} id={id} step={s} edit={edit} approve={mayApprove(role)} />}
          {s.inPlan && s.type === "email" && s.draftingMode === "per_person" && <PersonStep key={s.key} workspaceId={workspaceId} id={id} step={s} edit={edit} />}
        </section>
      )}
    </div>
  );
}

/** ADR 0023: a Draft's creator, or an Owner or Admin, deletes it with its plan, for good. */
function DeleteDraft(p: { workspaceId: string; id: string; role: Role; createdBy: string | null; onRefused: (error: string) => void }) {
  const me = useQuery(meQuery).data;
  const navigate = useNavigate();
  const client = useQueryClient();
  if (!(p.role === "owner" || p.role === "admin" || (p.createdBy !== null && me?.id === p.createdBy))) return null;
  return (
    <Confirm
      trigger={
        <Button type="button" variant="outline">
          Delete draft
        </Button>
      }
      title="Delete this draft?"
      body="The campaign and its plan are deleted for good. This can't be undone."
      confirm="Delete draft"
      onConfirm={async () => {
        const failed = await deleteDraft(p.workspaceId, p.id);
        if (failed) return p.onRefused(failed);
        toast.add({ title: "Draft deleted." });
        await navigate({ to: "/w/$workspaceId/campaigns", params: { workspaceId: p.workspaceId } });
        // After leaving, so the deleted Campaign isn't read again; the list drops it.
        await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId) });
      }}
    />
  );
}
