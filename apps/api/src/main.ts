// SPDX-License-Identifier: AGPL-3.0-only
import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { agentRoutes, brandAskStarts, voiceCheckOpen, type Agents } from "./modules/agents/index";
import { campaignDefinitions, campaignOnPlanCreated, campaignOutsideReplies, campaignRoutes, createCampaigns } from "./modules/campaigns/index";
import { firstPartyPlugins, GOOGLE_PROVIDER, GOOGLE_SEARCH_CONSOLE_PROVIDER, mailboxProviders, NOTION_OAUTH_PROVIDER, socialNetworks, socialProviders } from "@direx/extensions";
import { join } from "node:path";
import { serveWeb } from "./web";
import { credentialRoutes, dataDir, vaultFromEnv, type Vault } from "./modules/credentials/index";
import { createFacts, factRoutes, voiceCheck } from "./modules/facts/index";
import { createMedia, diskStore, MEDIA_MAX_BYTES, mediaRoutes, parseS3Url, s3Store, type Store } from "./modules/media/index";
import { clipAskStarts, clipRoutes } from "./modules/clips/index";
import { approverFromMember, authConfigFromEnv, can, createIdentity, isDevOrTest, pickAdmission, type Admission, type AuthConfig, type Permission } from "./modules/identity/index";
import { itemRoutes } from "./modules/items/index";
import { scheduleRoutes, timeZoneOf } from "./modules/schedule/index";
import { CHECK_CANDIDATES, deploymentFromEnv, modelRoutes, signInNeeds } from "./modules/models/index";
import { connectedMailboxes, createHeaderCheck, createHoldHooks, createHolds, createOutreach, createOutsideTouches, isPublicHttps, outreachRoutes, PROBE_WORDING_VERSION } from "./modules/outreach/index";
import { createExports, exportRoutes } from "./modules/retention/index";
import { createReviewFeeds, reviewFeedRoutes } from "./modules/review-feed/index";
import { createPlans, draftRuns, planAskStarts, planRoutes } from "./modules/plans/index";
import { createPluginWebhooks, docsProviders, HOST_VERSION, keyConnections, newsletterLists, pluginRoutes, searchProviders, type Plugins } from "./modules/plugins/index";
import { createNewsletter, issueDesk, newsletterRoutes } from "./modules/newsletter/index";
import { createBriefs, createPageReader, createSeo, pagesWorthABrief, seoAskStarts, seoRoutes } from "./modules/seo/index";
import { createDocs, createWriteBackGrants, docsRoutes, docsWriteBackRoutes } from "./modules/docs/index";
import { createTokens, maxDaysFromEnv, tokenRoutes } from "./modules/door/index";
import { competitorRoutes, createCompetitors, createLabels, createSnapshots } from "./modules/competitors/index";
import { createPosts, createSocial, socialRoutes } from "./modules/social/index";
import { addressLabelsFor, createTerms, keptEligibility, prospectingAskStarts, prospectingRoutes, signalsFor } from "./modules/prospecting/index";
import { listenHost, loadDeployment, mediaS3Url, withClientIp } from "./startup";
import { onStopSignal } from "./shutdown";
import { healthOnly, roleFromEnv } from "./roles";
import { standingRuleRoutes, suspendAgentRulesFor, suspendForAgent } from "./modules/standing-rules/index";
import type { Discovery } from "./modules/extensions/index";
import { createNextSteps, type NextSteps } from "./modules/next-steps/index";
import { askRoutes } from "./modules/ask/index";
import { modelEvals, startWorker } from "./worker";
import { lessonRoutes } from "./modules/lessons/index";
import { createJoin, createPlacement, placementRoutes } from "./modules/placement/index";

