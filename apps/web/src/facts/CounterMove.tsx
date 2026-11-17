// SPDX-License-Identifier: AGPL-3.0-only
// A counter-move Item: what a competitor changed, in its own words with the dates Direx read them, what
// the change is worth answering with, and a draft once one passed Direx's checks: a Brief for a comparison
// page, a post for a post. Approving means the person made the move; Direx publishes nothing.
import { useState } from "react";
import { Button } from "@/components/Button";

type Read = { id: string; readAt: string };
type Sighting = { changeId: string; source: string; lines: string[]; before: Read; after: Read & { url: string } };
type Edit = { where: string; quote: string | null; problem: string; fix: string; newText: string[]; theirs: string[]; ours: string[] };
/** What a competitor_move Item holds, as the competitors module wrote it. */
export type CounterMoveContent = {
  move: "comparison_page" | "post";
  competitor: { id: string; name: string };
  target: string | null;
  reason: string;
  sightings: Sighting[];
  brief: { edits: Edit[]; cantTell: string | null; steered: string[] } | null;
  briefNote: string | null;
  /** Absent on counter-moves stored before posts were drafted. An empty text is a no-post; its reason is the note. */
  post?: { text: string; theirs: string[]; facts: { id: string; text: string }[]; cantTell: string | null; steered: string[] } | null;
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

function Brief({ brief }: { brief: NonNullable<CounterMoveContent["brief"]> }) {
  if (brief.edits.length === 0) return <p>Your page already covers this.</p>;
  return (
    <div className="overflow-x-auto rounded-card border border-border">
      <table aria-label="Draft edits" className="w-full text-left text-sm">
        <thead className="bg-muted">
          <tr className="*:px-3 *:py-2 *:font-medium">
            <th>Where</th>
            <th>Your page says</th>
            <th>Fix</th>
            <th>New text</th>
            <th>Their words</th>
          </tr>
        </thead>
        <tbody>
          {brief.edits.map((e, i) => (
            <tr key={i} className="border-t border-border align-top *:px-3 *:py-2">
              <td>{e.where}</td>
              <td>{e.quote === null ? "Nothing on the page" : `"${e.quote}"`}</td>
              <td>{e.fix}</td>
              <td>{e.newText.join(" ")}</td>
              <td>{e.theirs.map((t) => `"${t}"`).join(", ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Post({ post, copy }: { post: NonNullable<CounterMoveContent["post"]>; copy: (text: string) => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <p className="whitespace-pre-wrap rounded-card border border-border p-3">{post.text}</p>
      <p className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void copy(post.text).then(() => setCopied(true))}>
          Copy the post
        </Button>
        {copied && <span role="status" className="text-sm text-muted-foreground"> Copied.</span>}
      </p>
      <p className="text-sm text-muted-foreground">{`Their words: ${post.theirs.map((t) => `"${t}"`).join(", ")}`}</p>
      {post.facts.length > 0 && (
        <ul aria-label="What the post rests on" className="list-disc pl-5 text-sm text-muted-foreground">
          {post.facts.map((f) => (
            <li key={f.id}>{f.text}</li>
          ))}
        </ul>
      )}
      {post.cantTell && <p className="text-muted-foreground">{post.cantTell}</p>}
    </div>
  );
}

export function CounterMoveView({ c, copy = (text) => navigator.clipboard.writeText(text) }: { c: CounterMoveContent; copy?: (text: string) => Promise<void> }) {
  const name = c.competitor.name;
  return (
    <section aria-label="Counter-move" className="flex flex-col gap-4">
      <p>{c.reason}</p>
      <ul aria-label={`What ${name} changed`} className="flex flex-col gap-2">
        {c.sightings.map((s) => (
          <li key={s.changeId}>
            <span className="text-sm text-muted-foreground">
              {name} {s.source} page, read {day(s.after.readAt)} (<a href={s.after.url}>{s.after.url}</a>)
            </span>
            <ul className="list-disc pl-5">
              {s.lines.map((l) => (
                <li key={l}>
                  <q>{l}</q>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {c.move === "comparison_page" &&
        (c.target ? (
          <p>
            Your comparison page: <a href={c.target}>{c.target}</a>
          </p>
        ) : (
          <p className="text-muted-foreground">No comparison page against {name} yet. Add one under Competitors on Brand.</p>
        ))}
      {c.brief && <Brief brief={c.brief} />}
      {c.brief && c.brief.cantTell && <p className="text-muted-foreground">{c.brief.cantTell}</p>}
      {c.brief && c.brief.steered.length > 0 && <p>{`Ignored instructions found in the text: ${c.brief.steered.map((s) => `"${s}"`).join(", ")}`}</p>}
      {c.post?.text && <Post post={c.post} copy={copy} />}
      {c.post && c.post.steered.length > 0 && <p>{`Ignored instructions found in the text: ${c.post.steered.map((s) => `"${s}"`).join(", ")}`}</p>}
      {c.briefNote && <p className="text-muted-foreground">{c.briefNote}</p>}
      <p>
        <small className="text-sm text-muted-foreground">Approving means you made this move yourself. Direx doesn't change any page or publish anything.</small>
      </p>
    </section>
  );
}
