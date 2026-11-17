// SPDX-License-Identifier: AGPL-3.0-only
// The plugins module's only public entry point. It loads plugins from manifests and
// hands the ledger the EffectCapability records it dispatches; nothing else calls a
// plugin's execute or reconcile.
import { parseManifest, VERIFY_BALANCE, type Credential, type DedupeClass, type EffectCapability, type Manifest, type Plugin, type QueryInput, type QueryName, type QueryOutput } from "@direx/plugin-sdk";
import { queryEntry } from "@direx/plugin-sdk/host";
import { createHash } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { lastPollAt, type PluginTx } from "./adapters/trigger-repo";
import { EMAIL_RECEIVED, EMAIL_SEND, MAIL_FROM, MAIL_SENT, MAILBOX_PROBE, MAILBOX_PROBE_READ, MAILBOX_PROFILE, mailboxShapes, PLACEMENT_ARCHIVE, PLACEMENT_JOIN, PLACEMENT_READ, PLACEMENT_REPORT, PLACEMENT_SEND, reachesPerson } from "./application/mailbox";
import { NEWSLETTER_LISTS, NEWSLETTER_PROFILE, NEWSLETTER_PUBLISH, NEWSLETTER_STATS, NEWSLETTER_SUBSCRIBERS, newsletterShapes } from "./application/newsletter";
import { SEARCH_ANALYTICS, SEARCH_PROPERTIES, searchConnections } from "./application/search";
import { DOCS_PAGE_TEXT, DOCS_ROW_UPDATE, DOCS_ROWS, DOCS_SOURCES, docsConnections, hasOn } from "./application/docs";
import { atLeast } from "./domain/rules";
import { capabilityId, credentialFor, prepareEffect, redact, storedConnection, toEffect, type Call, type ConnectionCredential, type Credentials, type MediaLinks } from "./application/effects";
import { CallFailed, createHost, NotStarted, type HostOptions, type Spawner } from "./application/host";
import { storedBundle } from "./application/installer";
import type { InstalledPlugin } from "./adapters/installs";
import { inProcessCall } from "./application/in-process";
import { triggers, type OnEvent, type SkipMailFor, type VerifyWebhook } from "./application/triggers";

export type { CredentialUse, Credentials, MediaLinks, Prepared } from "./application/effects";
export { CallFailed, failureOf, type Failure, type HostOptions, type Spawner } from "./application/host";
export { confinedSpawn } from "./adapters/confined";
export { installRefusals, permissionHash, type InstallChecks } from "./application/install";
export { isPublicSuffix } from "./adapters/public-suffix";
export { installGate, listenForInstalls, listInstalled, type InstalledPlugin } from "./adapters/installs";
export { pluginRoutes, type PluginRouteDeps } from "./routes";
export { probePlugin, type ProbeResult } from "./application/probe";
export { MAX_BUNDLE_BYTES, prepareInstall, storeBundle, storedBundle, upgradeDiff, type InstallPlan } from "./application/installer";
export { receivedMail, type CatalogueEvent, type CustomEvent, type SkipMailFor, type TriggerEvent, type VerifyWebhook, type WebhookRequest } from "./application/triggers";
export { createPluginWebhooks, webhookVerifier, WEBHOOK_MAX_BYTES, type PluginWebhooks } from "./application/webhooks";
export { assertBound } from "./domain/rules";

// 0.2.0: a poll may be handed mail to skip (SkipMail), so placement mail is never fetched.
export const HOST_VERSION = "0.2.0";

/** A query's capability id, `<plugin id>/<name>`, typed by its catalogue name. */
export type QueryId<N extends QueryName = QueryName> = `${string}/${N}`;
/**
 * A plugin query through one credential (null: the connection's own): its input and its answer are
 * the catalogue entry's (ADR 0028 rule 001).
 */
export type Query = <N extends QueryName>(workspaceId: string, capability: QueryId<N>, input: QueryInput<N>, credentialId: string | null) => Promise<QueryOutput<N>>;
/** The same for one query, for a module that asks only that one. */
export type QueryOf<N extends QueryName> = (workspaceId: string, capability: QueryId<N>, input: QueryInput<N>, credentialId: string | null) => Promise<QueryOutput<N>>;

