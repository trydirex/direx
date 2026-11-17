// SPDX-License-Identifier: AGPL-3.0-only
// Who is sending, and the CRM webhook: set once, so they live in Settings rather than beside the People table.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inWorkspace } from "../api/query";
import { Field, Notice, Page, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Input, Select } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { toast } from "@/components/toast";
import type { Role } from "../items/actions";
import { outreachQuery, saveIdentity, say } from "../outreach/actions";
import { COUNTRIES } from "../outreach/countries";
import { HoldHook } from "../outreach/HoldHook";

export function Sending(p: { workspaceId: string; role: Role }) {
  const { workspaceId, role } = p;
  // The API keeps the sender and the CRM webhook to workspace.settings: Owners and Admins.
  const settles = role === "owner" || role === "admin";
  const client = useQueryClient();
  const outreach = useQuery(outreachQuery(workspaceId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "");
    setBusy(true);
    const code = await saveIdentity(workspaceId, { senderName: text("senderName"), postalAddress: text("postalAddress"), senderCountry: text("senderCountry") || null }).finally(() => setBusy(false));
    setError(code ? say(code) : undefined);
    if (!code) toast.add({ title: "Saved." });
    await client.invalidateQueries({ queryKey: inWorkspace(workspaceId) });
  };

  return (
    <Page title="Who is sending" description="Every email carries this name and postal address, and an unsubscribe link.">
      <Section title="Sender">
        <QueryBoundary query={outreach} skeleton={<Skeleton className="h-24 w-full" />}>
          {(data) =>
            settles ? (
              <form key={`${data.senderName}|${data.postalAddress}|${data.senderCountry}`} className="flex flex-wrap items-end gap-3" onSubmit={(e) => void save(e)}>
                <Field label="Sender name">
                  <Input name="senderName" defaultValue={data.senderName ?? ""} required />
                </Field>
                <Field label="Postal address">
                  <Input name="postalAddress" autoComplete="street-address" defaultValue={data.postalAddress ?? ""} required />
                </Field>
                <Field label="Your country">
                  <Select name="senderCountry" defaultValue={data.senderCountry ?? ""} className="min-w-56">
                    <option value="">Not set</option>
                    {COUNTRIES.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button type="submit" variant="outline" pending={busy}>
                  Save
                </Button>
              </form>
            ) : data.senderName && data.postalAddress ? (
              <p>
                <span className="font-medium">{data.senderName}</span> <span className="text-muted-foreground">{data.postalAddress}</span>
              </p>
            ) : (
              <p className="text-muted-foreground">Not added yet. Emails can&apos;t go out until an Owner or Admin adds it.</p>
            )
          }
        </QueryBoundary>
        {error && <Notice tone="error">{error}</Notice>}
      </Section>
      {settles && <HoldHook workspaceId={workspaceId} />}
    </Page>
  );
}
