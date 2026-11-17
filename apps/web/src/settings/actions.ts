// SPDX-License-Identifier: AGPL-3.0-only
// The Settings calls that belong to no other folder: a member's review time and its calendar link, and
// the Workspace export and deletion.
import { queryOptions } from "@tanstack/react-query";
import { call, inWorkspace } from "../api/query";
import type { components } from "../api/schema";
import { api } from "../client";

export type ReviewSettings = components["schemas"]["ReviewFeedSettings"];
export type ReviewFeedState = components["schemas"]["ReviewFeedState"];
export type WorkspaceExport = components["schemas"]["WorkspaceExport"];

const inW = (workspaceId: string) => ({ params: { path: { workspaceId } } });

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
