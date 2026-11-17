// SPDX-License-Identifier: AGPL-3.0-only
// The credential calls the page makes, and how its forms become requests. Each call
// returns the API's error code, or null when it worked. A value is sent once and never kept.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";

type S = components["schemas"];
export type Credential = S["Credential"];
export type AccessEvent = S["CredentialAccessEvent"];
export type Kind = Exclude<Credential["kind"], "oauth2">;

type Field = { field: string; label: string };
/** What each kind asks for: an optional plain field (meta) and the write-only value. */
export const KINDS: Record<Kind, { label: string; meta?: Field; value: Field }> = {
  api_key: { label: "API key", value: { field: "key", label: "Key" } },
  header: { label: "Request header", meta: { field: "headerName", label: "Header name" }, value: { field: "value", label: "Header value" } },
  basic: { label: "Username and password", meta: { field: "username", label: "Username" }, value: { field: "password", label: "Password" } },
  secret: { label: "Other", value: { field: "value", label: "Value" } },
};

/**
 * The rows of each tab: every Mailbox, the Workspace's credentials, and the viewer's own. Only a
 * Mailbox provider's connection is a Mailbox. A network account or a service's key has its own
 * place, so it is in none of them; any other connection of the viewer's, such as Search Console,
 * is one of their own.
 */
export function split(all: Credential[], me: string, networks: readonly string[] = [], services: readonly string[] = [], mailboxes: readonly string[] = []) {
  const is = (list: readonly string[]) => (c: Credential) => !!c.connection && list.includes(c.connection);
  const [network, service, mailbox] = [is(networks), is(services), is(mailboxes)];
  return {
    mailboxes: all.filter(mailbox),
    workspace: all.filter((c) => c.scope === "workspace" && !service(c)),
    mine: all.filter((c) => c.scope === "user" && c.ownerUserId === me && !mailbox(c) && !network(c) && !service(c)),
  };
}

const at = (workspaceId: string) => ({ path: { workspaceId } });
const one = (workspaceId: string, id: string) => ({ path: { workspaceId, id } });

export const credentialsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "credentials"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/credentials", { params: at(workspaceId) }))).credentials });

export type NewCredential = { scope: "workspace" | "user"; kind: Kind; key: string; name: string; meta: string; value: string };

export async function add(workspaceId: string, f: NewCredential): Promise<string | null> {
  const k = KINDS[f.kind];
  const { error } = await api.POST("/api/w/{workspaceId}/credentials", {
    params: at(workspaceId),
    body: { scope: f.scope, kind: f.kind, key: f.key, name: f.name, meta: k.meta ? { [k.meta.field]: f.meta } : {}, value: { [k.value.field]: f.value } },
  });
  return error ? error.error : null;
}

export async function rotate(workspaceId: string, c: Credential, value: string): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/credentials/{id}/value", {
    params: one(workspaceId, c.id),
    body: { version: c.version, value: { [KINDS[c.kind as Kind].value.field]: value } },
  });
  return error ? error.error : null;
}

export async function remove(workspaceId: string, id: string): Promise<string | null> {
  const { error } = await api.DELETE("/api/w/{workspaceId}/credentials/{id}", { params: one(workspaceId, id) });
  return error ? error.error : null;
}

export async function history(workspaceId: string, id: string): Promise<AccessEvent[] | string> {
  const { data, error } = await api.GET("/api/w/{workspaceId}/credentials/{id}/events", { params: one(workspaceId, id) });
  return data ? data.events : error!.error;
}

/** The provider's consent page to open, or the error code. */
export async function startConnect(workspaceId: string, connection: string): Promise<{ url: string } | { error: string }> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/connections/{connection}/start", { params: { path: { workspaceId, connection } } });
  return data ?? { error: error!.error };
}

export type MailboxProvider = S["MailboxProvider"];

export const mailboxProvidersQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "mailbox-providers"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/mailbox-providers", { params: at(workspaceId) }))).providers });

export const mailboxProviders = async (workspaceId: string): Promise<MailboxProvider[]> => (await api.GET("/api/w/{workspaceId}/mailbox-providers", { params: at(workspaceId) })).data?.providers ?? [];

/** The probe wording this page shows; the server refuses a Connect that names any other version. */
export const PROBE_WORDING_VERSION = "2026-11-05";

/** Signs in and saves, which also sends the Mailbox's test email. On failure, the error code or the mail server's reason. */
export async function connectWithForm(
  workspaceId: string,
  connection: string,
  f: { username: string; password: string; settings: Record<string, string> },
): Promise<{ hasSent: boolean | null; check: { state: string; reason: string | null } | null } | { error: string; detail?: string }> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/mailboxes/{connection}", { params: { path: { workspaceId, connection } }, body: { ...f, probeWording: PROBE_WORDING_VERSION } });
  return data ?? (error as { error: string; detail?: string });
}

export type MailboxCheck = S["MailboxCheck"];

/** Each Mailbox's current unsubscribe check; a Mailbox missing here was never checked. */
export const mailboxChecksQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "mailbox-checks"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/outreach/mailbox-checks", { params: at(workspaceId) }))).checks });

export const mailboxChecks = async (workspaceId: string): Promise<MailboxCheck[]> => (await api.GET("/api/w/{workspaceId}/outreach/mailbox-checks", { params: at(workspaceId) })).data?.checks ?? [];

