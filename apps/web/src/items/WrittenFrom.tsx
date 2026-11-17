// SPDX-License-Identifier: AGPL-3.0-only
// What a draft was written from, as Direx recorded it: the sources themselves, linked where a screen shows them,
// rather than a model's account of its reasons.
import { Fragment, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { AGENT_NAMES } from "../models/actions";
import type { components } from "../api/schema";

type Sources = NonNullable<components["schemas"]["ItemWrittenFrom"]>;

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function WrittenFrom(p: { workspaceId: string; from: Sources; stepLabel: string | null }) {
  const w = { workspaceId: p.workspaceId };
  const { run, planId, step, facts, lessons, voice } = p.from;
  const parts: { key: string; node: ReactNode }[] = [
    ...(step ? [{ key: "step", node: <Link to="/w/$workspaceId/campaigns/$campaignId" params={{ ...w, campaignId: step.campaignId }} search={{ tab: "drafts" }}>{p.stepLabel ?? "Campaign step"}</Link> }] : []),
    ...(planId ? [{ key: "plan", node: <Link to="/w/$workspaceId/plans/$planId" params={{ ...w, planId }}>Plan</Link> }] : []),
    ...(voice ? [{ key: "voice", node: <Link to="/w/$workspaceId/brand" params={w}>Your Tone</Link> }] : []),
    ...facts.map((f) => ({ key: `${f.id}@${f.version}`, node: <Link to="/w/$workspaceId/brand" params={w}>Fact: {f.text}</Link> })),
    ...lessons.map((l) => ({ key: `lesson:${l.id}`, node: <Link to="/w/$workspaceId/brand/lessons" params={w}>Lesson: {l.text}</Link> })),
    // No screen shows one Run yet, so it is named, not linked.
    ...(run ? [{ key: "run", node: <span>{AGENT_NAMES[run.agent] ?? "Agent"}, <time dateTime={run.at}>{when(run.at)}</time></span> }] : []),
  ];
  return (
    <p aria-label="Written from" className="text-sm text-muted-foreground">
      Written from:{" "}
      {parts.map((x, n) => (
        <Fragment key={x.key}>
          {n > 0 && " · "}
          {x.node}
        </Fragment>
      ))}
    </p>
  );
}
