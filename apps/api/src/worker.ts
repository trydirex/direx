// SPDX-License-Identifier: AGPL-3.0-only
// The job worker: runs the ledger Dispatcher for every ledger.dispatch wake. main.ts starts it in
// every role; the role decides whether it works and schedules queues (ADR 0027 rule 002). compose
// builds every module with producers only, and startWork connects and starts the work (rule 001).
import { firstPartyPlugins, socialNetworks } from "@direx/extensions";
import { VERIFY_ADDRESS, type EffectCapability, type MediaRef } from "@direx/plugin-sdk";
import { createBoss } from "./jobs/boss";
import { roleFromEnv, sendOnly, type Role } from "./roles";
import { createAgents, createFetchHtml, createFetchImage, factContext, factSink, shippedEvals, sinkByOutputKey, starterNotice, type Agents, type AskStart } from "./modules/agents/index";
import { agentWrittenGate, campaignCheck, campaignDefinitions, campaignKinds, campaignOnPlanApproved, campaignReplies, campaignRulePort, campaignSinks, stepOutputVersion, templateVersion, type Campaigns, type PostPort } from "./modules/campaigns/index";
import { clipDefinitions, createClips, MOMENTS_OUTPUT_KEY, type Clips, type Measure } from "./modules/clips/index";
import { createFacts, describeFactChange, factKinds, factVersion } from "./modules/facts/index";
import type { Media } from "./modules/media/index";
import type { Exports } from "./modules/retention/index";
import { credentialLabel, credentialReady, dataDir, suppressionHasher, type Vault } from "./modules/credentials/index";
import { adminEmails, approverMayApprove, mayGrantRules, memberEmail, workspaceLive, type Mailer } from "./modules/identity/index";
import { createItems, routeCapacity, warn } from "./modules/items/index";
import { createLessons, lessonCheckOpen } from "./modules/lessons/index";
import { BRIEF_OUTPUT_KEY, briefSink, createPageReader, seoDefinitions, seoKinds, type Briefs } from "./modules/seo/index";
import { COMPARISON_OUTPUT_KEY, competitorDefinitions, competitorKinds, createLabels, createMoves, LABELS_OUTPUT_KEY, POST_OUTPUT_KEY } from "./modules/competitors/index";
import { newsletterAfterSend, newsletterKinds, newsletterWeekly } from "./modules/newsletter/index";
import { createStandingRules, ruleStillCovers, standingRuleKinds, suspendForAgent, suspendOnProviderLimit, suspendOnStale } from "./modules/standing-rules/index";
import { connectedMailboxes, createReplies, createReplyDesk, mailMembers, replyDeskKind, finishHeaderCheck, humanReply, isProbeCapability, mailFrom, newsletterSync, optOutReviewKind, outreachFloors, pauseOnProviderAbuse, probeRecipient, slowOnSendingLimit, sweepRamps, probeWordingVersion, recordSentMail, sendingPaused, type Outreach, type ProbeFor, type SendFor } from "./modules/outreach/index";
import { planDefinitions, planKinds, planSinks } from "./modules/plans/index";
import { createLedger, type SigningKeys } from "./modules/ledger/index";
import { accountHealthCheck, pauseOnAccountLimit, postAppearance, postLimitCheck, previewOf, socialCapacity, socialKinds } from "./modules/social/index";
import { companyReviews, createCompanyReader, createHandovers, createRuns, createVerifier, NAMES_OUTPUT_KEY, namesEnded, namesSink, prospectingDefinitions, prospectKinds, TERMS_OUTPUT_KEY, termsSink, verifyThrough, workCompanyReads, workCompanyVerifies, workHandovers, type StartNames, type VerifyAddress, type VerifyQuery } from "./modules/prospecting/index";
import { deploymentFromEnv, modelSignInKind, modelsFromEnv, routesFor, sandboxStatus, signInNeeds, workHoldWatch, type Models } from "./modules/models/index";
import { confinedSpawn, docsProviders, EMAIL_RECEIVED, installGate, listenForInstalls, listInstalled, loadPlugins, MAIL_SENT, mailboxRepliesRead, newsletterLists, webhookVerifier, type Plugins } from "./modules/plugins/index";
import { mailboxDayCheck, timeZoneOf, touchCheck } from "./modules/schedule/index";
import { noDiscovery, type Discovery } from "./modules/extensions/index";
import type { NextSteps } from "./modules/next-steps/index";
import { createCoreReads, type StartSources } from "./modules/core-reads/index";
import { askAgent, askKinds, askStartJob, askStartKinds, createAsk, workAskStarts } from "./modules/ask/index";
import { contentTestVersion, createContentTests, createPlacement, createReading, createReporting, createSending, isPlacementCapability, matchExpected, placementGranted, placementGrantVersion, placementSendCheck, routePlacement, skipFor, stopOnAccountLimit, type JoinFor } from "./modules/placement/index";
import { createWriteBack, docWriteCurrent, docWriteGrantVersion, isDocsWrite } from "./modules/docs/index";
import { join } from "node:path";
import { DRAIN_DEADLINE_MS } from "./shutdown";
import { sweeps } from "./compose/sweeps";
import { NEWSLETTER_SYNC_ONE, newsletterJobs } from "./compose/newsletter";
import { placementJobs } from "./compose/placement";
import { mailboxSearch } from "./compose/replies";
import { DOCS_WRITE_BACK_ONE, writeBackJobs } from "./compose/write-back";

