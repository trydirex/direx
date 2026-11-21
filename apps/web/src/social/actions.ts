// SPDX-License-Identifier: AGPL-3.0-only
// The calls the Social accounts page makes. Each write returns the API's error code, or null when it worked.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { call, inWorkspace } from "../api/query";
import { api } from "../client";

type S = components["schemas"];
export type Network = S["SocialNetwork"];
export type Account = S["SocialAccount"];
export type Target = S["SocialTarget"];

const at = (workspaceId: string) => ({ path: { workspaceId } });
const login = (workspaceId: string, credentialId: string) => ({ path: { workspaceId, credentialId } });

export const networks = async (workspaceId: string): Promise<Network[]> => (await api.GET("/api/w/{workspaceId}/social/networks", { params: at(workspaceId) })).data?.networks ?? [];
export const accounts = async (workspaceId: string): Promise<Account[]> => (await api.GET("/api/w/{workspaceId}/social/accounts", { params: at(workspaceId) })).data?.accounts ?? [];
export const targets = async (workspaceId: string, credentialId: string): Promise<Target[]> => (await api.GET("/api/w/{workspaceId}/social/credentials/{credentialId}/targets", { params: login(workspaceId, credentialId) })).data?.targets ?? [];

export const networksQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "social", "networks"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/social/networks", { params: at(workspaceId) }))).networks });
export const accountsQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "social", "accounts"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/social/accounts", { params: at(workspaceId) }))).accounts });

/** `established` lists the targets a person says are older accounts; `angles` what each one is for, where the network asks. */
export async function addTargets(workspaceId: string, credentialId: string, ids: string[], about: { established?: string[]; angles?: Record<string, string> } = {}): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/social/credentials/{credentialId}/targets", { params: login(workspaceId, credentialId), body: { ids, ...about } });
  return error ? error.error : null;
}

// Connect links: connect an account from a device where Direx isn't signed in, then finish here.
export type ConnectLink = S["ConnectLink"];
export const linksQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "social", "links"), queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/connect-links", { params: at(workspaceId) }))).links });
export async function makeLink(workspaceId: string, connection: string): Promise<{ url: string; expiresAt: string } | { error: string }> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/connections/{connection}/links", { params: { path: { workspaceId, connection } } });
  return data ?? { error: error!.error };
}

const account = (workspaceId: string, accountId: string) => ({ path: { workspaceId, accountId } });

// An account's pace (ADR 0038): the hours its posts go out in and how far apart, in minutes from midnight.
export type SocialPace = S["SocialPace"];
export type OwnPace = S["SocialOwnPace"];
export const paceKey = (workspaceId: string, accountId: string) => inWorkspace(workspaceId, "social", "pace", accountId);
export const paceQuery = (workspaceId: string, accountId: string) =>
  queryOptions({ queryKey: paceKey(workspaceId, accountId), queryFn: () => call(api.GET("/api/w/{workspaceId}/social/accounts/{accountId}/pace", { params: account(workspaceId, accountId) })) });
/** Null values put the account back on its network's pace. */
export async function savePace(workspaceId: string, accountId: string, own: OwnPace): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/social/accounts/{accountId}/pace", { params: account(workspaceId, accountId), body: own });
  return error ? error.error : null;
}

/** Where the account itself says who runs it, and what it is for beside the Workspace's other accounts. */
export async function saveAbout(workspaceId: string, accountId: string, about: { runBy: string | null; angle: string | null }): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/social/accounts/{accountId}/about", { params: account(workspaceId, accountId), body: about });
  return error ? error.error : null;
}
export async function markEstablished(workspaceId: string, accountId: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/social/accounts/{accountId}/established", { params: account(workspaceId, accountId) });
  return error ? error.error : null;
}

