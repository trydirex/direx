// SPDX-License-Identifier: AGPL-3.0-only
// Tracking domains in Settings (ADR 0035): an Owner or Admin adds a hostname of their own, copies the
// two DNS records shown, and presses Check until the domain is ready. Stop ends new links on a domain;
// Remove works only while nothing uses it.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { inWorkspace } from "../api/query";
import { Field, Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { StatusChip, type Tone } from "../components/StatusChip";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { toast } from "@/components/toast";
import type { Role } from "../items/actions";
import { addTrackingDomain, checkTrackingDomain, removeTrackingDomain, stopTrackingDomain, trackingDomainsQuery, type CheckResult, type TrackingDomain } from "./actions";

const STATE: Record<TrackingDomain["state"], [Tone, string]> = {
  pending: ["attention", "Waiting for DNS"],
  dns_ok: ["attention", "DNS found, certificate not ready"],
  verified: ["good", "Ready"],
  stopped: ["off", "Stopped: no new links"],
};
const CHECKED: Record<CheckResult, string> = {
  verified: "Ready. Campaigns can use this domain for tracked links.",
  dns_ok: "DNS found. The certificate isn't ready yet; check again in a minute.",
  dns_mismatch: "The records don't match yet. DNS changes can take up to an hour.",
  stopped: "This domain is stopped.",
  not_configured: "This server isn't set up for tracked links yet.",
};
const SAYS: Record<string, string> = {
  invalid_hostname: "Enter a hostname such as links.yourcompany.com.",
  taken: "This hostname is already in use on this server.",
  not_configured: "This server isn't set up for tracked links yet. Whoever runs it adds them with install.sh --tracking.",
  in_use: "Links or a Campaign use this domain, so it can't be removed. Stop it instead.",
};

export function TrackingDomains(p: { workspaceId: string; role: Role }) {
  const settles = p.role === "owner" || p.role === "admin";
  return (
    <Page title="Tracking domains" description="Tracked links use a hostname of your own, so they look like your links and only your sending affects them.">
      {settles ? <Domains workspaceId={p.workspaceId} /> : <p className="text-muted-foreground">Only Owners and Admins manage tracking domains.</p>}
    </Page>
  );
}

function Domains({ workspaceId }: { workspaceId: string }) {
  const client = useQueryClient();
  const domains = useQuery(trackingDomainsQuery(workspaceId));
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const refresh = () => client.invalidateQueries({ queryKey: inWorkspace(workspaceId, "tracking-domains") });
  const run = async (key: string, work: () => Promise<string | null>) => {
    setBusy(key);
    setError(undefined);
    const code = await work().finally(() => setBusy(undefined));
    if (code) setError(SAYS[code] ?? code);
    await refresh();
  };
  const add = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const hostname = String(new FormData(form).get("hostname") ?? "");
    void run("add", async () => {
      const r = await addTrackingDomain(workspaceId, hostname);
      if ("error" in r) return r.error;
      form.reset();
      return null;
    });
  };
  const check = (d: TrackingDomain) =>
    run(`check:${d.id}`, async () => {
      toast.add({ title: CHECKED[await checkTrackingDomain(workspaceId, d.id)] });
      return null;
    });

  return (
    <>
      <Section title="Add a domain">
        <form className="flex flex-wrap items-end gap-3" onSubmit={add}>
          <Field label="Hostname" hint="A subdomain you control, used only for tracked links.">
            <Input name="hostname" placeholder="links.yourcompany.com" required />
          </Field>
          <Button type="submit" variant="outline" pending={busy === "add"}>
            Add
          </Button>
        </form>
        {error && <Notice tone="error">{error}</Notice>}
      </Section>
      <Section title="Your domains">
        <QueryBoundary query={domains} skeleton={<Skeleton className="h-24 w-full" />}>
          {(list) =>
            list.length === 0 ? (
              <p className="text-muted-foreground">None yet.</p>
            ) : (
              <ul className="flex flex-col gap-4">
                {list.map((d) => (
                  <li key={d.id} className="flex flex-col gap-2 rounded-card border border-border p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{d.hostname}</span>
                      <StatusChip tone={STATE[d.state][0]}>{STATE[d.state][1]}</StatusChip>
                    </div>
                    {d.state !== "stopped" && d.cnameTarget && (
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-muted-foreground">CNAME</dt>
                        <dd className="min-w-0 break-all">
                          <code>{d.hostname}</code> to <code>{d.cnameTarget}</code>
                        </dd>
                        <dt className="text-muted-foreground">TXT</dt>
                        <dd className="min-w-0 break-all">
                          <code>{d.txtName}</code> with the value <code>{d.txtValue}</code>
                        </dd>
                      </dl>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {d.state !== "stopped" && (
                        <Button variant="outline" size="sm" pending={busy === `check:${d.id}`} onClick={() => void check(d)}>
                          Check
                        </Button>
                      )}
                      {d.state !== "stopped" && (
                        <Button variant="ghost" size="sm" pending={busy === `stop:${d.id}`} onClick={() => void run(`stop:${d.id}`, async () => (await stopTrackingDomain(workspaceId, d.id), null))}>
                          Stop
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" pending={busy === `remove:${d.id}`} onClick={() => void run(`remove:${d.id}`, () => removeTrackingDomain(workspaceId, d.id))}>
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </QueryBoundary>
      </Section>
    </>
  );
}
