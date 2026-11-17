// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { messageFor, messageForCode } from "@/api/messages";
import { ApiError } from "@/api/query";
import { NativeButton } from "@/components/native";

/**
 * A screen's loading, error and data states, the same everywhere: a skeleton the size of the content
 * on first load, an error panel with Retry when the first load fails, and the loaded data with a quiet
 * notice when a later refresh fails. A read that can't exist (a 404, or a 400 for an id in the URL that
 * isn't one) says so with no Retry, which can't help; the screen's own links lead back.
 */
export function QueryBoundary<T>(p: { query: UseQueryResult<T>; children: (data: T) => ReactNode; skeleton?: ReactNode; messages?: Record<string, string> }) {
  const { query } = p;
  if (query.data === undefined) {
    if (!query.isError) {
      return (
        <div role="status">
          <span className="sr-only">Loading</span>
          {p.skeleton ?? <Placeholder className="h-24 w-full" />}
        </div>
      );
    }
    const e = query.error;
    // A 400 code the screen names is a real refusal; any other 400 on a read is a malformed URL.
    if (e instanceof ApiError && (e.status === 404 || (e.status === 400 && !Object.hasOwn(p.messages ?? {}, e.code)))) {
      return (
        <p role="alert" className="rounded-card border border-border p-4">
          {p.messages?.[e.code] ?? messageForCode("not_found", p.messages)}
        </p>
      );
    }
    return (
      <div role="alert" className="flex flex-col items-start gap-3 rounded-card border border-border p-4">
        <p>{messageFor(e, p.messages)}</p>
        <NativeButton variant="outline" size="sm" onClick={() => void query.refetch()}>
          Retry
        </NativeButton>
      </div>
    );
  }
  return (
    <>
      {query.isError && (
        <p role="status" className="text-sm text-muted-foreground">
          Couldn't refresh: {messageFor(query.error, p.messages)} Showing what was loaded before.
        </p>
      )}
      {p.children(query.data)}
    </>
  );
}

/** A loading shape in our tokens. Used where Astryx's stylesheet may not have arrived yet (before the
    shell, and as QueryBoundary's default); screens pass Astryx's Skeleton for their own. */
export function Placeholder({ className }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-sm bg-muted ${className ?? ""}`} />;
}