/** First-party plugins run in process; everything else runs as its own process. */
export type PluginSource =
  | { mode: "in_process"; plugin: Plugin }
  | { mode: "process"; manifest: unknown; entry: string; dir: string };

export type PluginsDeps = {
  sources: PluginSource[];
  credentials: Credentials;
  /** "external" only where egress limits are enforced outside the plugin process. */
  confinement: "external" | "none";
  /** How out-of-process plugins start: `confinedSpawn` where they run for real. */
  spawn?: Spawner;
  /**
   * Third-party plugins a Server admin installed (ADR 0026). `reload` reads the list; every call
   * first passes `gate`, in its own transaction, so a removed, upgraded or turned-off plugin is
   * refused even before this process has reloaded.
   */
  installed?: {
    list: () => Promise<InstalledPlugin[]>;
    storeDir: string;
    gate: (workspaceId: string, pluginId: string, entrySha256: string) => Promise<string | null>;
  };
  log?: (line: string) => void;
  /** A provider refused this credential during a call, so it needs a reconnect. */
  onCredentialRejected?: (workspaceId: string, credentialId: string) => Promise<void>;
  /** Links to approved files, for effects whose manifest grants media: "read". */
  mediaLinks?: MediaLinks;
  hostOptions?: Partial<HostOptions>;
  /** Triggers: where new events go, in the transaction that records them. */
  onEvent?: OnEvent;
  verifyWebhook?: VerifyWebhook;
  /** Mail a mailbox poll must not read, such as Placement checks this install expects. */
  skipMail?: SkipMailFor;
  /** Runs the plugins.poll chain; needed only for poll triggers. */
  boss?: PgBoss;
  now?: () => Date;
};

/** The probe pair on one mailbox connection, when the manifest declares both. */
function probeOf(m: Manifest, connection: string): Pick<MailboxProvider, "probe"> {
  const send = m.capabilities.find((c) => c.connection === connection && c.kind === "effect" && c.name === MAILBOX_PROBE);
  const read = m.capabilities.some((c) => c.connection === connection && c.kind === "query" && c.name === MAILBOX_PROBE_READ);
  return send?.kind === "effect" && read ? { probe: { send: capabilityId(m.id, MAILBOX_PROBE), dedupe: send.dedupe, read: capabilityId(m.id, MAILBOX_PROBE_READ) } } : {};
}

/** A placement effect on one mailbox connection, when the manifest declares it. */
function placementOf(m: Manifest, connection: string, name: string): { send: string; dedupe: DedupeClass } | undefined {
  const c = m.capabilities.find((c) => c.connection === connection && c.kind === "effect" && c.name === name);
  return c?.kind === "effect" ? { send: capabilityId(m.id, name), dedupe: c.dedupe } : undefined;
}
function joinOf(m: Manifest, connection: string): Pick<MailboxProvider, "join" | "check" | "report" | "archive" | "readCheck"> {
  const join = placementOf(m, connection, PLACEMENT_JOIN);
  const check = placementOf(m, connection, PLACEMENT_SEND);
  const report = placementOf(m, connection, PLACEMENT_REPORT);
  const archive = placementOf(m, connection, PLACEMENT_ARCHIVE);
  const read = m.capabilities.some((c) => c.connection === connection && c.kind === "query" && c.name === PLACEMENT_READ);
  return { ...(join && { join }), ...(check && { check }), ...(report && { report }), ...(archive && { archive }), ...(read && { readCheck: capabilityId(m.id, PLACEMENT_READ) }) };
}