export { PLACEMENT_DAILY, PLACEMENT_SWEEP } from "./compose/placement";
export { DOCS_WRITE_BACK } from "./compose/write-back";

export const MAILBOX_POLLS = "outreach.mailbox_polls";
const SOCIAL_HEALTH_SWEEP = "social.health_sweep";
const OPERATOR_HOLDS_RELEASE = "ledger.operator_holds_release";
const MAILBOX_RAMP_SWEEP = "outreach.mailbox_ramp_sweep";
const SEO_BRIEFS_WEEKLY = "seo.briefs.weekly";
const COMPETITORS_WEEKLY = "competitors.weekly_read";
const REPLIES_READ_WITHIN_MS = 60 * 60 * 1000;

/** The permission approving an Action needs, when not item.approve: a probe its connector's, placement and status write-back rule.grant. */
const actionPermission = (capability: string) => (isProbeCapability(capability) ? "credential.connect" : isPlacementCapability(capability) || isDocsWrite(capability) ? "rule.grant" : undefined);

/** Binds a draft to the provider behind its Mailbox; a credential that isn't a Mailbox has none. */
export const sendForCredential =
  (plugins: Pick<Plugins, "mailboxFor" | "prepare" | "capabilityVersion">, vault: Pick<Vault, "find">): SendFor =>
  async (workspaceId, credentialId) => {
    const credential = await vault.find(workspaceId, credentialId);
    const provider = plugins.mailboxFor(credential?.connection ?? null);
    if (!provider) return undefined;
    return { id: provider.send, dedupe: provider.dedupe, version: plugins.capabilityVersion(provider.send) ?? undefined, prepare: (ws, input) => plugins.prepare(ws, provider.send, input) };
  };

/** The Mailbox's probe pair, when its provider can check itself; none means it stays unchecked. */
export const probeForCredential =
  (plugins: Pick<Plugins, "mailboxFor" | "prepare" | "capabilityVersion">, vault: Pick<Vault, "find">): ProbeFor =>
  async (workspaceId, credentialId) => {
    const credential = await vault.find(workspaceId, credentialId);
    const probe = plugins.mailboxFor(credential?.connection ?? null)?.probe;
    if (!probe) return undefined;
    return {
      send: { id: probe.send, dedupe: probe.dedupe, version: plugins.capabilityVersion(probe.send) ?? undefined, prepare: (ws, input) => plugins.prepare(ws, probe.send, input) },
      read: probe.read,
    };
  };

/** The Mailbox provider's placement.join effect, or with "check" its placement.send, "report" its placement.report, "archive" its placement.archive; none means this Mailbox can't. */
export const joinForCredential =
  (plugins: Pick<Plugins, "mailboxFor" | "prepare" | "capabilityVersion">, vault: Pick<Vault, "find">, effect: "join" | "check" | "report" | "archive" = "join"): JoinFor =>
  async (workspaceId, credentialId) => {
    const credential = await vault.find(workspaceId, credentialId);
    const join = plugins.mailboxFor(credential?.connection ?? null)?.[effect];
    if (!join) return undefined;
    return { id: join.send, dedupe: join.dedupe, version: plugins.capabilityVersion(join.send) ?? undefined, prepare: (ws, input) => plugins.prepare(ws, join.send, input) };
  };

/**
 * Address checks through the first loaded plugin that verifies addresses, with the Workspace's active
 * credential on that plugin's connection. With neither, every check is unknown and nothing is sendable.
 */
export function verifyForWorkspace(plugins: { query: VerifyQuery }, vault: Pick<Vault, "list">, sources = firstPartyPlugins()): VerifyAddress {
  const found = sources.flatMap((p) => p.manifest.capabilities.flatMap((c) => (c.kind === "query" && c.name === VERIFY_ADDRESS ? [{ capability: `${p.manifest.id}/${VERIFY_ADDRESS}` as const, connection: c.connection }] : [])))[0];
  if (!found) return async () => null;
  return verifyThrough({
    query: plugins.query,
    capability: found.capability,
    credentialFor: async (workspaceId) => (await vault.list(workspaceId)).find((c) => c.connection === found.connection && c.status === "active")?.id ?? null,
  });
}

/**
 * Starts working jobs. With a vault, the first-party plugins load and each call gets its
 * credential from it; `effects` replaces them in tests.
 */
const FOLLOW_UP_CARDS = "next_steps.follow_up_cards";
const SHIPPED_DEFINITIONS = { ...planDefinitions, ...campaignDefinitions, ...prospectingDefinitions, ...seoDefinitions, ...clipDefinitions, ...competitorDefinitions, [askAgent.id]: askAgent };

