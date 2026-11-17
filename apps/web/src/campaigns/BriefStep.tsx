// SPDX-License-Identifier: AGPL-3.0-only
// An SEO brief step: the page and search, Make brief, where the Brief stands, and once it is approved,
// the link to the draft the person made from it (passed in as children).
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Notice } from "../components/layout";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { useAction } from "../components/useAction";
import { StateChip } from "../items/StateChip";
import type { ItemState } from "../items/actions";
import { briefStep, makeBrief, sayBrief, type BriefStepView, type Step } from "./actions";

const POLL_MS = 5000;
/** A Brief's place in its Item's states, for the chip; running and failed have none and say so in words. */
const CHIP: Partial<Record<string, ItemState>> = { waiting: "needs_approval", approved: "applied", dismissed: "cancelled" };

export function BriefStep(p: { workspaceId: string; id: string; step: Step; edit: boolean; initial?: BriefStepView; children?: ReactNode }) {
  const { workspaceId, id, step } = p;
  const [view, setView] = useState(p.initial);
  const [page, setPage] = useState(p.initial?.setup?.page ?? "");
  const [query, setQuery] = useState(p.initial?.setup?.query ?? "");
  const [error, setError] = useState<string>();
  const making = useAction();
  const reload = async () => {
    const v = await briefStep(workspaceId, id, step.key);
    setView(v);
    if (v?.setup) {
      setPage(v.setup.page ?? "");
      setQuery(v.setup.query);
    }
  };
  useEffect(() => void (p.initial ? undefined : reload()), [workspaceId, id, step.key]);
  const brief = view?.brief ?? null;
  const running = brief?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(t);
  }, [running]);

  const waitsOn = step.dependsOnStepKey;
  const canStart = p.edit && view?.available && !running && brief?.state !== "approved";
  return (
    <section aria-label={`SEO brief for ${step.title ?? step.key}`} className="flex flex-col gap-3">
      {brief && CHIP[brief.state] && (
        <span className="self-start">
          <StateChip state={CHIP[brief.state]!} />
        </span>
      )}
      {view && !view.available && <p className="text-muted-foreground">Briefs need a self-hosted Direx server for now.</p>}
      {running && <Notice>Reading the page and writing the Brief. Nothing is published.</Notice>}
      {brief?.state === "waiting" && (
        <p>
          The Brief is waiting on{" "}
          <Link to="/w/$workspaceId" params={{ workspaceId }}>
            Home
          </Link>
          . Approving it publishes nothing.
        </p>
      )}
      {brief?.state === "dismissed" && <p>The Brief was dismissed. Change the page or search, or make another.</p>}
      {(brief?.state === "failed" || brief?.state === "no_brief") && <p>No Brief: {sayBrief(brief.reason ?? "")}</p>}
      {brief?.state === "approved" && (
        <>
          <p>The Brief is approved. Make the changes as a WordPress draft, then give its link here.</p>
          {p.children}
        </>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {canStart && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            await making.run(async () => {
              const failed = await makeBrief(workspaceId, id, step.key, { page: waitsOn ? null : page, query });
              setError(failed ? sayBrief(failed) : undefined);
              await reload();
              return null;
            });
          }}
        >
          {waitsOn ? (
            <p>Page: the link from step {waitsOn}.</p>
          ) : (
            <div className="flex min-w-64 flex-1 flex-col gap-1.5 text-sm font-medium">
              <Input label="Page" type="url" value={page} required maxLength={2048} placeholder="https://" onChange={(e) => setPage(e.target.value)} />
            </div>
          )}
          <div className="flex min-w-48 flex-1 flex-col gap-1.5 text-sm font-medium">
            <Input label="Search" value={query} required minLength={2} maxLength={200} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Button type="submit" size="sm" pending={making.pending}>
            Make brief
          </Button>
        </form>
      )}
    </section>
  );
}
