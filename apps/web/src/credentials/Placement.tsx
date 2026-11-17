// SPDX-License-Identifier: AGPL-3.0-only
// What a Mailbox's Placement checks found, by week, plain and content checks apart, and the reports it
// sent other Circle members. A verdict shows only where the server says at least 3 reports agree;
// every count is the server's, and nothing here says more than the counts.
import { useQuery } from "@tanstack/react-query";
import { placementResultsQuery, type PlacementResults } from "./actions";
import { dayWords, momentWords } from "../campaigns/actions";

type KindResult = PlacementResults["weeks"][number]["plain"];
type SentReport = PlacementResults["reportsSent"][number];

const VERDICT: Record<string, string> = { primary: "Primary", other_tab: "Another tab", spam: "Spam", missing: "Missing", query_failure: "Couldn't check" };
const verdictWord = (v: string) => VERDICT[v] ?? v;
const STATE: Record<string, string> = { draft: "Draft", needs_approval: "Needs approval", scheduled: "Scheduled", claimed: "Scheduled", dispatching: "Scheduled", sent: "Sent", blocked: "Blocked", cancelled: "Cancelled" };
const HELD: Record<string, string> = { outcome_unknown: "not sure it sent" };

/** "Week 50, 2026" from "2026-W50". */
export const weekWords = (w: string) => `Week ${Number(w.slice(6))}, ${w.slice(0, 4)}`;
const result = (k: KindResult) => (k.verdicts.length ? k.verdicts.map((v) => `${verdictWord(v.verdict)}: ${v.reports} matching reports`).join("; ") : `${k.note!.charAt(0).toUpperCase()}${k.note!.slice(1)}`);
const stateWords = (r: SentReport) => (r.state === "held" ? `Held: ${HELD[r.holdReason ?? ""] ?? (r.holdReason ?? "").replaceAll("_", " ")}` : `${STATE[r.state] ?? r.state} ${momentWords(r.at)}`);

/** The newest week's leading verdict, such as "Week 50, 2026: Primary", or null before any verdict. */
export function latestPlacement(r: PlacementResults | undefined) {
  const w = r?.weeks[0];
  const v = w && (w.plain.verdicts[0] ?? w.content.verdicts[0]);
  return w && v ? `${weekWords(w.week)}: ${verdictWord(v.verdict)}` : null;
}

export function Placement(p: { workspaceId: string; credentialId: string; name: string }) {
  const q = useQuery(placementResultsQuery(p.workspaceId, p.credentialId));
  const r = q.data;
  // On the cloud, or before any check was sent or reported, there is nothing to show.
  if (!r || (!r.weeks.length && !r.reportsSent.length)) return null;
  const differences = r.weeks.flatMap((w) => w.difference.map((d) => ({ week: w.week, ...d })));
  return (
    <section aria-label={`Placement checks: ${p.name}`} className="flex flex-col gap-3 text-sm">
      <h3 className="font-medium">Placement checks</h3>
      {r.bootstrapNote && <p className="text-muted-foreground">{r.bootstrapNote}</p>}
      {r.weeks.length > 0 && (
        <div className="overflow-x-auto rounded-card border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted">
              <tr className="*:px-3 *:py-2 *:font-medium">
                <th>Week</th>
                <th>Test email</th>
                <th>Sent</th>
                <th>Inboxes that reported</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {r.weeks.flatMap((w) =>
                (["plain", "content"] as const).map((kind) => (
                  <tr key={`${w.week}-${kind}`} className="border-t border-border align-top *:px-3 *:py-2">
                    <td>{weekWords(w.week)}</td>
                    <td>{kind === "plain" ? "Sample email" : "Real email"}</td>
                    <td>{w[kind].sent}</td>
                    <td>{w[kind].counted}</td>
                    <td>{result(w[kind])}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}
      {differences.map((d) => (
        <p key={`${d.week}-${d.verdict}`}>{`${weekWords(d.week)}, ${verdictWord(d.verdict)}: ${d.plain} matching reports for the sample email, ${d.content} for the real email.`}</p>
      ))}
      {r.reportsSent.length > 0 && (
        <>
          <h4 className="font-medium">Reports this email account sent</h4>
          <ul className="flex flex-col gap-1">
            {r.reportsSent.map((s) => (
              <li key={`${s.day}-${s.sender}-${s.kind}`}>{`${dayWords(s.day)}, to ${s.sender}: ${s.kind === "plain" ? "sample email" : "real email"} check, ${verdictWord(s.verdict)}. ${stateWords(s)}`}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