/** Sends a new test email. The error code, or null when one is on its way. */
export async function checkAgain(workspaceId: string, credentialId: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/mailboxes/{credentialId}/check", { params: { path: { workspaceId, credentialId } }, body: { probeWording: PROBE_WORDING_VERSION } });
  return error ? error.error : null;
}

export type KeyService = S["KeyService"];
export type KeyCheck = S["KeyCheck"];

export const keyServicesQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "key-services"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/key-services", { params: at(workspaceId) }))).services });

export const keyServices = async (workspaceId: string): Promise<KeyService[]> => (await api.GET("/api/w/{workspaceId}/key-services", { params: at(workspaceId) })).data?.services ?? [];

/** Saves the Workspace's key for a service. The error code, or null when it worked. */
export async function connectKey(workspaceId: string, connection: string, key: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/key-services/{connection}", { params: { path: { workspaceId, connection } }, body: { key } });
  return error ? error.error : null;
}

/** Replaces the Workspace's key for a service, after the service accepts it. The error code, or null. */
export async function replaceKey(workspaceId: string, connection: string, key: string): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/key-services/{connection}", { params: { path: { workspaceId, connection } }, body: { key } });
  return error ? error.error : null;
}

/** What the service says about the stored key, or the error code. */
export async function checkKey(workspaceId: string, connection: string): Promise<S["KeyCheck"] | { error: string }> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/key-services/{connection}/check", { params: { path: { workspaceId, connection } } });
  return data ?? { error: error!.error };
}

// A Mailbox's pace, and the Workspace time zone it is read in.
export type Pace = S["MailboxPace"];
export const paceKey = (workspaceId: string, credentialId: string) => inWorkspace(workspaceId, "credentials", credentialId, "pace");
export const paceQuery = (workspaceId: string, credentialId: string) =>
  queryOptions({
    queryKey: paceKey(workspaceId, credentialId),
    queryFn: () => call(api.GET("/api/w/{workspaceId}/mailboxes/{credentialId}/pace", { params: { path: { workspaceId, credentialId } } })),
  });
/** Saves a Mailbox's pace: the API's error code, or null when it saved. */
export async function savePace(workspaceId: string, credentialId: string, pace: Pace): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/mailboxes/{credentialId}/pace", { params: { path: { workspaceId, credentialId } }, body: pace });
  return error ? error.error : null;
}

// Which Mailboxes are paused, and pausing or resuming one.
export const pausesQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "mailbox-pauses"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/outreach/mailbox-pauses", { params: at(workspaceId) }))).pauses });
/** Pauses or resumes a Mailbox: the API's error code, or null when it saved. */
export async function setPaused(workspaceId: string, credentialId: string, paused: boolean): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/outreach/mailboxes/{credentialId}/pause", { params: { path: { workspaceId, credentialId } }, body: { paused } });
  return error ? error.error : null;
}
export const zoneQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "time-zone"),
    queryFn: () => call(api.GET("/api/w/{workspaceId}/time-zone", { params: { path: { workspaceId } } })),
  });
export async function saveZone(workspaceId: string, timeZone: string): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/time-zone", { params: { path: { workspaceId } }, body: { timeZone } });
  return error ? error.error : null;
}

// A Mailbox's place in the Placement circle, and the join form.
export const placementQuery = (workspaceId: string, credentialId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "credentials", credentialId, "placement"),
    queryFn: () => call(api.GET("/api/w/{workspaceId}/mailboxes/{credentialId}/placement", { params: { path: { workspaceId, credentialId } } })),
  });
/** What a Mailbox's Placement checks found by week, and the reports it sent other members. */
export const placementResultsQuery = (workspaceId: string, credentialId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "credentials", credentialId, "placement", "results"),
    queryFn: () => call(api.GET("/api/w/{workspaceId}/mailboxes/{credentialId}/placement/results", { params: { path: { workspaceId, credentialId } } })),
  });
export type PlacementResults = S["PlacementResults"];
export type JoinCodes = { part1: string; part2: string; signer: string; messageId: string };
/** Sends the reply that joins the Placement circle: the API's error code, or null when it is on its way. */
export async function joinCircle(workspaceId: string, credentialId: string, codes: JoinCodes): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/mailboxes/{credentialId}/placement/join", { params: { path: { workspaceId, credentialId } }, body: codes });
  return error ? error.error : null;
}

// Third-party plugins a Server admin installed. Everyone sees them; only an Owner turns one on or off (ADR 0026 rule 002).
export type WorkspacePlugin = S["PluginSummary"] & { on: boolean };
export const workspacePluginsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "plugins"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/plugins", { params: at(workspaceId) }))).plugins });

/** Turns a plugin on or off in this Workspace. The error code, or null when it worked. */
export async function turnPlugin(workspaceId: string, pluginId: string, on: boolean): Promise<string | null> {
  const params = { path: { workspaceId, pluginId } };
  const { error } = on ? await api.PUT("/api/w/{workspaceId}/plugins/{pluginId}", { params }) : await api.DELETE("/api/w/{workspaceId}/plugins/{pluginId}", { params });
  return error ? error.error : null;
}
