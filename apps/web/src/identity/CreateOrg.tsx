// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { QueryBoundary } from "@/components/QueryBoundary";
import { Field, Notice, Page } from "../components/layout";
import { NativeButton, NativeInput } from "@/components/native";
import { createOrg, serverStatusQuery } from "./actions";
import { Narrow } from "./SignIn";

/**
 * `/new-org`: the form for whoever may create an Organization (on self-host, a Server admin), and
 * otherwise why not: the server has no Server admin yet, or only its Server admins create them (ADR 0024).
 */
export function NewOrg({ onCreated }: { onCreated: (workspaceId: string, website: string) => void }) {
  const status = useQuery(serverStatusQuery);
  return (
    <QueryBoundary query={status}>
      {(s) =>
        s.canCreateOrganization ? (
          <CreateOrg onCreated={onCreated} />
        ) : (
          <Narrow>
            {s.claimed ? (
              <Page title="Ask for an invite">
                <p>Only whoever runs this server can create Organizations. Ask them to invite you to a Workspace.</p>
              </Page>
            ) : (
              <Page title="This server has no Server admin yet">
                <p>
                  Whoever runs it needs to run <code>bun run server-admin --invite</code>. You can still accept an invite to a Workspace.
                </p>
              </Page>
            )}
          </Narrow>
        )
      }
    </QueryBoundary>
  );
}

/** "acmerota.com" becomes "https://acmerota.com"; empty stays empty. */
export const siteAddress = (typed: string) => {
  const t = typed.trim();
  return t && (/^https?:\/\//i.test(t) ? t : `https://${t}`);
};

/** The business names the Workspace and, unless an agency gives its own, the Organization. The website goes on to setup's read. */
export function CreateOrg({ onCreated }: { onCreated: (workspaceId: string, website: string) => void }) {
  const [business, setBusiness] = useState("");
  const [website, setWebsite] = useState("");
  const [orgName, setOrgName] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  return (
    <Narrow>
      <Page title="Set up your business" description="Direx plans and drafts marketing for one business at a time.">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setPending(true);
            void createOrg(orgName.trim() || business, business)
              .then((id) => (id ? onCreated(id, siteAddress(website)) : setError("We couldn't create the Organization. Check the names and try again.")))
              .finally(() => setPending(false));
          }}
        >
          <Field label="Business name">
            <NativeInput required maxLength={100} autoComplete="organization" value={business} onChange={(e) => setBusiness(e.target.value)} />
          </Field>
          <Field label="Website" hint="Direx reads it during setup. You can leave it empty.">
            <NativeInput inputMode="url" maxLength={2000} autoComplete="url" spellCheck={false} placeholder="example.com" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </Field>
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">Setting up for clients?</summary>
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-muted-foreground">
                Your Organization holds a Workspace for each business you market. Name the business above after your first client, and give the Organization your agency's name.
              </p>
              <Field label="Organization name">
                <NativeInput maxLength={100} autoComplete="off" placeholder="Same as the business name" value={orgName} onChange={(e) => setOrgName(e.target.value)} />
              </Field>
            </div>
          </details>
          <NativeButton type="submit" pending={pending}>
            Create and set up
          </NativeButton>
        </form>
        {error && <Notice tone="error">{error}</Notice>}
      </Page>
    </Narrow>
  );
}
