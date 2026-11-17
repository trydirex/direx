// SPDX-License-Identifier: AGPL-3.0-only
// The Settings calls that belong to no other folder: a member's review time and its calendar link, and
// the Workspace export and deletion, and its External tokens.
import { queryOptions } from "@tanstack/react-query";
import { call, inWorkspace } from "../api/query";
import type { components } from "../api/schema";
import { api } from "../client";

export type ReviewSettings = components["schemas"]["ReviewFeedSettings"];
export type ReviewFeedState = components["schemas"]["ReviewFeedState"];
export type WorkspaceExport = components["schemas"]["WorkspaceExport"];
export type ExternalToken = components["schemas"]["ExternalToken"];
export type TokenChoices = components["schemas"]["ExternalTokenChoices"];
export type NewToken = { name: string; days: number; readers: string[]; kinds: string[] };

const inW = (workspaceId: string) => ({ params: { path: { workspaceId } } });

/** Every token in the Workspace, and what the create form may offer. */
export const tokensQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "external-tokens"), queryFn: () => call(api.GET("/api/w/{workspaceId}/external-tokens", inW(workspaceId))) });

/** Makes a token (Owners and Admins, behind step-up): the token, shown this once, or the API's error code. */
export async function makeToken(workspaceId: string, body: NewToken): Promise<{ token: string } | { error: string }> {
  const { data, error } = await api.POST("/api/w/{workspaceId}/external-tokens", { ...inW(workspaceId), body });
  return data ? { token: data.token } : { error: error.error };
}

/** Any member revokes; a second revoke is fine. */
export const revokeToken = (workspaceId: string, tokenId: string) => call(api.DELETE("/api/w/{workspaceId}/external-tokens/{tokenId}", { params: { path: { workspaceId, tokenId } } }));

/** A token's last 20 door requests, newest first: reader, outcome and time. */
export const tokenRequestsQuery = (workspaceId: string, tokenId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "external-tokens", tokenId, "requests"),
    queryFn: async () => (await call(api.GET("/api/w/{workspaceId}/external-tokens/{tokenId}/requests", { params: { path: { workspaceId, tokenId } } }))).requests,
  });

export const reviewFeedQuery = (workspaceId: string) =>
  queryOptions({ queryKey: inWorkspace(workspaceId, "review-feed"), queryFn: (): Promise<ReviewFeedState> => call(api.GET("/api/w/{workspaceId}/review-feed", inW(workspaceId))) });

/** Makes the calendar link, or replaces it; the URL comes back this once. */
export const makeReviewLink = async (workspaceId: string, settings: ReviewSettings): Promise<string> =>
  (await call(api.POST("/api/w/{workspaceId}/review-feed/link", { ...inW(workspaceId), body: settings }))).url;

export const saveReviewTime = (workspaceId: string, settings: ReviewSettings) => call(api.PUT("/api/w/{workspaceId}/review-feed", { ...inW(workspaceId), body: settings }));

export const stopReviewFeed = (workspaceId: string) => call(api.DELETE("/api/w/{workspaceId}/review-feed", inW(workspaceId)));

/** The Workspace's latest exports, newest first. Owners only. */
export const exportsQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "exports"),
    queryFn: async (): Promise<WorkspaceExport[]> => (await call(api.GET("/api/exports/{workspaceId}", inW(workspaceId)))).exports,
  });

export const startExport = async (workspaceId: string): Promise<WorkspaceExport> => (await call(api.POST("/api/exports/{workspaceId}", inW(workspaceId)))).export;

/** Deletes the Workspace (Owners, behind step-up). Returns the API's error code, or null when it worked. */
export async function deleteWorkspace(workspaceId: string): Promise<string | null> {
  const { error } = await api.DELETE("/api/w/{workspaceId}", inW(workspaceId));
  return error ? error.error : null;
}

/** Where a ready export downloads from, while the signed-in Owner's session lasts. */
export const exportHref = (workspaceId: string, id: string) => `/api/exports/${workspaceId}/${id}`;