/** Account health: a person lifts a pause, reports a removal, or lowers a daily limit. */
export async function unpause(workspaceId: string, accountId: string): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/social/accounts/{accountId}/unpause", { params: account(workspaceId, accountId) });
  return error ? error.error : null;
}
export async function reportRemoved(workspaceId: string, accountId: string, note: string | null): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/social/accounts/{accountId}/removed", { params: account(workspaceId, accountId), body: { note } });
  return error ? error.error : null;
}
export async function lowerLimits(workspaceId: string, accountId: string, limits: { posts?: number | null; links?: number | null }): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/social/accounts/{accountId}/limits", { params: account(workspaceId, accountId), body: limits });
  return error ? error.error : null;
}

export async function disconnect(workspaceId: string, credentialId: string): Promise<string | null> {
  const { error } = await api.DELETE("/api/w/{workspaceId}/social/credentials/{credentialId}", { params: login(workspaceId, credentialId) });
  return error ? error.error : null;
}

/** Signs in and saves. On failure, the error code and the network's reason. */
export async function connectForm(workspaceId: string, connection: string, f: { username: string; password: string }): Promise<{ credentialId: string } | { error: string; detail?: string }> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/social/{connection}/form", { params: { path: { workspaceId, connection } }, body: f });
  return data ?? (error as { error: string; detail?: string });
}

/** A Workspace's own app for a network: the client id in the clear, the secret encrypted. */
export async function saveApp(workspaceId: string, network: Pick<Network, "connection" | "label">, f: { clientId: string; clientSecret: string }): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/credentials", {
    params: at(workspaceId),
    body: { scope: "workspace", kind: "basic", key: `oauth_app:${network.connection}`, name: `${network.label} app`, meta: { username: f.clientId }, value: { password: f.clientSecret } },
  });
  return error ? error.error : null;
}

// Posts. Approving stays with Items; these write drafts and read what became of them.
export type Post = S["SocialPost"];
export type PostTarget = { connection: string; credentialId: string | null; networkId: string | null; text: string; followUps?: string[]; mediaId?: string | null; mediaIds?: string[]; alt?: string[] };
export type Video = { id: string; fileName: string; bytes: number };

const UPLOAD_REFUSALS: Record<string, string> = {
  too_large: "That file is too large: a video may be up to 2 GB, an image up to 10 MB.",
  not_supported: "That isn't an MP4, MOV or WebM video, or a PNG, JPEG, GIF or WebP image.",
};

/**
 * Uploads a video for a post. The body is the file itself, so it streams; openapi-fetch would read it
 * whole. Kept as a clip, so it doesn't age out like a source recording.
 */
export async function uploadVideo(workspaceId: string, file: File, kind: "clip" | "source" = "clip"): Promise<{ video: Video } | { error: string }> {
  const res = await fetch(`/api/w/${workspaceId}/media?kind=${kind}`, { method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) }, body: file });
  const body = (await res.json().catch(() => null)) as { media?: { id: string; fileName: string; bytes: number }; error?: string } | null;
  if (res.ok && body?.media) return { video: { id: body.media.id, fileName: body.media.fileName, bytes: body.media.bytes } };
  return { error: UPLOAD_REFUSALS[body?.error ?? ""] ?? "The upload didn't go through. Try again." };
}

/** Uploads an image for a post, the same way: what it is comes from its bytes, not its name. */
export async function uploadImage(workspaceId: string, file: File): Promise<{ image: Video } | { error: string }> {
  const r = await uploadVideo(workspaceId, file);
  return "video" in r ? { image: r.video } : r;
}

/** Where a person downloads a post's video to post it by hand. */
export const videoUrl = (workspaceId: string, mediaId: string) => `/api/w/${workspaceId}/media/${mediaId}`;
export const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
export type Preview = { ok: boolean; mode?: "publish" | "manual"; reason?: string; detail?: string; text?: string; count?: { used: number; limit: number } };
export type DraftResult = { connection: string; ok: boolean; reason?: string; detail?: string };

