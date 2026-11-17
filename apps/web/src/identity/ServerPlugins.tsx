// SPDX-License-Identifier: AGPL-3.0-only
// The Plugins section of the Server page (ADR 0026 rule 001): the third-party plugins installed on this
// server and what each asks for, then the upload that reviews a plugin file before it is installed or
// upgraded. Every change goes through the page's `run`, so a stale sign-in asks for a fresh one.
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Button } from "@/components/Button";
import { Confirm } from "@/components/Confirm";
import { Input } from "@/components/Input";
import { Section } from "@/components/layout";
import { QueryBoundary } from "@/components/QueryBoundary";
import { StatusChip } from "@/components/StatusChip";
import { confirmPlugin, removePlugin, reviewPlugin, serverPluginsQuery, type PluginReview, type PluginSummary } from "./actions";
import { MESSAGES } from "./messages";

export type Run = (change: Promise<string | null>) => Promise<string | null | undefined | void>;

export const HANDED = "A plugin can send anything it is handed, such as a key a Workspace connects, to the hosts it lists.";
const KIND: Record<PluginSummary["capabilities"][number]["kind"], string> = { effect: "Action", query: "Lookup", trigger: "Trigger" };
const AUTH: Record<string, string> = { api_key: "API key" };
const short = (sha256: string) => sha256.slice(0, 12);

function Part(p: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="font-medium">{p.title}</p>
      {p.children.length ? <ul className="flex flex-col gap-1">{p.children}</ul> : <p className="text-muted-foreground">{p.empty}</p>}
    </div>
  );
}

/** What a plugin can do, what it connects with and every host it may reach, as a person reads it before saying yes. */
export function PluginAsks({ plugin }: { plugin: PluginSummary }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      <Part title="What it can do" empty="Nothing.">
        {plugin.capabilities.map((c) => (
          <li key={`${c.kind} ${c.name}`} className="flex flex-wrap items-center gap-2">
            <code className="break-all">{c.name}</code>
            <span className="text-muted-foreground">{KIND[c.kind]}</span>
            {c.reachesPerson && <StatusChip tone="attention">Reaches a person</StatusChip>}
          </li>
        ))}
      </Part>
      <Part title="What it connects with" empty="Nothing.">
        {plugin.connections.map((c) => (
          <li key={c.key}>
            <code className="break-all">{c.key}</code>, {AUTH[c.auth] ?? c.auth}
          </li>
        ))}
      </Part>
      <Part title="Hosts it may reach, on port 443 only" empty="None. It can't reach the internet.">
        {plugin.egress.map((h) => (
          <li key={h}>
            <code className="break-all">{h}</code>
          </li>
        ))}
      </Part>
    </div>
  );
}

export function ServerPlugins({ run }: { run: Run }) {
  const plugins = useQuery(serverPluginsQuery);
  return (
    <Section
      title="Plugins"
      description="Third-party plugins add things Direx can do. Once installed, a plugin is offered to every Workspace on this server, and each Workspace's Owner decides whether to turn it on."
    >
      <p className="text-sm">{HANDED} Install only plugins from people you trust.</p>
      <QueryBoundary query={plugins} messages={MESSAGES} skeleton={<Skeleton className="h-24 w-full" />}>
        {(list) =>
          list.length === 0 ? (
            <p className="text-sm text-muted-foreground">No plugin is installed.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {list.map((p) => (
                <Installed key={p.pluginId} plugin={p} run={run} />
              ))}
            </ul>
          )
        }
      </QueryBoundary>
      <Upload run={run} />
    </Section>
  );
}

function Installed({ plugin, run }: { plugin: PluginSummary & { entrySha256: string }; run: Run }) {
  return (
    <li aria-label={plugin.name} className="flex flex-col gap-3 rounded-card border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">
          {plugin.name} {plugin.version}
        </span>
        <Confirm
          title={`Remove ${plugin.name}?`}
          body="It stops in every Workspace that has it on, right away."
          confirm="Remove"
          onConfirm={() => run(removePlugin(plugin.pluginId)).then(() => undefined)}
          trigger={
            <Button size="sm" variant="outline" aria-label={`Remove ${plugin.name}`}>
              Remove
            </Button>
          }
        />
      </div>
      <Ids plugin={plugin} sha256={plugin.entrySha256} />
      <PluginAsks plugin={plugin} />
    </li>
  );
}

function Ids({ plugin, sha256 }: { plugin: PluginSummary; sha256: string }) {
  return (
    <p className="flex flex-wrap gap-x-4 text-sm text-muted-foreground">
      <span className="break-all">Id {plugin.pluginId}</span>
      <span title={sha256}>File {short(sha256)}</span>
    </p>
  );
}

function Upload({ run }: { run: Run }) {
  const [review, setReview] = useState<PluginReview>();
  const [refused, setRefused] = useState<string[]>();
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState(false);
  // A new key clears the file field after a review ends.
  const [field, setField] = useState(0);

  async function read(file: File) {
    setReview(undefined);
    setRefused(undefined);
    setReading(true);
    const r = await reviewPlugin(file).finally(() => setReading(false));
    if ("stageId" in r) setReview(r);
    else if (r.error === "refused") setRefused(r.reasons);
    else await run(Promise.resolve(r.error));
  }
  function done() {
    setReview(undefined);
    setField((n) => n + 1);
  }
  async function confirm(r: PluginReview) {
    setPending(true);
    const code = await run(confirmPlugin(r)).finally(() => setPending(false));
    if (code === null) done();
  }

  return (
    <div className="flex flex-col gap-4">
      <Input
        key={field}
        type="file"
        label="Upload a plugin"
        hint="One bundled plugin.js file, up to 10 MB. Direx opens it in a sandbox with no network and shows what it asks for. Nothing is installed until you say so."
        accept=".js,.mjs,text/javascript"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void read(file);
        }}
      />
      {reading && (
        <p role="status" className="text-sm text-muted-foreground">
          Reading the file…
        </p>
      )}
      {refused && (
        <div role="alert" className="rounded-card bg-destructive-tint px-4 py-3 text-destructive">
          <p>Direx won't install this file:</p>
          <ul className="list-disc pl-5">
            {refused.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}
      {review && (
        <section aria-label="Review the plugin" className="flex flex-col gap-3 rounded-card border border-border p-4">
          <h3 className="font-medium">{review.mode === "install" ? `Install ${review.plugin.name} ${review.plugin.version}?` : `Upgrade ${review.plugin.name} to ${review.plugin.version}?`}</h3>
          <Ids plugin={review.plugin} sha256={review.entrySha256} />
          <PluginAsks plugin={review.plugin} />
          {review.mode === "upgrade" && (
            <div className="flex flex-col gap-3 text-sm">
              <Part title="New in this version" empty="Nothing new.">
                {review.added.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </Part>
              <Part title="Gone in this version" empty="Nothing gone.">
                {review.removed.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </Part>
              <p>
                {review.permissionsChanged
                  ? "What it asks for has changed, so every Workspace that has it on must turn it on again. Until then it stops there."
                  : "What it asks for is the same, so it stays on wherever it is on."}
              </p>
            </div>
          )}
          <p className="text-sm">{HANDED}</p>
          <div className="flex flex-wrap gap-2">
            <Button pending={pending} onClick={() => void confirm(review)}>
              {review.mode === "install" ? "Install" : "Upgrade"}
            </Button>
            <Button variant="outline" onClick={done}>
              Cancel
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
