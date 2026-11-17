// SPDX-License-Identifier: AGPL-3.0-only
// One line saying what Direx is doing right now, so the agent is never invisible. Nothing shows when it
// is idle, or when the list can't be read.
import { useQuery } from "@tanstack/react-query";
import { AGENT_NAMES } from "@/models/actions";
import { runsQuery, type Run } from "./actions";

// What each agent is producing, so the line says the outcome rather than a role name.
const DOING: Record<string, string> = {
  brand_reader: "Reading your website for Brand",
  strategy_drafter: "Drafting your strategy",
  plan_drafter: "Drafting your plan",
  campaign_drafter: "Drafting Campaign content",
  recipient_reader: "Reading a Company's website",
  recipient_writer: "Drafting emails",
};
const minutes = (from: string, now: number) => Math.max(0, Math.floor((now - Date.parse(from)) / 60_000));

/** "Reading your website for Brand · 2m", or "3 agents working" when more than one runs. */
export function statusLine(runs: Run[], now = Date.now()): string | null {
  const running = runs.filter((r) => r.status === "running");
  if (running.length === 0) return null;
  if (running.length > 1) return `${running.length} agents working`;
  const r = running[0]!;
  return `${DOING[r.agent] ?? `${AGENT_NAMES[r.agent] ?? r.agent} is working`} · ${minutes(r.createdAt, now)}m`;
}

export function AgentStatus(p: { workspaceId: string }) {
  const runs = useQuery({
    ...runsQuery(p.workspaceId),
    // Often while something runs, so the line ends soon after the run does; rarely otherwise.
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === "running") ? 15_000 : 60_000),
  }).data;
  const line = statusLine(runs ?? []);
  if (!line) return null;
  return (
    <p role="status" className="flex min-w-0 items-center gap-2 truncate text-sm text-primary">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
      {line}
    </p>
  );
}