const POST_REASONS: Record<string, string> = {
  slot_in_past: "That time has passed. Pick a new one.",
  account_required: "This network can publish, so connect an account first.",
  reconnect: "Reconnect this account to post from it.",
  follow_ups_not_available: "This network can't take a follow-up comment yet.",
  not_available: "This account can't post yet.",
  unknown_account: "That account is no longer connected.",
  reconnect_for_video: "Reconnect this account to post video from it. Text posts still work.",
  unknown_media: "That file was deleted, or isn't the kind it was added as. Upload it again.",
  reconnect_for_images: "Reconnect this account to post images from it. Text posts still work.",
  video_and_images: "A post carries a video or images, not both.",
  too_many_images: "A post carries up to 4 images.",
  wrong_state: "It already went out or was cancelled, so its words can't change.",
  outcome_unknown: "It may already have posted. Check the network before changing it.",
};
export const sayPost = (r: { reason?: string; detail?: string }) => r.detail ?? POST_REASONS[r.reason ?? ""] ?? "That didn't go through. Try again.";

export const postsOf = async (workspaceId: string, campaignId: string, stepKey: string): Promise<Post[]> =>
  (await api.GET("/api/w/{workspaceId}/social/posts", { params: { path: { workspaceId }, query: { campaignId, stepKey } } })).data?.posts ?? [];

export const previewPost = async (workspaceId: string, target: PostTarget): Promise<Preview> =>
  (await api.POST("/api/w/{workspaceId}/social/posts/preview", { params: at(workspaceId), body: target })).data ?? { ok: false };

/** One result per account, or why the whole step was refused, in words. */
export async function draftPosts(workspaceId: string, id: string, key: string, plannedAt: string, targets: PostTarget[]): Promise<DraftResult[] | string> {
  const { data, error } = await api.PUT("/api/w/{workspaceId}/campaigns/{id}/steps/{key}/posts", { params: { path: { workspaceId, id, key } }, body: { plannedAt, targets } });
  return data?.results ?? sayPost({ reason: error?.error });
}

export const markPosted = async (workspaceId: string, itemId: string, url: string | null): Promise<boolean> =>
  !(await api.POST("/api/w/{workspaceId}/social/posts/{itemId}/posted", { params: { path: { workspaceId, itemId } }, body: { url } })).error;

/** A person's own words for a post: an error in words, or null once it waits for approval again. */
export async function editPost(workspaceId: string, itemId: string, text: string): Promise<string | null> {
  const { error } = await api.PUT("/api/w/{workspaceId}/social/posts/{itemId}", { params: { path: { workspaceId, itemId } }, body: { text } });
  return error ? sayPost({ reason: error.error, ...("detail" in error && error.detail && { detail: error.detail }) }) : null;
}
/** A post written on the Calendar, outside any campaign. It waits for approval. */
export async function writePost(workspaceId: string, post: { connection: string; credentialId: string | null; networkId: string | null; text: string; at: string }): Promise<string | null> {
  const { error } = await api.POST("/api/w/{workspaceId}/social/posts", { params: at(workspaceId), body: post });
  return error ? sayPost({ reason: error.error, ...("detail" in error && error.detail && { detail: error.detail }) }) : null;
}

/** What a post's state means here. Only a Network publishing it ever says published. */
export function postStatus(p: Pick<Post, "mode" | "state" | "reason">): string {
  if (p.mode === "manual") {
    if (p.state === "applied") return "Posted by you";
    if (p.state === "scheduled") return "Approved. Copy it and post it yourself.";
    if (p.state === "cancelled") return "Cancelled";
    return "Waiting for approval, then you post it yourself";
  }
  if (p.state === "sent") return "Published";
  if (p.state === "scheduled") return "Approved and scheduled";
  if (p.state === "held" || p.state === "blocked") return `Not published: ${p.reason ?? "held"}`;
  if (p.state === "cancelled") return "Cancelled";
  return "Waiting for approval";
}

/** A follow-up's result in words. "May have posted" isn't a failure: check before posting it again. */
export const sayFollowUp = (status: string, n: number) => (status === "posted" ? `Follow-up ${n} posted` : status === "uncertain" ? `Follow-up ${n} may have posted. Check before posting it again.` : `Follow-up ${n} didn't post. You can copy it by hand.`);