// Bun's own cap is raised to 2 GB for video uploads (startServer), so every other route is held to
// this one. The two uploads read the body themselves and enforce their own caps.
export const BODY_MAX_BYTES = 1024 * 1024;
const limitBody = bodyLimit({ maxSize: BODY_MAX_BYTES, onError: (c) => c.json({ error: "too_large" }, 413) });
const isUpload = (method: string, path: string) => method === "POST" && (/^\/api\/w\/[^/]+\/media$/.test(path) || path === "/api/server/plugins/review");
// The same first-party plugins the worker loads, read for their manifests only.
const keyServices = keyConnections(firstPartyPlugins().map((p) => p.manifest));
// The weekly newsletter's list must be one of the Workspace's newsletter connections.
const newsletterListInfo = newsletterLists(firstPartyPlugins().map((p) => p.manifest));
const newsletterConnections = newsletterListInfo.map((l) => l.connection);
// Search Console is found by its two queries; its reads go through the worker's plugins.
const searchProvider = searchProviders(firstPartyPlugins().map((p) => p.manifest))[0];
/** The page the connect callback sends a person back to: the one they connected from. */
export function landingPage(connection: string | null) {
  if (socialNetworks().some((n) => n.connection === connection)) return "social";
  return connection !== null && connection === searchProvider?.connection ? "seo" : "credentials";
}
// The writers a person edits after: per-person emails, templates and posts.
const LESSON_WRITERS = ["recipient_writer", "campaign_drafter", "social_drafter"] as const;
export const openApiConfig = { openapi: "3.1.0", info: { title: "Direx API", version: "0.0.0" } };

type Worker = Awaited<ReturnType<typeof startWorker>>;
/** A module the worker builds, or a refusal when it hasn't started or didn't build that one. */
const need = <T>(value: T | undefined, what: string): T => {
  if (!value) throw new Error(`no ${what} yet: it comes with the server's worker`);
  return value;
};

/**
 * Builds every server-side module and mounts every route, in order (ADR 0027 rule 001). The worker
 * and these modules need each other, so the worker is read through `worker`, which runServer fills
 * once it has started; until then a route that needs it throws. `ports` are what the worker needs back.
 */
