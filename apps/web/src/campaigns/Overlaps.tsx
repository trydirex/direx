// SPDX-License-Identifier: AGPL-3.0-only
// Who a Campaign reached: for each good outcome, People by the channels they got before it, and each
// one's Touches. Counts only, never credit: no row is ranked, and a rate shows only where the API gives one.
import { useQuery } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } from "@astryxdesign/core/Table";
import { dayWords, overlapsQuery, type Overlaps as Data } from "./actions";

type Kind = Data["kinds"][number];

const CHANNEL: Record<Kind["rows"][number]["channels"][number], string> = { email: "Email", linkedin_dm: "LinkedIn DM", x_dm: "X DM" };
const KIND: Record<Kind["kind"], { title: string; column: string; had: string }> = {
  interested: { title: "Interested replies from People this Campaign reached", column: "Replied interested", had: "Replied interested" },
  meeting: { title: "Meetings with People this Campaign reached", column: "Had a meeting", had: "Meeting" },
  deal: { title: "Deals with People this Campaign reached", column: "Had a deal", had: "Deal" },
};

/** A channel mix in words: "Email only", "Email and LinkedIn DM", "Email, LinkedIn DM and X DM". */
export function mixWords(channels: Kind["rows"][number]["channels"]) {
  const words = channels.map((c) => CHANNEL[c]);
  if (words.length === 1) return `${words[0]} only`;
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function OneKind(p: { kind: Kind }) {
  const { kind: k } = p;
  const words = KIND[k.kind];
  const id = `overlaps-${k.kind}`;
  const reached = k.rows.reduce((n, r) => n + r.reached, 0);
  const outcomes = k.people.length + k.more;
  return (
    <div className="flex flex-col gap-2">
      <h3 id={id} className="font-sans text-sm font-medium">
        {words.title}
      </h3>
      {outcomes === 0 ? (
        <p className="text-sm text-muted-foreground">{`None yet. ${reached} ${reached === 1 ? "Person" : "People"} reached so far.`}</p>
      ) : (
        <>
          {/* Scrolls sideways on a phone rather than squeezing its columns. */}
          <div className="overflow-x-auto text-sm">
            <Table aria-labelledby={id} textOverflow="wrap" className="min-w-sm">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell scope="col">Channels</TableHeaderCell>
                  <TableHeaderCell scope="col" className="text-right">People reached</TableHeaderCell>
                  <TableHeaderCell scope="col" className="text-right">{words.column}</TableHeaderCell>
                  <TableHeaderCell scope="col" className="text-right">Rate</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {k.rows.map((r) => (
                  <TableRow key={r.channels.join()}>
                    <TableHeaderCell scope="row">{mixWords(r.channels)}</TableHeaderCell>
                    <TableCell className="text-right tabular-nums">{r.reached}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.outcomes}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.rate === null ? <span className="text-muted-foreground">too few to compare</span> : `${r.rate}%`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer">{`Each Person and their Touches before it (${outcomes})`}</summary>
            <ul className="mt-2 flex flex-col gap-3">
              {k.people.map((person) => (
                <li key={person.personId} className="flex flex-col gap-1">
                  <span>
                    <span className="font-medium">{person.name ?? person.email ?? "No name or email"}</span>
                    <span className="text-muted-foreground">{` · ${words.had} ${dayWords(person.on)}`}</span>
                  </span>
                  <ol aria-label={`Touches before it for ${person.name ?? person.email ?? "this Person"}`} className="flex flex-col gap-0.5 text-muted-foreground">
                    {person.touches.map((t) => (
                      <li key={`${t.on}:${t.stepKey}`}>{`${dayWords(t.on)} · ${t.title ?? t.stepKey} · ${CHANNEL[t.channel]}`}</li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
            {k.more > 0 && <p className="mt-2 text-muted-foreground">{`and ${k.more} more`}</p>}
          </details>
        </>
      )}
    </div>
  );
}

/** The Campaign's outcomes by the channels each Person got before them. Silent until it reads. */
export function Overlaps(p: { workspaceId: string; id: string }) {
  const data = useQuery(overlapsQuery(p.workspaceId, p.id)).data;
  if (!data) return null;
  const touched = data.kinds.some((k) => k.rows.length > 0);
  return (
    <section aria-labelledby="overlaps" className="flex flex-col gap-3">
      <h2 id="overlaps" className="font-sans text-sm font-semibold">
        Who it reached
      </h2>
      <p className="text-sm text-muted-foreground">
        {touched ? "Counted by Direx from emails sent and DMs marked sent. Each Person is in one row, by the channels they got up to the outcome." : "Nothing to count yet. This fills in once an email goes out or a DM is marked sent."}
      </p>
      {data.hasPosts && <p className="text-sm text-muted-foreground">Posts reach no named People, so they aren't in these counts.</p>}
      {touched && data.kinds.map((k) => <OneKind key={k.kind} kind={k} />)}
    </section>
  );
}