export type MailboxProvider = {
  pluginId: string;
  connection: string;
  dedupe: DedupeClass;
  send: string;
  mailFrom: QueryId<"mail.from">;
  profile: QueryId<"mailbox.profile">;
  /** Present when the provider can send a probe to itself and read it back; without them it can't be checked. */
  probe?: { send: string; dedupe: DedupeClass; read: QueryId<"mailbox.probe_read"> };
  /** Present when the provider can send the reply that joins the Placement circle. */
  join?: { send: string; dedupe: DedupeClass };
  /** Present when the provider can send a Placement check. */
  check?: { send: string; dedupe: DedupeClass };
  /** Present when the provider can send the daily report of the checks a Mailbox read. */
  report?: { send: string; dedupe: DedupeClass };
  /** Present when the provider can take a received Placement check out of the inbox. */
  archive?: { send: string; dedupe: DedupeClass };
  /** Present when the provider can say where an expected Placement check landed. */
  readCheck?: QueryId<"placement.read">;
  /** True when the provider has the mail.sent poll trigger, so Sent mail can say whom the account writes to. */
  readsSent: boolean;
};
export { EMAIL_RECEIVED, MAIL_SENT, MAILBOX_PROBE, PLACEMENT_EFFECTS } from "./application/mailbox";

/** entrySha256 is set for an installed plugin: the bytes its processes run. */
type Loaded = { manifest: Manifest; call: Call; credential: ConnectionCredential; inCore: boolean; entrySha256?: string };

function manifestOf(source: PluginSource): Manifest {
  if (source.mode === "in_process") {
    if (source.plugin.manifest.trust !== "first_party") {
      throw new Error(`plugin ${source.plugin.manifest.id}: only first-party plugins run in process`);
    }
    return source.plugin.manifest;
  }
  const r = parseManifest(source.manifest);
  if (!r.ok) throw new Error(`invalid manifest: ${r.errors.join("; ")}`);
  return r.manifest;
}

/** What this host cannot run yet, checked at load so nothing fails later at dispatch. */
function unsupported(m: Manifest): string[] {
  const out: string[] = [];
  if (!atLeast(HOST_VERSION, m.minHostVersion)) out.push(`needs host ${m.minHostVersion}, this is ${HOST_VERSION}`);
  for (const c of m.capabilities) {
    if (c.kind === "effect" && c.costs) out.push(`effect ${c.name} declares costs, and budgets are not supported by this host`);
  }
  return out;
}