export function createApp({ worker, deployment, admission: supplied, mediaStore, maxTokenDays = null }: { worker: () => Worker | undefined; deployment?: AuthConfig; admission?: Admission; mediaStore?: Store; maxTokenDays?: number | null }) {
  // A module app without its own defaultHook inherits this one, so every schema failure is one {error}
  // body, never the raw ZodError.
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    },
  });
  app.use("*", (c, next) => (isUpload(c.req.method, c.req.path) ? next() : limitBody(c, next)));
  app.get("/health", (c) => c.json({ ok: true }));
  // AGPL section 13: everyone who uses a Direx server can get the source it runs (ADR 0002 rule 005).
  // A changed Direx sets DIREX_SOURCE_URL to where its own source is published. Otherwise it is the
  // release this server was installed as, which the Compose install names in DIREX_VERSION, or the
  // repository when that isn't a release tag.
  app.get("/api/source", (c) => {
    const release = /^v\d[\w.-]*$/.test(process.env.DIREX_VERSION ?? "") ? `/tree/${process.env.DIREX_VERSION}` : "";
    return c.redirect(process.env.DIREX_SOURCE_URL || `https://github.com/trydirex/direx${release}`);
  });
  const items = () => need(worker()?.items, "items");
  const ledger = () => need(worker()?.ledger, "ledger");
  const agents = () => need(worker()?.agents, "agents");
  // Plugins start with the server's worker, so the connect flow reaches them late.
  const pluginsForSocial = () => need(worker()?.plugins, "plugins");
  const queryPlugins: Plugins["query"] = (workspaceId, capability, input, credentialId) => pluginsForSocial().query(workspaceId, capability, input, credentialId);
  // Who may sign up (ADR 0024). runServer supplies it from its extensions; cloud must supply one.
  let admission = supplied;
  const identity = createIdentity(
    () => deployment ?? authConfigFromEnv(),
    () => (admission ??= pickAdmission(deploymentFromEnv(), undefined, isDevOrTest(process.env))),
    // A deleted Workspace's open Actions are cancelled with it, so its purge isn't refused for work no one can reach.
    (tx) => ledger().cancelForDeletionIn(tx),
  );
  app.route("/", identity.routes);
  const baseUrl = () => identity.config().baseURL;

  // Built on first use, so importing main reads no key. A reconnect or rotation resumes
  // the credential's held Actions through the in-process worker's ledger.
  let vault: Vault | undefined;
  const getVault = (): Vault =>
    (vault ??= vaultFromEnv(identity.config(), async (ws, id) => worker()?.resumeHeld(ws, id), {
      appProviders: [...socialProviders(), NOTION_OAUTH_PROVIDER],
      googleApps: [GOOGLE_PROVIDER, GOOGLE_SEARCH_CONSOLE_PROVIDER],
      identify: (ws, connection, token) => social.identify(ws, connection, token),
    }));
  const social = createSocial({
    plugins: pluginsForSocial,
    vault: getVault,
    networks: socialNetworks,
    deployment: deploymentFromEnv,
    callbackUrl: () => `${baseUrl()}/api/connections/callback`,
  });
  const posts = createPosts({
    plugins: pluginsForSocial,
    vault: getVault,
    networks: socialNetworks,
    media: () => files,
    baseUrl,
    launchesOn: (workspaceId, day) => campaigns.launchesBetween(workspaceId, day, day),
    items,
  });
  app.route("/", socialRoutes({ social: () => social, posts: () => posts }));
  const headerChecks = createHeaderCheck({
    items,
    probeFor: async (workspaceId, credentialId) => worker()?.probeFor?.(workspaceId, credentialId),
    baseUrl,
  });
  app.route(
    "/",
    credentialRoutes({
      auth: identity.auth,
      vault: getVault,
      baseURL: baseUrl,
      landingPage,
      // Links connect social accounts only; a Mailbox is connected where its owner is signed in.
      linkNetwork: (connection) => socialNetworks().find((n) => n.connection === connection)?.label,
      mailboxes: {
        providers: () => mailboxProviders().filter((p) => p.deployments.includes(deploymentFromEnv())),
        check: (workspaceId, connection, credential) => need(worker()?.checkMailbox, "Mailbox check")(workspaceId, connection, credential),
        probe: (workspaceId, credentialId, member, wordingVersion) => headerChecks.start(workspaceId, credentialId, { approverId: approverFromMember(member), userId: member.userId, may: (p) => can(member.role, p as Permission), wordingVersion }),
        probeWordingVersion: PROBE_WORDING_VERSION,
      },
      keys: {
        // An installed plugin's key is stored unchecked: there is no core query a third-party plugin may answer yet.
        services: () => [
          ...keyServices.map(({ connection, name, balance, profile }) => ({ connection, name, canCheck: !!(balance ?? profile) })),
          ...(worker()?.plugins?.installedKeyServices() ?? []).map((s) => ({ ...s, canCheck: false })),
        ],
        check: async (workspaceId, connection, key) => {
          const service = keyServices.find((s) => s.connection === connection);
          const plugins = pluginsForSocial();
          if (service?.balance) return "typed" in key ? plugins.queryTyped(workspaceId, service.balance, null, { key: key.typed }) : plugins.query(workspaceId, service.balance, null, key.credentialId);
          if (!service?.profile) throw new Error(`no key check for ${connection}`);
          if ("typed" in key) return plugins.queryTyped(workspaceId, service.profile, null, { key: key.typed });
          // A saved key with a chosen list is checked against that list.
          const listId = ((await getVault().find(workspaceId, key.credentialId))?.meta as { listId?: string } | undefined)?.listId;
          return plugins.query(workspaceId, service.profile, listId ? { listId } : null, key.credentialId);
        },
        connected: async (workspaceId, connection, credentialId) => {
          if (!keyServices.find((s) => s.connection === connection)?.profile) return;
          // A new key may be on another plan, so a read-only list tries sending again.
          await newsletter.clearReadOnly(workspaceId, credentialId);
          // A newsletter list is read as soon as its key is stored, through the worker.
          await worker()?.syncNewsletter(workspaceId, credentialId, connection);
        },
      },
    }),
  );

  // The in-process worker's ledger, so an approval binds a credential the way a claim checks it.
  app.route("/", itemRoutes({ items }));

  // A Mailbox's limit and hours, the Workspace time zone, and each Mailbox's day for the Calendar.
  app.route("/", scheduleRoutes());

  // A stop cancels the Mailbox's placement Actions through the worker's ledger; a join sends through it.
  const placement = createPlacement({
    ledger,
    deployment: () => deploymentFromEnv(),
  });
  const placementJoin = createJoin({
    placement,
    ledger,
    joinFor: (workspaceId, credentialId) => need(worker()?.joinFor, "join")(workspaceId, credentialId),
    memberKeys: () => getVault().memberKeys,
    deployment: () => deploymentFromEnv(),
  });
  app.route("/", placementRoutes({ placement: () => placement, join: () => placementJoin }));

  // Reading and editing Brand need no worker; a proposal goes through items.
  const facts = createFacts({
    items,
    // The Voice check asks a model; until the worker's models start, a paste says the check isn't available.
    generate: () => worker()?.models?.generate,
    checkOpen: () => voiceCheckOpen(deploymentFromEnv(), voiceCheck, CHECK_CANDIDATES),
  });
  app.route("/", factRoutes({ facts: () => facts }));

  // Agents start with the server's worker.
  const startAgent: Agents["start"] = (workspaceId, a) => agents().start(workspaceId, a);
  const plans = createPlans({
    items,
    facts,
    onPlanCreated: campaignOnPlanCreated,
  });
  app.route("/", planRoutes({ plans: () => plans, startDraft: startAgent }));

  // The Mailbox plugin loads with the worker, which the send path needs anyway.
  const outreach = createOutreach({
    items,
    send: (workspaceId, credentialId) => need(worker()?.sendFor, "sending")(workspaceId, credentialId),
    baseUrl,
    readBack: (workspaceId, email) => need(worker()?.replies, "replies").markReadBack(workspaceId, email),
    ledger,
    // Until the worker's models start, Home's numbers show without the sentence behind them.
    generate: () => worker()?.models?.generate,
  });
  // A reply logged by hand stops the Person in their campaigns, which outreach can't import.
  const outsideReplies = campaignOutsideReplies({ items });
  const outsideTouches = createOutsideTouches({ replies: () => outsideReplies });
  // A hold stops the Person's campaigns the way a logged reply does; Release resumes through the worker's ledger.
  const holds = createHolds({ replies: () => outsideReplies, ledger });
  const holdHooks = createHoldHooks({ vault: getVault, replies: () => outsideReplies });
  app.route("/", outreachRoutes({ outreach: () => outreach, outsideTouches: () => outsideTouches, holds: () => holds, holdHooks: () => holdHooks }));
  // Each approver's calendar feed of review time; it counts Needs you through the worker's items.
  const reviewFeeds = createReviewFeeds({
    waiting: (workspaceId) => items().waitingSummary(workspaceId),
    baseUrl,
  });
  app.route("/", reviewFeedRoutes({ feeds: () => reviewFeeds, reachable: () => isPublicHttps(baseUrl()) }));
  const setMeta: Vault["setMeta"] = (workspaceId, credentialId, name, value) => getVault().setMeta(workspaceId, credentialId, name, value);
  const newsletter = createNewsletter({
    credentials: (workspaceId) => getVault().list(workspaceId),
    lists: () => newsletterConnections,
    listName: (connection) => newsletterListInfo.find((l) => l.connection === connection)?.name ?? connection,
    hasLists: (connection) => !!newsletterListInfo.find((l) => l.connection === connection)?.lists,
    listsOf: async (workspaceId, credentialId, connection) => {
      const capability = newsletterListInfo.find((l) => l.connection === connection)?.lists;
      if (!capability) return [];
      return pluginsForSocial().query(workspaceId, capability, {}, credentialId);
    },
    profileOf: async (workspaceId, credentialId, connection, listId) => {
      const capability = newsletterListInfo.find((l) => l.connection === connection)?.profile;
      if (!capability) throw new Error(`${connection} has no profile query`);
      return pluginsForSocial().query(workspaceId, capability, listId ? { listId } : {}, credentialId);
    },
    setMeta,
  });
  const issues = issueDesk({ items });
  app.route("/", newsletterRoutes({ newsletter: () => newsletter, issues: () => issues }));
  const seo = createSeo({
    credentials: (workspaceId) => getVault().list(workspaceId),
    setMeta,
    markNeedsReauth: (workspaceId, credentialId) => getVault().markNeedsReauth(workspaceId, credentialId),
    provider: () => searchProvider,
    query: queryPlugins,
    selfHost: () => deploymentFromEnv() === "self_host",
  });
  // The week's Briefs: Search Console's reads here, the brief agent through the worker's agents.
  const briefs = createBriefs({
    seo: () => seo,
    readPage: createPageReader(),
    start: () => startAgent,
    workspaces: async () => (searchProvider ? [...new Set((await connectedMailboxes([searchProvider.connection])).map((m) => m.workspaceId))] : []),
    runOf: () => async (workspaceId, runId) => {
      const r = await worker()?.agents?.get(workspaceId, runId);
      return r && { status: r.run.status, statusReason: r.run.statusReason, rejections: r.proposals.flatMap((p) => (p.rejectionCode ? [p.rejectionCode] : [])) };
    },
  });
  app.route("/", seoRoutes({ seo: () => seo, briefs: () => briefs }));
  // Webhook triggers reach the worker's plugins; their secrets stay in the vault (ADR 0031 rule 007).
  const pluginWebhooks = createPluginWebhooks({ vault: getVault, plugins: pluginsForSocial });
  // Third-party plugins (ADR 0026): a Server admin installs, a Workspace owner turns one on.
  app.route(
    "/",
    pluginRoutes({
      auth: identity.auth,
      storeDir: () => {
        const dir = dataDir(process.env);
        return dir && join(dir, "plugin-store");
      },
      firstPartyIds: () => new Set(firstPartyPlugins().map((p) => p.manifest.id)),
      hostVersion: HOST_VERSION,
      webhooks: () => pluginWebhooks,
    }),
  );
  const competitors = createCompetitors({ readPage: createPageReader() });
  // After each Workspace's weekly read, the change classifier through the worker's agents. Its route
  // appears only once its eval passes the founder's signed bar; until then the start is refused.
  const competitorLabels = createLabels({ start: () => startAgent });
  const competitorSnapshots = createSnapshots({ readPage: createPageReader(), afterRead: (workspaceId) => competitorLabels.classify(workspaceId) });
  app.route("/", competitorRoutes({ competitors: () => competitors, snapshots: () => competitorSnapshots }));
  // Built when the worker starts, since accepting one queues its start on the worker's queue.
  let nextSteps: NextSteps | undefined;
  const campaigns = createCampaigns({
    plans,
    facts,
    // The import preview counts days from the live daily run caps once the worker's agents exist.
    runCaps: async (workspaceId, agent) => worker()?.agents?.capsLeft(workspaceId, agent) ?? { agentLeftToday: 100, agentPerDay: 100, workspaceLeftToday: 300, workspacePerDay: 300 },
    items,
    outreach: () => outreach,
    outsideTouches: () => outsideTouches,
    posts: () => posts,
    // Clipping runs on the worker, and only on self-host, where the picker has a model route.
    clips: () => (deploymentFromEnv() === "cloud" ? undefined : worker()?.clips),
    // Briefs need a model route, which only self-host has for now.
    briefs: () => (deploymentFromEnv() === "cloud" ? undefined : { start: briefs.startForStep, get: briefs.stepBrief }),
    startDraft: () => startAgent,
    // Prospecting depends on campaigns, so its signals come in from here.
    signalsFor,
    addressLabelsFor,
    keptEligibility,
    onOutsideContentChanged: async (tx, campaignId, at) => {
      await suspendAgentRulesFor(tx, campaignId, at);
    },
    onSetupChanged: async (workspaceId, s) => nextSteps?.onSetupChanged(workspaceId, s),
    onTemplateSaved: async (workspaceId, s) => nextSteps?.onTemplateSaved(workspaceId, s),
  });
  app.route("/", campaignRoutes({ campaigns: () => campaigns }));

  // Uploaded files go to object storage when the deployment set media.s3 (read once at start), and
  // otherwise under the data directory, next to the root key.
  const mediaDir = () => {
    const dir = dataDir(process.env);
    if (!dir) throw new Error("media: set DIREX_DATA_DIR, or HOME for ~/.direx, so uploads have somewhere to go");
    return join(dir, "media");
  };
  const files = createMedia({
    store: () => mediaStore ?? diskStore(mediaDir()),
    now: () => new Date(),
    links: { baseUrl, secret: () => identity.config().secret },
  });
  app.route("/", mediaRoutes({ media: () => files }));

  // A Workspace's export ZIP goes where its media goes; its build queue starts with the server's worker.
  const exports = createExports({ store: () => mediaStore ?? diskStore(mediaDir()), now: () => new Date() });
  app.route("/", exportRoutes({ auth: identity.auth, exports: () => exports }));

  // Clip runs work on the in-process worker's queues, beside the agent that picks the moments. They need DIREX_DATA_DIR or HOME.
  const clips = () => need(worker()?.clips, "clip runs");
  app.route("/", clipRoutes({ clips }));

  // The in-process worker's instance, so a grant and a claim read rules through one ledger.
  app.route("/", standingRuleRoutes({ rules: () => need(worker()?.standingRules, "standing rules") }));

  // Built by the worker, which holds the items and the runs that lessons reach.
  app.route(
    "/",
    lessonRoutes({
      lessons: () => need(worker()?.lessons, "lessons"),
      agents: () => LESSON_WRITERS,
      definitionVersion: (agent) => campaignDefinitions[agent as keyof typeof campaignDefinitions]?.version ?? null,
    }),
  );

  // The in-process worker's instance, so a hold's watch job and its call share one queue.
  app.route(
    "/",
    modelRoutes({
      models: () => need(worker()?.models, "models"),
      vault: getVault,
      deployment: () => deploymentFromEnv(),
      onUnevaluated: (tx, agent, at) => suspendForAgent(tx, agent, "an AI choice with no passing eval", at),
      evaluated: (agent, adapter, model) => modelEvals().evaluated(agent, adapter, model),
      overrideAllowed: (agent, provider, model) => modelEvals().overrideAllowed(agent, provider, model),
      needs: signInNeeds(items),
    }),
  );

  app.route("/", askRoutes({ ask: () => need(worker()?.ask, "Ask") }));

  // A docs tool's pages read for brand facts: found by its two queries, read through the worker's plugins.
  const docs = createDocs({
    provider: () => docsProviders(firstPartyPlugins().map((p) => p.manifest))[0],
    credentials: (workspaceId) => getVault().list(workspaceId),
    canSignIn: async (workspaceId, connection) => (await getVault().appSource(workspaceId, connection)) !== null,
    query: queryPlugins,
    startBrandReader: (workspaceId, a) => agents().start(workspaceId, { input: { text: a.text }, startedBy: a.startedBy }),
    // A row imported to the Calendar is a post a person could have written there: same write, same approval.
    accounts: (workspaceId) => social.accounts(workspaceId),
    writePost: (workspaceId, p, userId) => posts.write(workspaceId, p, userId),
    editPost: (workspaceId, itemId, text, userId) => posts.edit(workspaceId, itemId, text, userId),
    movePost: (workspaceId, itemId, at, userId) => items().moveItem(workspaceId, itemId, at, { userId }),
    postOf: async (workspaceId, itemId) => {
      const d = await items().detail(workspaceId, itemId);
      return d && { state: d.item.state, revision: d.item.revision };
    },
    timeZone: (workspaceId) => timeZoneOf(workspaceId),
  });
  app.route("/", docsRoutes({ docs: () => docs }));
  // Status write-back's mapping and yes: a stop cancels through the worker's ledger, and a yes writes the rows soon through its queue.
  const writeBackGrants = createWriteBackGrants({
    provider: () => docsProviders(firstPartyPlugins().map((p) => p.manifest))[0],
    credentials: (workspaceId) => getVault().list(workspaceId),
    query: queryPlugins,
    ledger,
    onGranted: async (workspaceId, sourceId) => worker()?.writeBackSource(workspaceId, sourceId),
  });
  app.route("/", docsWriteBackRoutes({ grants: () => writeBackGrants }));
  app.route("/", agentRoutes({ agents }));

  // Prospecting reads the Strategy through plans and starts its run through agents, importing neither.
  const terms = createTerms({
    strategy: (workspaceId) => plans.strategy(workspaceId),
    start: startAgent,
  });
  app.route(
    "/",
    prospectingRoutes({
      // A names run starts in the name of whoever confirmed the search, so it uses their sign-in if they have one.
      namesFree: async (workspaceId, userId) => (await worker()?.models?.runsOnSubscription(workspaceId, { agent: "names_reader", purpose: "recipient_read", actorUserId: userId })) ?? false,
      // Prospecting runs and hand-overs queue on the server's worker, and company search comes with it.
      runs: () => need(worker()?.prospectingRuns, "prospecting runs"),
      handovers: () => need(worker()?.prospectingHandovers, "prospecting hand-overs"),
      terms: () => terms,
      discovery: () => need(worker()?.discovery, "company search"),
    }),
  );

  // External tokens (ADR 0032 rule 005): made and revoked here, accepted only by the door.
  const tokens = createTokens({ maxDays: maxTokenDays });
  app.route("/", tokenRoutes({ tokens: () => tokens }));

  app.doc31("/openapi.json", openApiConfig);
  // The built web app, last, so every API route matches first. Unset in development, where Vite serves it.
  if (process.env.DIREX_WEB_DIST) serveWeb(app, process.env.DIREX_WEB_DIST);

  // What the worker reaches back for: these modules, its next steps and Ask starts, built on its queue.
  const ports = { outreach: () => outreach, posts: () => posts, campaigns: () => campaigns, socialSweep: (credentials: Parameters<typeof social.sweep>[0]) => social.sweep(credentials), seoBriefs: () => briefs, competitorsWeekly: () => competitorSnapshots.weekly(),
    media: () => files,
    exports: () => exports,
    planMeasures: async (workspaceId: string, planId: string) => (await plans.plan(workspaceId, planId))?.current?.measures ?? null,
    clipStepDone: (workspaceId: string, runId: string) => campaigns.clipStepDone(workspaceId, runId),
    nextSteps: (boss: Parameters<typeof createNextSteps>[0]["boss"]) => (nextSteps = createNextSteps({ items, campaigns: () => campaigns, plans, boss, now: () => new Date() })),
    // The work a person may start from Ask, each its owning module's own start (ADR 0008 rule 028).
    askStarts: (boss: Parameters<typeof prospectingAskStarts>[0]["boss"]) => {
      const report = (workspaceId: string, runId: string) => agents().report(workspaceId, runId);
      const everywhere = [
        ...planAskStarts({ plans: () => plans, runs: draftRuns({ plans: () => plans, startDraft: startAgent }), report }),
        ...brandAskStarts(agents),
        ...prospectingAskStarts({ boss, terms: () => terms, strategy: (workspaceId) => plans.strategy(workspaceId), report }),
        ...seoAskStarts({ briefs: () => briefs, report }),
      ];
      const clipStarts = clipAskStarts({ clips, media: () => files });
      // Clipping runs only on self-host with media and a data dir; elsewhere pick_clips refuses as not available.
      return () => (worker()?.clips && deploymentFromEnv() !== "cloud" ? [...everywhere, ...clipStarts] : everywhere);
    },
    startSources: {
      plans: async (workspaceId: string) => (await plans.plans(workspaceId)).map((p) => ({ id: p.id, title: p.title, currentVersion: p.currentVersion })),
      companies: async (workspaceId: string) => (await worker()?.prospectingRuns.companies(workspaceId))?.companies.map((c) => ({ id: c.id, name: c.name, domain: c.domain, state: c.state })) ?? [],
      seoPages: pagesWorthABrief(() => seo),
      media: (workspaceId: string) => files.sources(workspaceId),
    },
  };
  return { app, identity, vault: getVault, ports };
}

