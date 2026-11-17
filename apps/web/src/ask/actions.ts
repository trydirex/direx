// SPDX-License-Identifier: AGPL-3.0-only
// The Ask calls the panel makes. While a reply is being worked on, the conversation is asked for
// again every two seconds, so the steps and then the reply appear without a reload.
import { queryOptions } from "@tanstack/react-query";
import type { components } from "../api/schema";
import { ApiError, call, inWorkspace } from "../api/query";
import { api } from "../client";

export type AskMessage = components["schemas"]["AskMessage"];
/** The work areas a person can name with @. */
export const AREAS = ["social", "outreach", "sales", "support", "inbox", "seo"] as const;
export type Area = (typeof AREAS)[number];

const POLL_MS = 2000;

export const askQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: inWorkspace(workspaceId, "ask"),
    // The conversation, and whether Ask runs at all.
    queryFn: async () => call(api.GET("/api/w/{workspaceId}/ask/messages", { params: { path: { workspaceId } } })),
    refetchInterval: (q) => (q.state.data?.messages.some((m) => m.status === "working") ? POLL_MS : false),
  });

/** Sends a message; null when it went, otherwise the API's error code. */
/** The screen the person has open, as the panel says it; the API writes the words the model reads. */
export type Looking = { screen: "calendar" | "review" | "campaigns"; campaignId?: string };

export async function ask(workspaceId: string, m: { text: string; itemId?: string; agent?: Area; looking?: Looking }): Promise<string | null> {
  try {
    await call(api.POST("/api/w/{workspaceId}/ask/messages", { params: { path: { workspaceId } }, body: m }));
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}

/** Undoes what approving an Ask card did; null when it went, otherwise the API's reason. */
export async function undo(workspaceId: string, id: string): Promise<string | null> {
  try {
    await call(api.POST("/api/w/{workspaceId}/items/{id}/undo", { params: { path: { workspaceId, id } } }));
    return null;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
}