export function loadPlugins(deps: PluginsDeps) {
  const log = deps.log ?? ((line: string) => console.log(line));
  const host = createHost({ confinement: deps.confinement, hostVersion: HOST_VERSION, log, options: deps.hostOptions, ...(deps.spawn && { spawn: deps.spawn }) });
  const loaded = new Map<string, Loaded>();

  for (const source of deps.sources) {
    const manifest = manifestOf(source);
    const problems = unsupported(manifest);
    if (problems.length) throw new Error(`plugin ${manifest.id} is not supported by this host: ${problems.join("; ")}`);
    if (loaded.has(manifest.id)) throw new Error(`plugin ${manifest.id} is loaded twice`);
    const call: Call =
      source.mode === "in_process"
        ? inProcessCall(source.plugin, log)
        : (workspaceId, method, params) =>
            host.call({ manifest, entry: source.entry, dir: source.dir }, workspaceId, method, params);
    loaded.set(manifest.id, { manifest, call, credential: credentialFor(manifest, deps.credentials), inCore: source.mode === "in_process" });
  }

  // One object for the life of the host: the ledger holds it, and installs add and remove keys in place.
  const effects: Record<string, EffectCapability> = {};
  function addEffects({ manifest, call, credential, inCore }: Loaded) {
    for (const c of manifest.capabilities) {
      if (c.kind !== "effect") continue;
      // Skipping the Touch skips Touch caps and suppression, so only code shipped in core may claim
      // its effect reaches no Person. A plugin's own manifest, trust field included, can't.
      const reaches = reachesPerson(c.name, c.reachesPerson, inCore);
      if (reaches !== c.reachesPerson) log(`plugin ${manifest.id}: ${c.name} is treated as ${reaches ? "reaching" : "not reaching"} a Person, which core decides`);
      effects[capabilityId(manifest.id, c.name)] = { ...toEffect(c, call, credential, deps.onCredentialRejected, deps.mediaLinks), reachesPerson: reaches };
    }
  }
  for (const p of loaded.values()) addEffects(p);

  // Installed plugins are never mailbox, social, docs or search providers: those shapes are refused
  // at install (ADR 0026 rule 003), so the maps below hold first-party plugins only.
  const installedIds = new Set<string>();
  function drop(pluginId: string) {
    loaded.delete(pluginId);
    installedIds.delete(pluginId);
    for (const id of Object.keys(effects)) if (id.startsWith(`${pluginId}/`)) delete effects[id];
  }
  function adopt(row: InstalledPlugin, installs: NonNullable<PluginsDeps["installed"]>) {
    const parsed = parseManifest(row.manifest);
    if (!parsed.ok) return log(`installed plugin ${row.pluginId} has a manifest this host can't read, so it isn't loaded: ${parsed.errors.join("; ")}`);
    const manifest = parsed.manifest;
    if (manifest.id !== row.pluginId || manifest.trust !== "third_party") return log(`installed plugin ${row.pluginId} isn't loaded: its manifest doesn't match its install`);
    if (loaded.has(manifest.id)) return log(`installed plugin ${manifest.id} isn't loaded: a plugin this server ships has that id`);
    const problems = unsupported(manifest);
    if (problems.length) return log(`installed plugin ${manifest.id} isn't loaded: ${problems.join("; ")}`);
    const entry = storedBundle(installs.storeDir, row.entrySha256);
    const call: Call = async (workspaceId, method, params) => {
      const why = await installs.gate(workspaceId, manifest.id, row.entrySha256);
      if (why) throw new NotStarted(`plugin ${manifest.id} can't run here: ${why}`, false);
      return host.call({ manifest, entry, dir: installs.storeDir }, workspaceId, method, params);
    };
    const p: Loaded = { manifest, call, credential: credentialFor(manifest, deps.credentials, true), inCore: false, entrySha256: row.entrySha256 };
    loaded.set(manifest.id, p);
    installedIds.add(manifest.id);
    addEffects(p);
  }
  /**
   * Brings installed plugins in line with the database (rule 004): a removed or re-uploaded plugin
   * is dropped and its processes stopped, a new one loaded. One reload at a time.
   */
  let reloading: Promise<void> = Promise.resolve();
  function reload(): Promise<void> {
    const installs = deps.installed;
    if (!installs) return Promise.resolve();
    reloading = reloading.then(async () => {
      const rows = await installs.list();
      const now = new Map(rows.map((r) => [r.pluginId, r]));
      for (const id of [...installedIds]) {
        if (now.get(id)?.entrySha256 === loaded.get(id)?.entrySha256) continue;
        drop(id);
        await host.stopPlugin(id);
      }
      for (const row of rows) if (!installedIds.has(row.pluginId)) adopt(row, installs);
    });
    return reloading;
  }

  const mailboxes = new Map<string, MailboxProvider>();
  for (const { manifest } of loaded.values()) {
    const { shapes, incomplete } = mailboxShapes(manifest);
    for (const i of incomplete) log(`plugin ${manifest.id}: connection ${i.connection} is not a mailbox provider, it lacks ${i.missing.join(", ")}`);
    for (const { connection, dedupe } of shapes) {
      if (mailboxes.has(connection)) throw new Error(`two mailbox providers use the connection ${connection}`);
      mailboxes.set(connection, {
        pluginId: manifest.id,
        connection,
        dedupe,
        send: capabilityId(manifest.id, EMAIL_SEND),
        mailFrom: capabilityId(manifest.id, MAIL_FROM),
        profile: capabilityId(manifest.id, MAILBOX_PROFILE),
        ...probeOf(manifest, connection),
        ...joinOf(manifest, connection),
        readsSent: manifest.capabilities.some((c) => c.connection === connection && c.kind === "trigger" && c.name === MAIL_SENT && c.source === "poll"),
      });
    }
  }

  const socials = new Map<string, { pluginId: string; identity: QueryId<"social.identity">; health: QueryId<"social.health">; publish?: string; dedupe?: DedupeClass }>();
  for (const { manifest } of loaded.values()) {
    for (const c of manifest.capabilities) {
      if (c.kind !== "query" || c.name !== SOCIAL_IDENTITY) continue;
      if (!manifest.capabilities.some((h) => h.kind === "query" && h.name === SOCIAL_HEALTH && h.connection === c.connection)) {
        log(`plugin ${manifest.id}: connection ${c.connection} is not a social network, it lacks ${SOCIAL_HEALTH}`);
        continue;
      }
      if (socials.has(c.connection)) throw new Error(`two social networks use the connection ${c.connection}`);
      const publish = manifest.capabilities.find((p) => p.kind === "effect" && p.name === SOCIAL_PUBLISH && p.connection === c.connection);
      socials.set(c.connection, {
        pluginId: manifest.id,
        identity: capabilityId(manifest.id, SOCIAL_IDENTITY),
        health: capabilityId(manifest.id, SOCIAL_HEALTH),
        ...(publish?.kind === "effect" && { publish: capabilityId(manifest.id, SOCIAL_PUBLISH), dedupe: publish.dedupe }),
      });
    }
  }

  function find(id: string, kind: "effect" | "query") {
    const [pluginId, name] = id.split("/") as [string, string];
    const p = loaded.get(pluginId);
    const decl = p?.manifest.capabilities.find((c) => c.name === name && c.kind === kind);
    if (!p || !decl) throw new Error(`no ${kind} capability ${id}`);
    return { ...p, decl };
  }

  /**
   * The one place a query is called. What goes in and what comes back are parsed through the query's
   * catalogue entry, whichever way the plugin runs; an answer that doesn't fit is the provider's
   * error, and the message names the query, never the answer.
   */
  async function ask<N extends QueryName>(workspaceId: string, call: Call, name: string, input: QueryInput<N>, credential: Credential | null): Promise<QueryOutput<N>> {
    const entry = queryEntry(name);
    if (!entry) throw new Error(`${name} is not a query in the catalogue`);
    const sent = entry.input.safeParse(input);
    if (!sent.success) throw new Error(`the input for ${name} does not fit its catalogue entry`);
    const r = (await call(workspaceId, "query", { capability: name, input: sent.data, credential })) as { output: unknown } | null;
    const out = entry.output.safeParse(r?.output);
    if (!out.success) throw new CallFailed(`the answer to ${name} does not fit its catalogue entry`, { reason: "provider_error" });
    // Parsed through the entry named by the capability id, whose type names the same entry.
    return out.data as QueryOutput<N>;
  }

  /**
   * A read with a credential a person just typed, before anything is stored: it goes to this one call
   * only, and the plugin's message comes back with the credential's secret removed.
   */
  async function queryTyped<N extends QueryName>(workspaceId: string, capability: QueryId<N>, input: QueryInput<N>, credential: Credential): Promise<QueryOutput<N>> {
    const { call, decl } = find(capability, "query");
    try {
      return await ask<N>(workspaceId, call, decl.name, input, credential);
    } catch (e) {
      // The secret leaves the message; the typed fields stay for the caller.
      throw new CallFailed(redact((e as Error).message.replace(/^plugin error: /, ""), credential) ?? "", e instanceof CallFailed ? e : { reason: "failed" });
    }
  }

  return {
    socialFor: (connection: string | null) => (connection ? socials.get(connection) : undefined),
    socialConnections: () => [...socials.keys()],
    /** Who a credential not yet stored belongs to: it goes to this one call only. */
    async identifySocial(workspaceId: string, connection: string, credential: Credential): Promise<QueryOutput<"social.identity">> {
      const provider = socials.get(connection);
      if (!provider) throw new Error(`no social network for ${connection}`);
      return queryTyped(workspaceId, provider.identity, null, credential);
    },
    /** Re-reads the installed third-party plugins; a no-op without them. */
    reload,
    /** Installed plugins' API-key connections, as the vault stores them, for the connect page. */
    installedKeyServices: () =>
      [...installedIds].flatMap((id) => {
        const m = loaded.get(id)!.manifest;
        return m.connections.filter((c) => c.auth === "api_key").map((c) => ({ connection: storedConnection(id, c.key), name: m.name ?? m.id }));
      }),
    /** Effect capabilities by capability id (`<plugin id>/<name>`), for createLedger. */
    effects,
    /** A hash of one effect's declaration, or null once it is gone. Other capabilities don't move it. */
    capabilityVersion(id: string): string | null {
      const [pluginId, name] = id.split("/") as [string, string];
      const p = loaded.get(pluginId);
      const decl = p?.manifest.capabilities.find((c) => c.name === name && c.kind === "effect");
      if (!decl) return null;
      // An installed plugin's bytes are part of it, so new bytes send waiting approvals back (rule 010).
      const h = createHash("sha256").update(JSON.stringify(decl));
      if (p?.entrySha256) h.update(` ${p.entrySha256}`);
      return h.digest("hex");
    },
    /** The mailbox provider behind a credential's connection, if there is one. */
    mailboxFor: (connection: string | null) => (connection ? mailboxes.get(connection) : undefined),
    mailboxConnections: () => [...mailboxes.keys()],
    /** The mailbox provider whose send capability this is, if any. */
    mailboxBySend: (capability: string) => [...mailboxes.values()].find((m) => m.send === capability),
    /** Renders an effect's input into the spec a person approves. No side effects. */
    async prepare(workspaceId: string, capability: string, input: unknown) {
      const { call, decl } = find(capability, "effect");
      return prepareEffect(decl.name, input, (sent) => call(workspaceId, "prepare", { capability: decl.name, input: sent }));
    },
    /** A read from the provider, through one credential. Not a ledger Action, because it changes nothing. */
    async query<N extends QueryName>(workspaceId: string, capability: QueryId<N>, input: QueryInput<N>, credentialId: string | null = null): Promise<QueryOutput<N>> {
      const { call, decl, credential } = find(capability, "query");
      const token = await credential(workspaceId, decl, credentialId, { consumer: "query" });
      return ask<N>(workspaceId, call, decl.name, input, token);
    },
    queryTyped,
    /**
     * Tests a mailbox's sign-in before anything is stored: the typed credential goes to this one
     * call only. Throws the plugin's message with the credential's secret removed.
     */
    async checkMailbox(workspaceId: string, connection: string, credential: Credential): Promise<QueryOutput<"mailbox.profile">> {
      const provider = mailboxes.get(connection);
      if (!provider) throw new Error(`no mailbox provider for ${connection}`);
      return queryTyped(workspaceId, provider.profile, null, credential);
    },
    ...triggers({
      loaded,
      onEvent: deps.onEvent,
      verifyWebhook: deps.verifyWebhook,
      skipMail: deps.skipMail,
      boss: deps.boss,
      log,
      now: deps.now ?? (() => new Date()),
    }),
    processes: host.processes,
    close: host.close,
  };
}