// Built at import with no worker, for the OpenAPI script and tests; a route that needs the worker
// throws. runServer builds the app it serves, wired to its own worker.
export const { app } = createApp({ worker: () => undefined });

/**
 * Builds the app and starts its worker. A package that adds extensions calls this with them. A
 * missing SMTP URL outside dev and test, a value left in env, a lost or wrong root key, or a cloud
 * start with no Admission stops the server here.
 */
export async function runServer({ admission: supplied, ...extensions }: { discovery?: Discovery; admission?: Admission } = {}) {
  const admission = pickAdmission(deploymentFromEnv(), supplied, isDevOrTest(process.env));
  const deployment = await loadDeployment();
  // A malformed value stops the start here, naming the form it should have.
  const s3 = await mediaS3Url();
  const maxTokenDays = maxDaysFromEnv(process.env.DIREX_EXTERNAL_TOKEN_MAX_DAYS, deploymentFromEnv() === "cloud");
  // Read by the app's routes through a getter, since they and the worker need each other.
  let worker: Worker | undefined;
  const built = createApp({ worker: () => worker, deployment, admission, mediaStore: s3 ? s3Store(parseS3Url(s3)) : undefined, maxTokenDays });
  worker = await startWorker({ vault: built.vault(), mailer: deployment.mailer, ...built.ports, ...extensions });
  // ADR 0024: an unclaimed self-hosted server says how to claim it, once.
  if (deploymentFromEnv() === "self_host" && !isDevOrTest(process.env) && !(await admission.status()).claimed) console.warn("No Server admin yet. Run: bun run server-admin --invite");
  return { ...worker, app: built.app, identity: built.identity };
}

