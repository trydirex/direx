// SPDX-License-Identifier: AGPL-3.0-only
// The Workspaces a person deleted as an Owner, each with its export until the purge (ADR 0030 rule 008).
// Nothing else of a deleted Workspace opens, so this page sits outside any Workspace, and brings
// Astryx's stylesheet and provider itself.
import "@/astryx.css";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { AstryxProvider } from "@/components/astryx";
import { EmptyState, Page } from "@/components/layout";
import { QueryBoundary } from "@/components/QueryBoundary";
import { deletedWorkspacesQuery, workspacesQuery } from "@/shell/session";
import { ExportData } from "./ExportData";

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });

export function DeletedWorkspaces() {
  const deleted = useQuery(deletedWorkspacesQuery);
  const live = useQuery(workspacesQuery);
  const back = live.data?.length === 0 ? (
    <Link to="/new-org" className="text-sm underline">
      Create an Organization
    </Link>
  ) : (
    <Link to="/" className="text-sm underline">
      Back to your Workspace
    </Link>
  );

  return (
    <AstryxProvider>
      <div className="mx-auto w-full max-w-form p-4 md:py-10">
        <Page title="Deleted Workspaces" description="Workspaces you deleted as an Owner. You can export each one's data until it is purged. Nothing else of them opens." actions={back}>
          <QueryBoundary query={deleted} skeleton={<Skeleton className="h-40 w-full" />}>
            {(list) =>
              list.length === 0 ? (
                <EmptyState title="No deleted Workspaces">A Workspace you delete as an Owner shows here until it is purged, so you can export its data.</EmptyState>
              ) : (
                list.map((w) => (
                  <ExportData key={w.id} workspaceId={w.id} title={`${w.name} (${w.organization.name})`} note={`Deleted on ${day(w.deletedAt)}. It can be purged from ${day(w.purgeFrom)}, so download its export before then.`} />
                ))
              )
            }
          </QueryBoundary>
        </Page>
      </div>
    </AstryxProvider>
  );
}
