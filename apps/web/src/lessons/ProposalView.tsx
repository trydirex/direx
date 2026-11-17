// SPDX-License-Identifier: AGPL-3.0-only
// A lesson waiting in Needs you, in words: the sentence, which writer it's for and where it came from;
// or, for a lesson becoming a Fact, where in Brand the words go.
import { Link } from "@tanstack/react-router";
import { FIELD_LABEL, type Field } from "../facts/actions";
import { writerWords } from "./actions";

export type LessonProposal = { text: string; agent: string; sourceRef: string | null };
export type LessonFact = { field: Field; value: string; source: { label: string } };

/** The Campaign a "campaign:{id}/{step}[/{person}]" source names, or null for any other source. */
export const campaignOf = (sourceRef: string | null) => sourceRef?.match(/^campaign:([0-9a-f-]{36})\//)?.[1] ?? null;

/** A link to the Campaign where the edit was made, on its drafts. */
export const CampaignLink = ({ workspaceId, campaignId }: { workspaceId: string; campaignId: string }) => (
  <Link className="underline" to="/w/$workspaceId/campaigns/$campaignId" params={{ workspaceId, campaignId }} search={{ tab: "drafts" }}>
    this Campaign
  </Link>
);

/** "campaign:{id}/{step}[/{person}]" as a link to that Campaign, or nothing for any other source. */
function SourceLink({ workspaceId, sourceRef }: { workspaceId: string; sourceRef: string | null }) {
  const campaignId = campaignOf(sourceRef);
  if (!campaignId) return null;
  return (
    <p className="text-sm text-muted-foreground">
      Suggested after an edit in <CampaignLink workspaceId={workspaceId} campaignId={campaignId} />.
    </p>
  );
}

export function ProposalView(p: { workspaceId: string; kind: "lesson_proposal" | "lesson_fact"; content: unknown }) {
  if (p.kind === "lesson_fact") {
    const c = p.content as LessonFact;
    return (
      <section aria-label="The brand fact" className="flex flex-col gap-2">
        <blockquote className="border-l-2 border-border pl-4">{c.value}</blockquote>
        <p className="text-sm text-muted-foreground">Goes in Brand under {FIELD_LABEL[c.field] ?? c.field}. Where it came from: {c.source.label}.</p>
      </section>
    );
  }
  const c = p.content as LessonProposal;
  return (
    <section aria-label="The lesson" className="flex flex-col gap-2">
      <blockquote className="border-l-2 border-border pl-4">{c.text}</blockquote>
      <p className="text-sm text-muted-foreground">Once accepted, {writerWords(c.agent)} keeps this in mind in this Workspace, from its next run on.</p>
      <SourceLink workspaceId={p.workspaceId} sourceRef={c.sourceRef} />
    </section>
  );
}
