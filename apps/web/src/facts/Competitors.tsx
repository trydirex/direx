// SPDX-License-Identifier: AGPL-3.0-only
// Brand's Competitors section (Beta): the competitors the watch reads, the pages given for each one,
// and what Direx could read on each page when it was last checked. Anyone in the Workspace reads it;
// adding, editing, checking and removing need an Owner or Admin.
import { useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { inWorkspace } from "../api/query";
import { Confirm } from "../components/Confirm";
import { Field, Notice, Section } from "../components/layout";
import { QueryBoundary } from "../components/QueryBoundary";
import { useAction } from "../components/useAction";
import { Button } from "@/components/Button";
import { Input } from "@/components/Input";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import type { Role } from "../items/actions";
import { factsQuery } from "./actions";
import {
  addCompetitor,
  changesQuery,
  changeWords,
  checkCompetitor,
  checkWords,
  competitorsQuery,
  editCompetitor,
  labelWords,
  MAX_COMPETITORS,
  readWords,
  removeCompetitor,
  type Check,
  type Competitor,
  type CompetitorFields,
  type Result,
} from "./competitors-actions";

/** The last 4 weeks of Changes, behind a disclosure; nothing at all when there are none. */
function Changes(p: { workspaceId: string; competitor: Competitor }) {
  const { data } = useQuery(changesQuery(p.workspaceId, p.competitor.id));
  if (!data || data.length === 0) return null;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer">Changes in the last 4 weeks ({data.length})</summary>
      <ul aria-label={`Changes at ${p.competitor.name}`} className="mt-2 flex flex-col gap-2">
        {data.map((c) => (
          <li key={c.id}>
            <span className="text-muted-foreground">
              {new Date(c.at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}, {c.source}:
            </span>
            <ul className="list-disc pl-5">
              {changeWords(c).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {c.label !== null && <p className={c.label === "answer" ? "font-medium" : "text-muted-foreground"}>{labelWords(c, data)}</p>}
            {c.itemId && (
              <Link to="/w/$workspaceId/review/$itemId" params={{ workspaceId: p.workspaceId, itemId: c.itemId }}>
                Open the counter-move
              </Link>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

const WORDS: Record<string, string> = {
  name_missing: "Give the competitor a name.",
  name_length: "Give the competitor a name of up to 100 characters.",
  no_url: "Add at least one page: pricing, changelog or landing.",
  bad_url: "Each page needs a full web address starting with https://.",
  name_taken: "A competitor with that name is already on the list.",
  too_many: "Up to 5 competitors.",
};
const PAGES = [
  ["pricingUrl", "pricing", "Pricing page"],
  ["changelogUrl", "changelog", "Changelog"],
  ["landingUrl", "landing", "Landing page"],
] as const;
const BLANK: CompetitorFields = { name: "", pricingUrl: "", changelogUrl: "", landingUrl: "", comparisonUrl: "" };
const COMPARISON = "Our comparison page (optional)";

export function Competitors(p: { workspaceId: string; role: Role }) {
  const client = useQueryClient();
  const query = useQuery(competitorsQuery(p.workspaceId));
  // A competitor's Fact is filed under its name, which Facts keep in lower case.
  const known = useQuery(factsQuery(p.workspaceId)).data?.filter((f) => f.field === "competitor") ?? [];
  const action = useAction(WORDS);
  const [form, setForm] = useState<CompetitorFields>(BLANK);
  const [editing, setEditing] = useState<string | null>(null);
  // The latest check of each competitor, by id: shown, never stored.
  const [checks, setChecks] = useState<Record<string, Check[]>>({});
  const manage = p.role === "owner" || p.role === "admin";

  /** Runs a change, keeps its checks over the row's older ones source by source, and reloads the list. */
  const change = (write: () => Promise<Result>, say?: string, after?: () => void) =>
    void action.run(
      async () => {
        const r = await write();
        if (r.code) return r.code;
        const { id, checks: fresh } = r;
        if (id) setChecks((all) => ({ ...all, [id]: [...(all[id] ?? []).filter((c) => !fresh.some((f) => f.source === c.source)), ...fresh] }));
        after?.();
        await client.invalidateQueries({ queryKey: inWorkspace(p.workspaceId, "competitors") });
        return null;
      },
      say ? { say } : undefined,
    );
  const reset = () => {
    setForm(BLANK);
    setEditing(null);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (editing) change(() => editCompetitor(p.workspaceId, editing, form), "Saved.", reset);
    else change(() => addCompetitor(p.workspaceId, form), "Competitor added.", reset);
  };
  const remove = (c: Competitor) => change(async () => ({ code: await removeCompetitor(p.workspaceId, c.id), id: null, checks: [] }), "Removed.");
  const edit = (c: Competitor) => {
    setEditing(c.id);
    setForm({ name: c.name, pricingUrl: c.pricingUrl ?? "", changelogUrl: c.changelogUrl ?? "", landingUrl: c.landingUrl ?? "", comparisonUrl: c.comparisonUrl ?? "" });
  };

  return (
    <Section
      title="Competitors"
      description={
        <>
          <small className="mr-1 rounded border border-border px-1">Beta</small>
          Direx reads these pages once a week to spot what your competitors change. Give each one's pricing page, changelog and landing page.
        </>
      }
    >
      {action.error && <Notice tone="error">{action.error}</Notice>}
      <QueryBoundary query={query} skeleton={<Skeleton className="h-32 w-full" />}>
        {({ competitors: list, reads }) => (
          <div className="flex flex-col gap-4">
            {list.length === 0 && <p className="text-sm text-muted-foreground">No competitors yet.</p>}
            <ul className="flex flex-col gap-4">
              {list.map((c) => (
                <li key={c.id} aria-label={c.name} className="flex flex-col gap-2 border-t border-border pt-4 first:border-t-0 first:pt-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">{c.name}</h3>
                    {manage && (
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => edit(c)} aria-label={`Edit ${c.name}`}>
                          Edit
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => change(() => checkCompetitor(p.workspaceId, c.id))} pending={action.pending} aria-label={`Check ${c.name} again`}>
                          Check again
                        </Button>
                        <Confirm
                          title={`Remove ${c.name}?`}
                          body="Direx stops reading its pages."
                          confirm="Remove"
                          onConfirm={() => remove(c)}
                          trigger={
                            <Button size="sm" variant="outline" aria-label={`Remove ${c.name}`}>
                              Remove
                            </Button>
                          }
                        />
                      </div>
                    )}
                  </div>
                  <dl className="grid gap-1 text-sm sm:grid-cols-[10rem_1fr]">
                    {PAGES.map(([key, source, label]) => {
                      const url = c[key];
                      if (!url) return null;
                      const check = checks[c.id]?.find((x) => x.source === source);
                      // A read of a URL since edited says nothing about this one.
                      const read = reads.find((r) => r.competitorId === c.id && r.source === source && r.url === url);
                      return (
                        <div key={key} className="contents">
                          <dt className="text-muted-foreground">{label}</dt>
                          <dd className="break-all">
                            {url}
                            {check && <span className="block text-muted-foreground">{checkWords(check)}</span>}
                            {read && <span className="block text-muted-foreground">{readWords(read)}</span>}
                          </dd>
                        </div>
                      );
                    })}
                    {c.comparisonUrl && (
                      <div className="contents">
                        <dt className="text-muted-foreground">Our comparison page</dt>
                        <dd className="break-all">{c.comparisonUrl}</dd>
                      </div>
                    )}
                  </dl>
                  {known
                    .filter((f) => f.subject === c.name.trim().toLowerCase())
                    .map((f) => (
                      <p key={f.id} className="text-sm">
                        <span className="text-muted-foreground">What Direx knows: </span>
                        {f.value}
                      </p>
                    ))}
                  {!c.changelogUrl && <p className="text-sm text-muted-foreground">No changelog: most answerable changes come from changelogs.</p>}
                  <Changes workspaceId={p.workspaceId} competitor={c} />
                </li>
              ))}
            </ul>
            {manage && (
              <form onSubmit={submit} aria-label={editing ? "Edit competitor" : "Add a competitor"} className="flex flex-col gap-2 border-t border-border pt-4">
                <Field label="Name">
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={100} />
                </Field>
                {PAGES.map(([key, , label]) => (
                  <Field key={key} label={label}>
                    <Input type="url" value={form[key] ?? ""} onChange={(e) => setForm({ ...form, [key]: e.target.value })} maxLength={2000} placeholder="https://" />
                  </Field>
                ))}
                <Field label={COMPARISON}>
                  <Input type="url" value={form.comparisonUrl ?? ""} onChange={(e) => setForm({ ...form, comparisonUrl: e.target.value })} maxLength={2000} placeholder="https://" />
                </Field>
                {!editing && list.length >= MAX_COMPETITORS && <p className="text-sm text-muted-foreground">{WORDS.too_many}</p>}
                <div className="flex gap-2">
                  <Button type="submit" size="sm" pending={action.pending} disabled={!form.name.trim() || (!editing && list.length >= MAX_COMPETITORS)}>
                    {editing ? "Save" : "Add competitor"}
                  </Button>
                  {editing && (
                    <Button type="button" size="sm" variant="outline" onClick={reset}>
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            )}
          </div>
        )}
      </QueryBoundary>
    </Section>
  );
}