/** Runs `make` on the first call and returns that result after, so the module holds no `let` (ADR 0027 rule 001). */
const once = <T>(make: () => T): (() => T) => {
  let made: { value: T } | undefined;
  return () => (made ??= { value: make() }).value;
};
/** What the model picker asks of the eval results, for the definitions this build runs. Read once: they ship with the code. */
export const modelEvals = once(() => shippedEvals(Object.values(SHIPPED_DEFINITIONS), routesFor(deploymentFromEnv())));

/** The server modules the worker's handlers reach. Each is required, so no handler skips its work for want of one (ADR 0027 rule 003). */
export type FeaturePorts = { exports: () => Pick<Exports, "work">; socialSweep: (credentials: { workspaceId: string; credentialId: string; connection: string }[]) => Promise<void>; outreach: () => Outreach; posts: () => PostPort; campaigns: () => Pick<Campaigns, "addPeopleRows" | "recipientNotes" | "editOf" | "warnTemplates" | "list" | "campaign" | "stepsWithoutDrafts" | "offerStalls" | "followAnchors" | "planApplied" | "settleAll" | "countReadings" | "redraftPerson" | "rewrite" | "writeUpBrief">; seoBriefs: () => Pick<Briefs, "weekly">; competitorsWeekly: () => Promise<void>; media: () => Pick<Media, "sweep" | "link" | "ref" | "read" | "upload">; planMeasures: (workspaceId: string, planId: string) => Promise<Measure[] | null>; clipStepDone: (workspaceId: string, runId: string) => Promise<void>; nextSteps: (boss: Parameters<NextSteps["work"]>[0]) => NextSteps; askStarts: (boss: Parameters<NextSteps["work"]>[0]) => () => readonly AskStart[]; startSources: StartSources };
/** Every feature port by name, so a caller that types its way past one still fails at composition. */
const FEATURE_PORTS: Record<keyof FeaturePorts, true> = { exports: true, socialSweep: true, outreach: true, posts: true, campaigns: true, seoBriefs: true, competitorsWeekly: true, media: true, planMeasures: true, clipStepDone: true, nextSteps: true, askStarts: true, startSources: true };
/** The feature ports, plus what a test replaces: plugins, keys, the vault and mailer. Discovery is an extension and defaults to the one that refuses. */
export type WorkerOptions = FeaturePorts & { effects?: Record<string, EffectCapability>; vault?: Vault; signingKeys?: SigningKeys; mailer?: Mailer; discovery?: Discovery; pluginSources?: ReturnType<typeof firstPartyPlugins>; role?: Role };

