// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/Button";
import { pathOf } from "./actions";

type Gap = { label: string; problem: string; where: string; quote: string | null; fix: string; newText: string[]; live: string };
/** What a Brief Item holds, as the seo module wrote it. */
export type BriefContent = {
  page: string;
  query: string;
  why: string;
  others: string[];
  brief: { gaps: Gap[]; cantTell: string | null; steered: string[] };
  markdown: string;
  readAt: string;
  /** Set when a Campaign step asked for the Brief. */
  step?: { campaignId: string; stepKey: string; campaign: string; step: string } | null;
};

export const HELPED = "We'll compare Search Console clicks and impressions for this search on this page, 28 days before and after your change.";

/** One Brief: why it was picked, each gap with the page's own words, and a copy for wherever the change gets made. */
export function BriefView({ c, workspaceId, copy = (text) => navigator.clipboard.writeText(text) }: { c: BriefContent; workspaceId?: string; copy?: (text: string) => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  return (
    <section aria-label="Brief" className="flex flex-col gap-4">
      {c.step && (
        <p className="text-sm text-muted-foreground">
          From <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId: workspaceId ?? "", campaignId: c.step.campaignId }}>{c.step.campaign}</Link>, step {c.step.step}.
        </p>
      )}
      <p>
        <a href={c.page}>{pathOf(c.page)}</a>
        {`, for the search "${c.query}". ${c.why}`}
      </p>
      {/* The cells stay bare (the tests pin them), so each row styles its cells with the child variant. */}
      <div className="overflow-x-auto rounded-card border border-border">
      <table className="w-full text-left text-sm">
        <thead className="bg-muted">
          <tr className="*:px-3 *:py-2 *:font-medium">
            <th>Gap</th>
            <th>The page says</th>
            <th>Fix</th>
            <th>How to check it's live</th>
          </tr>
        </thead>
        <tbody>
          {c.brief.gaps.map((g, i) => (
            <tr key={i} className="border-t border-border align-top *:px-3 *:py-2">
              <td>{`${g.label}: ${g.problem}`}</td>
              <td>{g.quote === null ? "Nothing on the page" : `${g.where}: "${g.quote}"`}</td>
              <td>{g.fix}</td>
              <td>{g.live}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <p>{`Did it help? ${HELPED}`}</p>
      {c.brief.cantTell && <p className="text-muted-foreground">{`Can't tell without more Search Console data: ${c.brief.cantTell}`}</p>}
      {c.brief.steered.length > 0 && <p>{`Ignored hidden instructions found on the page: ${c.brief.steered.map((s) => `"${s}"`).join(", ")}`}</p>}
      <p className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void copy(c.markdown).then(() => setCopied(true))}>
          Copy as Markdown
        </Button>
        {copied && <span role="status" className="text-sm text-muted-foreground"> Copied.</span>}
      </p>
      <p>
        <small className="text-sm text-muted-foreground">Approving means you'll make this change yourself. Direx doesn't change the page or publish anything.</small>
      </p>
    </section>
  );
}
