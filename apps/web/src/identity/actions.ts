// SPDX-License-Identifier: AGPL-3.0-only
// The Members calls. Each change returns the API's error code, or null when it worked.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";

type S = components["schemas"];
export type Member = S["Member"];
export type Invite = S["Invite"];
export type Role = S["Role"];

const at = (workspaceId: string) => ({ path: { workspaceId } });

export const membersQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "members"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/members", { params: at(workspaceId) }))).members });

export const invitesQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "invites"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/invites", { params: at(workspaceId) }))).invites });

/** Sends an invite. `resent` when that email already had one waiting, which then goes out again with a new link. */
export async function invite(workspaceId: string, email: string, role: Role): Promise<{ error: string } | { resent: boolean }> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/invites", { params: at(workspaceId), body: { email, role } });
  return error ? { error: error.error } : { resent: data.resent };
}

export async function revoke(workspaceId: string, inviteId: string): Promise<string | null> {
  const { error } = await api.DELETE("/api/w/{workspaceId}/invites/{inviteId}", { params: { path: { workspaceId, inviteId } } });
  return error ? error.error : null;
}

/** These routes' only 400 is a link whose id or token isn't one, cut short or mistyped. */
const linkCode = (response: Response, code: string) => (response.status === 400 ? "bad_link" : code);

/** The Workspace an invite joins and who sent it, or why it can't be used. */
export async function previewInvite(workspaceId: string, token: string): Promise<{ workspace: string; invitedBy: string } | { error: string }> {
  const { data, error, response } = await api.POST("/api/invites/preview", { body: { workspaceId, token } });
  return error ? { error: linkCode(response, error.error) } : { workspace: data.workspace.name, invitedBy: data.invitedBy };
}

/** Joins the Workspace an invite names. Returns the API's error code, or null when it worked. */
export async function acceptInvite(workspaceId: string, token: string): Promise<string | null> {
  const { error, response } = await api.POST("/api/invites/accept", { body: { workspaceId, token } });
  return error ? linkCode(response, error.error) : null;
}

/** Whether this server has a Server admin yet, and whether the signed-in person may create an Organization. */
export const serverStatusQuery = queryOptions({ queryKey: ["server-status"], queryFn: () => call(api.GET("/api/server/status")) });

// The Server page (ADR 0024). Each change returns the API's error code, or null when it worked.
export type SignupPolicy = S["SignupPolicy"];
export type Account = S["Account"];
const SERVER = ["server"];
export const policyQuery = queryOptions({ queryKey: [...SERVER, "policy"], queryFn: () => call(api.GET("/api/server/policy")) });
export const mailStatusQuery = queryOptions({ queryKey: [...SERVER, "mail"], queryFn: async () => (await call(api.GET("/api/server/mail-status"))).ok });
export const accountsQuery = queryOptions({ queryKey: [...SERVER, "accounts"], queryFn: async () => (await call(api.GET("/api/server/accounts"))).accounts });

export async function setPolicy(body: SignupPolicy): Promise<string | null> {
  const { error } = await api.PUT("/api/server/policy", { body });
  return error ? error.error : null;
}
export async function addServerAdmin(email: string): Promise<string | null> {
  const { error } = await api.POST("/api/server/admins", { body: { email } });
  return error ? error.error : null;
}
export async function removeServerAdmin(userId: string): Promise<string | null> {
  const { error } = await api.DELETE("/api/server/admins/{userId}", { params: { path: { userId } } });
  return error ? error.error : null;
}

// Third-party plugins on the Server page (ADR 0026 rule 001). Each change returns the API's error code, or null.
export type PluginSummary = S["PluginSummary"];
export type PluginReview = S["PluginReview"];
export const serverPluginsQuery = queryOptions({ queryKey: [...SERVER, "plugins"], queryFn: async () => (await call(api.GET("/api/server/plugins"))).plugins });

/** Sends a plugin bundle to be read in the sandbox. Nothing is installed: the review says what it asks for, or why it is refused. */
export async function reviewPlugin(file: File): Promise<PluginReview | { error: string; reasons: string[] }> {
  // The body is the file's bytes; the client would otherwise send the body as JSON.
  const { data, error, response } = await api.POST("/api/server/plugins/review", { body: "", bodySerializer: () => file, headers: { "content-type": "application/octet-stream" } });
  if (data) return data;
  // A proxy in front of Direx may answer 413 itself, with no JSON body.
  if (response.status === 413) return { error: "too_large", reasons: [] };
  return { error: error?.error ?? "failed", reasons: error && "reasons" in error ? error.reasons : [] };
}
export async function confirmPlugin(review: Pick<PluginReview, "stageId" | "entrySha256">): Promise<string | null> {
  const { error } = await api.POST("/api/server/plugins/confirm", { body: { stageId: review.stageId, entrySha256: review.entrySha256 } });
  return error ? error.error : null;
}
export async function removePlugin(pluginId: string): Promise<string | null> {
  const { error } = await api.DELETE("/api/server/plugins/{pluginId}", { params: { path: { pluginId } } });
  return error ? error.error : null;
}

/** Makes the signed-in person this server's first Server admin. Returns the API's error code, or null when it worked. */
export async function claimServer(token: string): Promise<string | null> {
  const { error, response } = await api.POST("/api/server/claim", { body: { token } });
  return error ? linkCode(response, error.error) : null;
}

/** A new Organization with its first Workspace; the Workspace's id, or null when refused. */
export async function createOrg(name: string, workspaceName: string): Promise<string | null> {
  const { data } = await api.POST("/api/orgs", { body: { name, workspaceName } });
  return data?.workspace.id ?? null;
}

/** A password for an account that signs in by email link, Google or Microsoft. Returns the API's error code, or null when it worked. */
export async function addPassword(password: string): Promise<string | null> {
  const { error, response } = await api.POST("/api/account/password", { body: { password } });
  // The only 400 is the length the API checks.
  return error ? (response.status === 400 ? "password_length" : error.error) : null;
}