/**
 * Starts the server's worker, serves HTTP, and drains both on SIGTERM or SIGINT (ADR 0027 rule 004).
 * The server is served here rather than from a default export, so the stop holds its handle. A
 * package that adds extensions calls this with them.
 */
export async function startServer(extensions: Parameters<typeof runServer>[0] = {}) {
  const { app, identity, ...worker } = await runServer(extensions);
  // A model call or a CLI sign-in can stay silent far longer than Bun's 10-second default, which would
  // drop the response after the work is done. 255 seconds is the most Bun allows.
  // Bun refuses bodies over 128 MB by default; a video upload may be 2 GB, and the media module
  // enforces that cap itself while it streams.
  // A worker serves only /health (ADR 0027 rule 002); api and all serve the whole app.
  const fetch = roleFromEnv() === "worker" ? healthOnly : withClientIp(app.fetch, identity.config().trustedProxies ?? []);
  const server = Bun.serve({ port: Number(process.env.PORT ?? 3000), hostname: listenHost(), idleTimeout: 255, maxRequestBodySize: MEDIA_MAX_BYTES, fetch });
  onStopSignal({ server, worker });
  return { server, worker };
}

/**
 * `bun run worker`: the server in the `worker` role, which builds every module the server does, works
 * and schedules every queue, and serves only /health (ADR 0027 rule 002). On self-host the start
 * refuses, since a self-hosted Direx runs as one process (`bun run start`).
 */
export async function runWorker() {
  process.env.DIREX_ROLE ??= "worker";
  return startServer();
}

// Only when this file is the program, so importing main (the OpenAPI script) starts nothing.
if (import.meta.main) await startServer();
