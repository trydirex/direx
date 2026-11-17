// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Notice, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { holdHookQuery, makeHoldHook, say, type HoldHook as Hook, type HoldHookSecret } from "./actions";

const EXAMPLE = `{ "holds": [{ "email": "jane@acme.com", "reason": "Deal: renewal", "days": 30 }] }`;

/** Owners and Admins connect another CRM: it can say "we're talking to them", and can never undo a hold. */
export function HoldHook(p: { workspaceId: string; initial?: { hook: Hook; shown?: HoldHookSecret } }) {
  const client = useQueryClient();
  const hook = useQuery({ ...holdHookQuery(p.workspaceId), initialData: p.initial?.hook });
  const [shown, setShown] = useState(p.initial?.shown);
  const [error, setError] = useState<string>();

  const make = async (current: Hook) => {
    const r = await makeHoldHook(p.workspaceId, current?.id);
    if (typeof r === "string") return setError(say(r));
    setError(undefined);
    setShown(r);
    client.setQueryData(holdHookQuery(p.workspaceId).queryKey, (): Hook => ({ id: r.id, path: r.path, createdAt: current?.createdAt ?? new Date().toISOString() }));
  };
  const url = (path: string) => (typeof location === "undefined" ? path : `${location.origin}${path}`);

  return (
    // Campaign links here (Settings, Who is sending) when a CRM isn't connected.
    <div id="hold-hook" className="scroll-mt-8">
      <Section title="Deals in another CRM" description="Send Direx the people you're already talking to, from your CRM through Zapier or Make. They get no cold email. This can only add holds, never end one.">
        {error && <Notice tone="error">{error}</Notice>}
        <QueryBoundary query={hook} skeleton={<Skeleton className="h-11 w-full" />}>
          {(current) => (
            <div className="flex flex-wrap items-center gap-3">
              {current && (
                <p className="min-w-0 break-all">
                  Webhook: <code>{url(current.path)}</code>
                </p>
              )}
              <Button variant="outline" size="sm" onClick={() => void make(current)}>
                {current ? "New secret" : "Make a webhook"}
              </Button>
            </div>
          )}
        </QueryBoundary>
        {shown && (
          <div role="status" className="flex flex-col gap-1 rounded-card bg-muted px-4 py-3">
            <p className="break-all">
              Secret: <code>{shown.secret}</code>
            </p>
            <p>Copy it now. Direx won't show it again.</p>
          </div>
        )}
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">Setup for Zapier or Make</summary>
          POST JSON like <code className="break-all">{EXAMPLE}</code>, up to 100 people at once. Sign the exact body with HMAC-SHA256 using the secret and send the hex in an <code>x-signature</code>{" "}
          header. Sending someone again keeps them held longer, never shorter; <code>days</code> is 1 to 90.
        </details>
      </Section>
    </div>
  );
}