export type Plugins = ReturnType<typeof loadPlugins>;

/**
 * The connections a person connects by pasting an API key, named as their plugin names itself.
 * `balance` and `profile` are the queries that tell whether a stored key still works, when the
 * plugin has one: a verification service's credits, or a newsletter list's name and size.
 */
export function keyConnections(manifests: readonly Manifest[]) {
  return manifests.flatMap((m) =>
    m.connections
      .filter((c) => c.auth === "api_key")
      .map((c) => {
        const query = <N extends QueryName>(name: N) => (m.capabilities.some((q) => q.kind === "query" && q.name === name && q.connection === c.key) ? capabilityId(m.id, name) : null);
        return { connection: c.key, name: m.name ?? m.id, balance: query(VERIFY_BALANCE), profile: query(NEWSLETTER_PROFILE) };
      }),
  );
}
export type NewsletterList = {
  connection: string;
  /** The tool's name as its plugin gives it, for words a person reads. */
  name: string;
  subscribers: QueryId<"newsletter.subscribers">;
  profile: QueryId<"newsletter.profile">;
  /** Null for a tool that reports nothing after a send. */
  stats: QueryId<"newsletter.stats"> | null;
  /** The query naming the account's lists, for a tool whose account holds several; null otherwise. */
  lists: QueryId<"newsletter.lists"> | null;
  publish: string;
  publishDedupe: DedupeClass;
  publishLeadMs: number;
};
/** Each newsletter list connection, with its queries and the effect that publishes an issue. */
export function newsletterLists(manifests: readonly Manifest[]): NewsletterList[] {
  return manifests.flatMap((m) =>
    newsletterShapes(m).shapes.map((s) => ({
      connection: s.connection,
      name: m.name ?? m.id,
      subscribers: capabilityId(m.id, NEWSLETTER_SUBSCRIBERS),
      profile: capabilityId(m.id, NEWSLETTER_PROFILE),
      stats: s.hasStats ? capabilityId(m.id, NEWSLETTER_STATS) : null,
      lists: s.hasLists ? capabilityId(m.id, NEWSLETTER_LISTS) : null,
      publish: capabilityId(m.id, NEWSLETTER_PUBLISH),
      publishDedupe: s.publishDedupe,
      publishLeadMs: s.publishLeadMs,
    })),
  );
}
export type SearchProvider = { connection: string; properties: QueryId<"search.properties">; analytics: QueryId<"search.analytics"> };
/** Each connection that reads search data, with its two queries. */
export function searchProviders(manifests: readonly Manifest[]): SearchProvider[] {
  return manifests.flatMap((m) => searchConnections(m).map((connection) => ({ connection, properties: capabilityId(m.id, SEARCH_PROPERTIES), analytics: capabilityId(m.id, SEARCH_ANALYTICS) })));
}
/** A docs tool: the connections that reach it (a typed key, an OAuth sign-in), and its queries and write. */
export type DocsProvider = { connections: string[]; oauth: string | null; name: string; sources: QueryId<"docs.sources">; pageText: QueryId<"docs.page_text">; rows: QueryId<"docs.rows"> | null; write: string | null };
/** Each plugin whose connections read a docs tool's pages, with its two queries, and its rows query and write when every connection has them. */
export function docsProviders(manifests: readonly Manifest[]): DocsProvider[] {
  return manifests.flatMap((m) => {
    const connections = docsConnections(m);
    const all = (name: string, kind = "query") => connections.every((k) => hasOn(m, k, name, kind));
    if (!connections.length) return [];
    return [
      {
        connections,
        oauth: m.connections.find((c) => c.auth === "oauth2" && connections.includes(c.key))?.key ?? null,
        name: m.name ?? m.id,
        sources: capabilityId(m.id, DOCS_SOURCES),
        pageText: capabilityId(m.id, DOCS_PAGE_TEXT),
        rows: all(DOCS_ROWS) ? capabilityId(m.id, DOCS_ROWS) : null,
        // A status write-back needs rows to write to (ADR 0025).
        write: all(DOCS_ROWS) && all(DOCS_ROW_UPDATE, "effect") ? capabilityId(m.id, DOCS_ROW_UPDATE) : null,
      },
    ];
  });
}
export const SOCIAL_IDENTITY = "social.identity";
export const SOCIAL_HEALTH = "social.health";
export const SOCIAL_PUBLISH = "social.publish";

/**
 * Whether replies to the Action's mailbox were read recently. Holds for every mailbox provider;
 * a capability that isn't a mailbox send has no replies to read.
 */
export const mailboxRepliesRead =
  (plugins: Pick<Plugins, "mailboxBySend">, a: { now: () => Date; withinMs: number }) =>
  async (tx: PluginTx, action: { capability: string; credentialId: string | null; workspaceId: string }): Promise<boolean> => {
    const provider = plugins.mailboxBySend(action.capability);
    if (!provider) return true;
    const at = await lastPollAt(tx, { workspaceId: action.workspaceId, pluginId: provider.pluginId, trigger: EMAIL_RECEIVED, credentialId: action.credentialId });
    return !!at && a.now().getTime() - at.getTime() <= a.withinMs;
  };
