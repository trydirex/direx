// SPDX-License-Identifier: AGPL-3.0-only
import { queryOptions } from "@tanstack/react-query";
import type { components } from "@/api/schema";
import { ApiError, call, ME } from "@/api/query";
import { api } from "@/client";

export type Me = components["schemas"]["Me"]["user"];
export type MyWorkspace = components["schemas"]["MyWorkspace"];

/** The signed-in person, or null when nobody is. */
export const meQuery = queryOptions({
  queryKey: ME,
  queryFn: async (): Promise<Me | null> => {
    try {
      return (await call(api.GET("/api/me"))).user;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  },
});

export const workspacesQuery = queryOptions({
  queryKey: [...ME, "workspaces"],
  queryFn: async () => (await call(api.GET("/api/me/workspaces"))).workspaces,
});

export type DeletedWorkspace = components["schemas"]["DeletedWorkspace"];
/** Deleted Workspaces the person is an Owner of, until their purge starts: only their export still opens (ADR 0030 rule 008). */
export const deletedWorkspacesQuery = queryOptions({
  queryKey: [...ME, "deleted-workspaces"],
  queryFn: async () => (await call(api.GET("/api/me/deleted-workspaces"))).workspaces,
});

/**
 * A page the browser restores on Back still shows what it showed when left, even after sign-out.
 * Load it again, so it asks the server who is signed in and a signed-out person gets the sign-in page.
 * A reload, not a reset of the cache: a reset races the 401 handler's own clear.
 */
export function reloadOnRestore(reload: () => void = () => location.reload()): void {
  addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) reload();
  });
}
