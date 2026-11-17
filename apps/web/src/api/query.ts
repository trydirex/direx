// SPDX-License-Identifier: AGPL-3.0-only
// The one way screens reach the API: TanStack Query over the typed openapi-fetch client.
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

/** An API refusal: the HTTP status and the API's error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** The data of an openapi-fetch call, or an ApiError carrying the API's error code. */
export async function call<T>(request: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await request;
  if (error !== undefined || !response.ok) throw new ApiError(response.status, (error as { error?: string } | undefined)?.error ?? "failed");
  return data as T;
}

/** The signed-in person; null once the API says the session has ended. */
export const ME = ["me"] as const;

/** Every Workspace query key starts with its id, so one Workspace's data never shows in another. */
export const inWorkspace = (workspaceId: string, ...rest: unknown[]) => ["w", workspaceId, ...rest] as const;

export function makeQueryClient() {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (e, query) => {
        signedOutOn401(client, e);
        recheckWorkspacesOn404(client, e, query.queryKey);
      },
    }),
    mutationCache: new MutationCache({ onError: (e) => signedOutOn401(client, e) }),
    defaultOptions: {
      // A refusal won't change on retry; a dropped connection or a 5xx may.
      queries: { staleTime: 30_000, retry: (n, e) => n < 2 && !(e instanceof ApiError && e.status < 500) },
    },
  });
  return client;
}

/** A 401 anywhere means the session ended: drop everything cached and show sign-in. */
function signedOutOn401(client: QueryClient, e: unknown) {
  if (!(e instanceof ApiError && e.status === 401)) return;
  client.clear();
  client.setQueryData(ME, null);
}

/**
 * A 404 inside a Workspace may mean the person was removed from it while signed in. Read their
 * Workspaces again; the Workspace route then drops that Workspace's data and says they lost access.
 */
function recheckWorkspacesOn404(client: QueryClient, e: unknown, key: readonly unknown[]) {
  if (e instanceof ApiError && e.status === 404 && key[0] === "w") void client.invalidateQueries({ queryKey: [...ME, "workspaces"], exact: true });
}

export const queryClient = makeQueryClient();