/** Builds every module the worker side runs. Nothing here connects, works a queue or schedules. */
export async function compose(opts: WorkerOptions) {
  for (const port of Object.keys(FEATURE_PORTS) as (keyof FeaturePorts)[]) if (!opts[port]) throw new Error(`the worker needs the ${port} port (ADR 0027 rule 003)`);
  // Approvals are signed with keys from the vault; only a test supplies its own.
  const signingKeys = opts.signingKeys ?? opts.vault?.approvalKeys;
  if (!signingKeys) throw new Error("the worker needs a vault to sign approvals");
  // The role decides only whether this process works and schedules queues (ADR 0027 rule 002).
  const role = opts.role ?? roleFromEnv();
  const boss = createBoss({ consume: role !== "api" });
  if (role === "api") sendOnly(boss);
  boss.on("error", (e) => console.error("worker:", e));
  // Every queue, schedule and consumer, registered in this order once everything is built, so no
  // handler runs before the modules it reaches exist (ADR 0027 rule 001).
  const starts: (() => Promise<unknown>)[] = [];
  const later = (start: () => Promise<unknown>) => void starts.push(start);
  // The server's next steps, built on this worker's queue so accepting one queues its start here.
  const next = opts.nextSteps(boss);
  // Work a person may start from Ask, each its owning module's own start, queued on this worker (ADR 0008 rule 028).
  const askStarts = opts.askStarts(boss);
  const replies = createReplies({
    boss,
    items: () => items,
    ledger: () => ledger,
    generate: () => models?.generate,
    searchMailboxes: mailboxSearch({ plugins: () => plugins, vault: opts.vault, connected: connectedMailboxes, skipFor }),
    // Mail a search finds is received mail, so placement mail older than the skip list is taken aside as the poll's is.
    claim: (tx, e) => routePlacement(tx, { ...e, pluginId: "", trigger: EMAIL_RECEIVED }, matchExpected),
    desk: createReplyDesk({
      items: () => items,
      generate: () => models?.generate,
      notify: mailMembers(opts.mailer, memberEmail),
    }),
  });
  const consumers = [replies.intake, campaignReplies({ items: () => items, humanReply })];
  // Third-party plugins a Server admin installed run only in the sandbox (ADR 0026 rule 009). Where it
  // can't run they aren't loaded at all; a test that hands in its own plugins never loads them.
  const dataRoot = dataDir(process.env);
  const installs = !opts.pluginSources && !opts.effects && opts.vault && dataRoot && (await sandboxStatus()).ok ? join(dataRoot, "plugin-store") : undefined;
  const plugins =
    !opts.effects && opts.vault
      ? loadPlugins({
          // Only a test hands in its own plugins, such as Gmail pointed at a fake.
          sources: (opts.pluginSources ?? firstPartyPlugins()).map((plugin) => ({ mode: "in_process" as const, plugin })),
          credentials: opts.vault.credentials,
          onCredentialRejected: opts.vault.markNeedsReauth,
          confinement: installs ? "external" : "none",
          ...(installs && { spawn: confinedSpawn((line) => console.log(line)), installed: { list: listInstalled, storeDir: installs, gate: installGate } }),
          mediaLinks: (workspaceId: string, ref: MediaRef) => opts.media().link(workspaceId, ref),
          boss,
          verifyWebhook: webhookVerifier(() => opts.vault!),
          // The reply poll never fetches a Placement check this Mailbox expects.
          skipMail: async (workspaceId, credentialId, trigger) => (trigger === EMAIL_RECEIVED ? skipFor(workspaceId, credentialId, new Date()) : []),
          onEvent: async (tx, e) => {
            // A plugin's own trigger is recorded and goes no further: core reads none of its data.
            if (e.custom) return;
            // Placement mail goes no further: it is never a reply, a bounce or hand-written mail.
            if (await routePlacement(tx, e, matchExpected)) return;
            if (e.trigger === EMAIL_RECEIVED) for (const consume of consumers) await consume(tx, e);
            if (e.trigger === MAIL_SENT) await recordSentMail(tx, e, new Date());
          },
        })
      : undefined;
  const effects = opts.effects ?? plugins?.effects ?? {};
  const now = () => new Date();
  // Without plugins there are no mailbox sends: a test's own effects have no replies to read.
  const repliesRead = plugins ? mailboxRepliesRead(plugins, { now, withinMs: REPLIES_READ_WITHIN_MS }) : async () => true;
  // Safety results ship with the code, so they are read once; a new release reads them again.
  const agentGate = agentWrittenGate(deploymentFromEnv());
  const ledger = createLedger({
    boss,
    signingKeys,
    effects,
    now,
    checks: [workspaceLive(), outreachFloors(repliesRead, now, opts.vault && suppressionHasher(opts.vault)), campaignCheck(), ...(plugins ? [postLimitCheck({ plugins: () => plugins, networks: socialNetworks, now })] : []), accountHealthCheck({ now }), ruleStillCovers({ port: campaignRulePort, now, mayGrant: mayGrantRules, gateOpen: () => agentGate.offered }), approverMayApprove(actionPermission), placementGranted(deploymentFromEnv), placementSendCheck(now), docWriteCurrent, probeRecipient, touchCheck({ effects, now }), mailboxDayCheck({ now }), credentialReady],
    resolvers: { credential: credentialLabel, fact: factVersion, template: templateVersion, step_output: stepOutputVersion, capability: async (_tx, id) => plugins?.capabilityVersion(id) ?? null, wording: probeWordingVersion, placement_grant: placementGrantVersion, placement_content_test: contentTestVersion, doc_write_grant: docWriteGrantVersion },
    onRuleStale: suspendOnStale({ now }),
    onProviderLimit: suspendOnProviderLimit({ now }),
    onAccountLimit: async (tx, action, limit, detail) => {
      await pauseOnAccountLimit({ now })(tx, action, limit, detail);
      await pauseOnProviderAbuse({ now })(tx, action, limit);
      await slowOnSendingLimit({ now })(tx, action, limit);
      await stopOnAccountLimit(now)(tx, action, limit);
    },
    // items is built after the ledger; the hook only runs once dispatch has started.
    onKeysLost: (tx, workspaceId) => items.openKeysLostIn(tx, workspaceId).then(() => undefined),
    onLateChanged: (tx, workspaceId) => items.refreshLateIn(tx, workspaceId),
    onLater: (workspaceId, actionId, at) => items.followLater(workspaceId, actionId, at),
  });
  const standingRules = createStandingRules({ ledger, port: campaignRulePort, now, mayGrant: mayGrantRules, items: () => items, agentGate: () => agentGate });
  later(() => ledger.work());
  later(() => ledger.workSweep());
  // A lifted operator hold frees what it held within a minute.
  later(() => boss.createQueue(OPERATOR_HOLDS_RELEASE));
  later(() => boss.schedule(OPERATOR_HOLDS_RELEASE, "* * * * *"));
  later(() => boss.work(OPERATOR_HOLDS_RELEASE, () => ledger.releaseOperatorHolds().then(() => undefined)));
  // Needs the vault and a mailer, so tests that replace effects run without models.
  const { vault, mailer } = opts;
  // The lesson check's eval ships with the code too, so whether lessons can be proposed is read once.
  const lessonsOpen = lessonCheckOpen(deploymentFromEnv());
  const facts = createFacts({ items: () => items, now });
  const lessons = createLessons({
    items: () => items,
    generate: () => models?.generate,
    checkOpen: () => lessonsOpen,
    suspendRules: (tx, agent, reason, at) => suspendForAgent(tx, agent, reason, at, true),
    warnDrafts: async (workspaceId, runIds) => {
      const said = "Written with a lesson that was later withdrawn. Read it closely before approving.";
      for (const runId of runIds) for (const itemId of (await agents?.itemsOfRun(workspaceId, runId)) ?? []) await items.addWarning(workspaceId, itemId, warn("unspecified", said));
      await opts.campaigns().warnTemplates(workspaceId, runIds, said);
    },
    applyFact: factKinds(now).fact_proposal!.apply,
    liveFacts: (workspaceId) => facts.list(workspaceId),
    now,
  });
  // A post's link card: the page read the same safe way a run reads one, cut short so viewing a post stays quick.
  const fetchPreview = createFetchHtml();
  const readPreview = async (url: string) => {
    const r = await fetchPreview(url, url, AbortSignal.timeout(4_000)).catch(() => null);
    return r?.ok ? previewOf(r.html, r.url) : null;
  };
  const fetchImage = createFetchImage();
  const readImage = async (url: string) => {
    const r = await fetchImage(url, AbortSignal.timeout(4_000)).catch(() => null);
    return r?.ok ? { bytes: r.bytes } : null;
  };
  // Posts count against their Social account's day (ADR 0038); everything else against its Mailbox's.
  const postCapacity = socialCapacity({ networks: socialNetworks });
  const items = createItems({ ledger, actionPermission, capacity: routeCapacity((capability) => (capability.endsWith("/social.publish") ? postCapacity : undefined)), kinds: { ...factKinds(), ...planKinds({ now, onPlanApproved: campaignOnPlanApproved({ now, items: () => items }) }), ...campaignKinds({ now }), ...optOutReviewKind({ boss, now }), ...replyDeskKind(), ...modelSignInKind(), ...socialKinds() , ...standingRuleKinds(), ...prospectKinds({ boss, now }), ...newsletterKinds(), ...seoKinds({ now }), ...competitorKinds(), ...lessons.kinds(), ...next.kinds(), ...askKinds({ items: () => items, now }), ...askStartKinds({ starts: askStarts, boss, now }) }, now, describeChange: describeFactChange, onSubmitted: standingRules.onSubmitted, onApproved: standingRules.onApproved, onApplied: async (workspaceId, item) => {
      // Each only suggests or follows up, so one failing doesn't stop the other.
      await opts.campaigns().planApplied(workspaceId, item).catch((e) => console.error("campaigns: planApplied failed", item.id, e));
      await next.onApplied(workspaceId, item);
    }, mayGrant: mayGrantRules, ruleApprovalBy: standingRules.ruleApprovalBy, recipient: async (workspaceId, spec, itemId) => (await opts.campaigns().recipientNotes(workspaceId, spec, itemId)) ?? null,
    // How far a person's decided words moved from a per-Person writer's, for their own review rates.
    editOf: async (workspaceId, itemId, text) => (await opts.campaigns().editOf(workspaceId, itemId, text)) ?? null,
    // How an Item shows as what it will be: a post's account and network, an email's Mailbox.
    appearance: async (workspaceId, a) => (a.workArea === "social" ? postAppearance(workspaceId, a.itemId, socialNetworks(), { text: (a.content as { text?: unknown } | null)?.text as string | undefined, readPreview, readImage }) : a.workArea === "outreach" && a.credentialId ? mailFrom(workspaceId, a.credentialId) : null) });
  const reviews = companyReviews({ items: () => items, now });
  sweeps({ boss, later, standingRules, campaigns: opts.campaigns, media: opts.media });
  // A Workspace's export builds and its hourly sweep (ADR 0030 rule 008).
  later(() => opts.exports().work(boss));
  later(() => replies.work());
  if (plugins) {
    later(() => plugins.work());
    // One sweep covers a restart and a newly connected mailbox alike; starting a running chain does nothing.
    // ponytail: a disconnected mailbox's chain keeps failing once a minute until its job is cancelled.
    later(() => boss.createQueue(SOCIAL_HEALTH_SWEEP));
    later(() => boss.schedule(SOCIAL_HEALTH_SWEEP, "0 4 * * *"));
    // The list keeps only active credentials on the connections it is given, so it serves networks too.
    later(() => boss.work(SOCIAL_HEALTH_SWEEP, async () => opts.socialSweep(await connectedMailboxes(plugins.socialConnections()))));
    // Every connected newsletter list is read nightly, and a list is read once as soon as it is connected.
    // One list at a time, so a slow tool delays only the lists after it.
    const lists = newsletterLists(firstPartyPlugins().map((p) => p.manifest));
    // Hourly, because each Workspace's draft is due at 06:00 in its own time zone. A pass that finds nothing due changes nothing.
    const weekly = newsletterWeekly({ items: () => items, lists: () => lists, credentials: (ws) => (vault ? vault.list(ws) : Promise.resolve([])), now });
    // Monday 06:00 UTC. The server hands in the runner, since it holds Search Console's reads.
    later(() => boss.createQueue(SEO_BRIEFS_WEEKLY));
    later(() => boss.schedule(SEO_BRIEFS_WEEKLY, "0 6 * * 1"));
    later(() => boss.work(SEO_BRIEFS_WEEKLY, async () => opts.seoBriefs().weekly()));
    // Monday 07:00 UTC: each competitor page read once and compared with its last good read.
    later(() => boss.createQueue(COMPETITORS_WEEKLY));
    later(() => boss.schedule(COMPETITORS_WEEKLY, "0 7 * * 1"));
    later(() => boss.work(COMPETITORS_WEEKLY, async () => opts.competitorsWeekly()));
    // Every ten minutes, so the 30 minute delivered check lands within its window.
    const afterSend = newsletterAfterSend({ items: () => items, ledger: () => ledger, lists: () => lists, query: (ws, capability, input, credentialId) => plugins.query(ws, capability, input, credentialId), now });
    newsletterJobs({ boss, later, lists, connected: connectedMailboxes, query: plugins.query, syncOne: newsletterSync({ query: plugins.query }), outreach: opts.outreach, weekly, afterSend });
    // Placement checks, on a self-hosted install only. Each Mailbox's day is made at 06:00 UTC, before
    // the 09:00 to 17:00 send window, with the checks it sends, those it expects and its reports; a check still
    // unsent 30 minutes after its time is cancelled, and an expected one is read two hours after.
    if (opts.vault && deploymentFromEnv() !== "cloud") {
      const placement = createPlacement({ ledger: () => ledger, deployment: deploymentFromEnv, now });
      const reading = createReading({
        placement,
        ledger: () => ledger,
        readFor: async (workspaceId, credentialId) => plugins.mailboxFor((await opts.vault!.find(workspaceId, credentialId))?.connection ?? null)?.readCheck,
        archiveFor: joinForCredential(plugins, opts.vault, "archive"),
        query: (workspaceId, capability, input, credentialId) => plugins.query(workspaceId, capability, input, credentialId),
        deployment: deploymentFromEnv,
        now,
      });
      const sending = createSending({
        placement,
        contentTests: createContentTests({ deployment: deploymentFromEnv, now }),
        ledger: () => ledger,
        sendFor: joinForCredential(plugins, opts.vault, "check"),
        deployment: deploymentFromEnv,
        now,
      });
      const reporting = createReporting({
        placement,
        ledger: () => ledger,
        reportFor: joinForCredential(plugins, opts.vault, "report"),
        memberKeys: () => opts.vault!.memberKeys,
        deployment: deploymentFromEnv,
        now,
      });
      placementJobs({ boss, later, connections: plugins.mailboxConnections, connected: connectedMailboxes, sending, reading, reporting });
    }
    // Status write-back (ADR 0025), self-hosted and cloud alike: each docs source with a live yes every 5
    // minutes [DEFAULT], and one source soon after a new yes, so its rows show their state at once.
    if (opts.vault) {
      const vault = opts.vault;
      const docsProvider = docsProviders((opts.pluginSources ?? firstPartyPlugins()).map((p) => p.manifest))[0];
      const writeBack = createWriteBack({
        provider: () => docsProvider,
        credentials: (workspaceId) => vault.list(workspaceId),
        query: (workspaceId, capability, input, credentialId) => plugins.query(workspaceId, capability, input, credentialId),
        ledger: () => ledger,
        prepare: (workspaceId, capability, input) => plugins.prepare(workspaceId, capability, input),
        capabilityVersion: (id) => plugins.capabilityVersion(id),
        postOf: async (workspaceId, itemId) => {
          const v = await items.view(workspaceId, itemId);
          return v && { state: v.state };
        },
        now,
      });
      writeBackJobs({ boss, later, provider: docsProvider, connected: connectedMailboxes, writeBack });
    }
    // A new Mailbox's ramp grows a step after clean days, read nightly.
    later(() => boss.createQueue(MAILBOX_RAMP_SWEEP));
    later(() => boss.schedule(MAILBOX_RAMP_SWEEP, "0 5 * * *"));
    later(() => boss.work(MAILBOX_RAMP_SWEEP, async () => sweepRamps(await connectedMailboxes(plugins.mailboxConnections()), now())));
    later(() => boss.createQueue(MAILBOX_POLLS));
    later(() => boss.schedule(MAILBOX_POLLS, "* * * * *"));
    // A pending Mailbox check finishes with the reply poll, which already reads that inbox.
    const finishCheck = opts.vault
      ? finishHeaderCheck({ ledger: () => ledger, probeFor: probeForCredential(plugins, opts.vault), query: (ws, capability, input, credentialId) => plugins.query(ws, capability, input, credentialId), now })
      : undefined;
    later(() => boss.work(MAILBOX_POLLS, async () => {
      for (const m of await connectedMailboxes(plugins.mailboxConnections())) {
        await finishCheck?.(m.workspaceId, m.credentialId);
        const provider = plugins.mailboxFor(m.connection);
        if (!provider) continue;
        await plugins.startPolling(m.workspaceId, provider.pluginId, EMAIL_RECEIVED, m.credentialId);
        // Hourly, from the plugin's interval; the first run reads 90 days back, so a new Mailbox fills within a minute.
        if (provider.readsSent) await plugins.startPolling(m.workspaceId, provider.pluginId, MAIL_SENT, m.credentialId);
        await replies.retryReadBacks(m.workspaceId);
        await ledger.resumeHeldBy(m.workspaceId, "replies_not_read", { system: "outreach" }, async (_tx, held) => held.credentialId === m.credentialId);
        // Unpausing frees what the pause held, within a minute.
        await ledger.resumeHeldBy(m.workspaceId, "workspace_paused", { system: "outreach" }, async (tx) => !(await sendingPaused(tx)));
        // A cold email held at dispatch for a newsletter subscriber goes back to a person within a minute.
        await opts.outreach().askAgainForSubscribers(m.workspaceId);
      }
    }));
  }
  let models: Models | undefined;
  let agents: Agents | undefined;
  // Ask starts its runs through agents, and agents hand Ask its replies, so each reaches the other through a function.
  const ask = createAsk({ agents: () => agents!, items: () => items, nextSteps: () => next, facts: () => facts, starts: askStarts, campaigns: opts.campaigns, // Ask runs only on a candidate whose recorded eval passed for this exact prompt; a changed prompt turns it off until re-run.
    ready: () => routesFor(deploymentFromEnv()).ask?.candidates.some((c) => modelEvals().evaluated(askAgent.id, c.provider, c.model)) ?? false,
    now,
    timeZone: timeZoneOf,
  });
  let clips: Clips | undefined;
  if (vault && mailer) {
    const deployment = deploymentFromEnv();
    // Models ask agents whether a run is live, and agents call models, so each reaches the other through a function.
    const campaign = campaignSinks({ facts, now, outreach: opts.outreach, startDraft: () => (workspaceId, a) => agents!.start(workspaceId, a), generate: () => models!.generate, onTemplateSaved: next.onTemplateSaved, items: () => items, posts: opts.posts, writeUps: opts.campaigns });
    const names = namesSink(now, reviews.open);
    const terms = termsSink(now);
    const briefs = briefSink({ items: () => items });
    // Counter-moves follow the classifier's labels; a comparison page or post draft goes through agents, refused until its eval passes.
    const moves = createMoves({ facts: () => facts, items: () => items, now, start: () => (workspaceId, a) => agents!.start(workspaceId, a), readPage: createPageReader() });
    const notice = starterNotice(mailer);
    const built = createAgents({
      boss,
      deployment,
      routes: routesFor(deployment),
      models: () => models!,
      sinks: {
        fact_proposal: factSink(facts),
        ask_reply: ask.sink,
        ...planSinks({ facts, now }),
        // Each draft goes to the module that owns its output key: a names run's is a company's people and a
        // terms run's is search terms, both prospecting's. A key no module owns is refused.
        draft: sinkByOutputKey(
          { [NAMES_OUTPUT_KEY]: names, [TERMS_OUTPUT_KEY]: terms },
          { [BRIEF_OUTPUT_KEY]: briefs },
          { [LABELS_OUTPUT_KEY]: createLabels({ now, moves: () => moves }).sink, [COMPARISON_OUTPUT_KEY]: moves.briefSink, [POST_OUTPUT_KEY]: moves.postSink },
          { [MOMENTS_OUTPUT_KEY]: (workspaceId, proposal, context) => clips?.sink(workspaceId, proposal, context) ?? Promise.resolve({ ok: false as const, code: "no_clips" }) },
          campaign.byKey,
        ),
      },
      definitions: SHIPPED_DEFINITIONS,
      addWarning: items.addWarning,
      context: factContext(facts),
      lessons: { fix: lessons.fix, carried: lessons.carried, withdrawn: lessons.withdrawn },
      // Read tools over a run's own Workspace, which Ask uses.
      reads: createCoreReads({ items: () => items, campaigns: opts.campaigns, sources: opts.startSources }),
      notify: notice,
      // A names run that ends without names, however it ended, settles its company and opens its review.
      onIncomplete: (run) => namesEnded(run, now(), reviews.open),
      now,
    });
    models = modelsFromEnv({ vault: () => vault, boss, mailer, adminEmails, runGate: built.runGate, signInOutcome: signInNeeds(() => items).outcome, overrideAllowed: modelEvals().overrideAllowed });
    agents = built;
    const builtModels = models;
    later(() => workHoldWatch(boss, builtModels.settleAbandoned));
    later(() => built.work());
    // Clipping needs somewhere on disk to work.
    const dir = dataDir(process.env);
    if (dir) {
      clips = createClips({
        boss,
        media: opts.media,
        facts,
        measures: opts.planMeasures,
        startPick: () => async (workspaceId, a) => {
          const started = await built.start(workspaceId, a);
          return started.ok ? { ok: true, runId: started.run.id } : { ok: false, reason: started.reason };
        },
        agentRun: () => async (workspaceId, runId) => {
          const run = (await built.get(workspaceId, runId))?.run;
          return run ? { status: run.status, reason: run.statusReason } : null;
        },
        dataDir: () => dir,
        onDone: opts.clipStepDone,
        now,
      });
      const builtClips = clips;
      later(() => builtClips.work());
    }
  }
  const startNames: StartNames | undefined = agents && (async (workspaceId, a) => {
    const started = await agents!.start(workspaceId, a);
    return started.ok ? { ok: true } : { ok: false, reason: started.reason };
  });
  // Started after agents, so a read always finds them. Code reads the whole page; only the stored snapshot is capped.
  const reader = createCompanyReader({ fetchHtml: createFetchHtml({ maxChars: Infinity }), startNames, openReview: reviews.open, now });
  later(() => workCompanyReads(boss, reader.read, reader.giveUp));
  const verifier = createVerifier({ verify: plugins && vault ? verifyForWorkspace(plugins, vault) : async () => null, now });
  later(() => workCompanyVerifies(boss, verifier.verifyCompany));
  // A hand-over adds people through the server's campaigns.
  const handovers = createHandovers({ boss, campaigns: opts.campaigns, freshResults: verifier.freshResults, now });
  later(() => workHandovers(boss, handovers.run, handovers.giveUp));
  later(() => workAskStarts(boss, askStartJob({ starts: askStarts, items: () => items })));
  later(() => next.work(boss));
  // Daily [DEFAULT]: a card for each per-Person follow-up whose drafting lead has come.
  later(() => boss.createQueue(FOLLOW_UP_CARDS));
  later(() => boss.schedule(FOLLOW_UP_CARDS, "0 7 * * *"));
  later(() => boss.work(FOLLOW_UP_CARDS, async () => next.offerFollowUps()));
  return {
    boss,
    starts,
    installs,
    standingRules,
    lessons,
    plugins,
    models,
    items,
    replies,
    agents,
    ask,
    clips,
    // On the worker's queue, so a pasted run queues its reads where they are worked.
    prospectingRuns: createRuns({ boss, now }),
    prospectingHandovers: handovers,
    resumeHeld: ledger.resumeHeld,
    /** Reads one newsletter list now, in the background, as when it is first connected. */
    syncNewsletter: async (workspaceId: string, credentialId: string, connection: string) => {
      if (plugins) await boss.send(NEWSLETTER_SYNC_ONE, { workspaceId, credentialId, connection });
    },
    ledger,
    /** Writes one docs source's rows soon, after a new yes to status write-back. */
    writeBackSource: async (workspaceId: string, sourceId: string) => {
      if (plugins && opts.vault) await boss.send(DOCS_WRITE_BACK_ONE, { workspaceId, sourceId });
    },
    sendFor: plugins && opts.vault ? sendForCredential(plugins, opts.vault) : undefined,
    probeFor: plugins && opts.vault ? probeForCredential(plugins, opts.vault) : undefined,
    joinFor: plugins && opts.vault ? joinForCredential(plugins, opts.vault) : undefined,
    checkMailbox: plugins?.checkMailbox,
    // Prospecting reads it from here, so the server and a worker started alone search through the same one.
    discovery: opts.discovery ?? noDiscovery,
  };
}

