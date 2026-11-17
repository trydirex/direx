// SPDX-License-Identifier: AGPL-3.0-only
// An Owner's export of everything the Workspace holds: one ZIP, built in the background, downloadable
// for 24 hours (ADR 0030 rule 008).
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/query";
import { Notice, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { Button } from "@/components/Button";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { listTime } from "../items/actions";
import { exportHref, exportsQuery, startExport, type WorkspaceExport } from "./actions";

const size = (bytes: number) => (bytes < 1024 ** 2 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

function Latest(p: { workspaceId: string; e: WorkspaceExport | undefined }) {
  const { e } = p;
  if (!e) return <p className="text-sm text-muted-foreground">No export yet.</p>;
  if (e.state === "building") return <p className="text-sm">Building your export. This page updates when it is ready.</p>;
  if (e.state === "failed") return <Notice tone="error">The last export could not be built. Start it again.</Notice>;
  if (e.state === "expired") return <p className="text-sm text-muted-foreground">The last export&apos;s link has ended. Start a new one to download again.</p>;
  return (
    <p className="text-sm">
      <a href={exportHref(p.workspaceId, e.id)} className="font-medium underline underline-offset-4">
        Download the ZIP
      </a>{" "}
      <span className="text-muted-foreground">
        ({size(e.bytes ?? 0)}), until {listTime(new Date(e.expiresAt ?? ""))}
      </span>
    </p>
  );
}

/** On the deleted Workspaces page, `title` names the Workspace and `note` says when it can be purged. */
export function ExportData(p: { workspaceId: string; title?: string; note?: ReactNode }) {
  const { workspaceId } = p;
  const client = useQueryClient();
  // A build runs in the background, so the list checks again until it settles.
  const exports = useQuery({ ...exportsQuery(workspaceId), refetchInterval: (q) => (q.state.data?.[0]?.state === "building" ? 5000 : false) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const start = async () => {
    setBusy(true);
    setError(undefined);
    await startExport(workspaceId)
      .catch((e: unknown) => setError(e instanceof ApiError && e.code === "export_running" ? "An export is already being built." : "The export could not start. Try again."))
      .finally(() => setBusy(false));
    await client.invalidateQueries({ queryKey: exportsQuery(workspaceId).queryKey });
  };

  return (
    <Section title={p.title ?? "Export this Workspace"} description="One ZIP of everything it holds: a JSON Lines file per table and your uploaded files. Passwords, keys and tokens stay out. The link works for 24 hours.">
      {p.note && <p className="text-sm font-medium">{p.note}</p>}
      {/* ADR 0030 Q3: the export is the Owner's only proof once the Workspace is purged. */}
      <p className="text-sm">After a deleted Workspace is purged, Direx keeps no record of what it sent or of consent. Keep this export for at least 6 years.</p>
      <QueryBoundary query={exports} skeleton={<Skeleton className="h-6 w-64" />}>
        {(list) => (
          <div className="flex flex-wrap items-center gap-3">
            <Latest workspaceId={workspaceId} e={list[0]} />
            <Button variant="outline" pending={busy} disabled={list[0]?.state === "building"} onClick={() => void start()}>
              Start an export
            </Button>
          </div>
        )}
      </QueryBoundary>
      {error && <Notice tone="error">{error}</Notice>}
    </Section>
  );
}