export type Composed = Awaited<ReturnType<typeof compose>>;

/** Starts what compose built: connects, loads installed plugins, then registers every queue, schedule and consumer in order. */
export async function startWork({ boss, starts, installs, ...modules }: Composed) {
  await boss.start();
  const { plugins, agents } = modules;
  // Installed plugins load now and again on every install, upgrade or removal on this server (rule 004).
  let stopListening: (() => Promise<void>) | undefined;
  if (plugins && installs) {
    await plugins.reload();
    stopListening = await listenForInstalls(() => void plugins.reload().catch((e: unknown) => console.error(`plugins: reload failed: ${String(e)}`)));
  }
  for (const start of starts) await start();
  const drain = async (ms: number) => {
    await Promise.all([boss.stop({ graceful: true, close: false, timeout: ms }), agents?.settled()]);
  };
  const close = async () => {
    await boss.stop({ close: true });
    await stopListening?.();
    await plugins?.close();
  };
  return {
    ...modules,
    // ADR 0027 rule 004. Stops claiming on every queue and waits up to `ms` for running handlers and
    // agent loops; at `ms` pg-boss fails what is left, as a SIGKILL would. The pool stays open, so a
    // request still being answered can enqueue, until close.
    drain,
    close,
    stop: async () => {
      await drain(DRAIN_DEADLINE_MS);
      await close();
    },
  };
}

/** Builds every module and starts its work. A test hands in its own effects or keys; the server hands in everything. */
export async function startWorker(opts: WorkerOptions) {
  return startWork(await compose(opts));
}
