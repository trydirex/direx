// SPDX-License-Identifier: AGPL-3.0-only
// One company to review. Everything here came from the company's own pages, so it is shown as text
// and a page address becomes a link only when it is a web address.
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Notice } from "../components/layout";
import { countryName } from "../outreach/countries";
import { strategyQuery, type StrategyBody } from "../plans/actions";
import { Button, Key } from "@/components/Button";
import { mayApprove, type Item, type Role } from "../items/actions";
import { KIND_WORDS, keep, leftOutWords, namesWords, reject, safeHref, sayReview, SIGNAL_WORDS, type Review } from "./actions";

export function PageLink({ url, children }: { url: string; children: React.ReactNode }) {
  const href = safeHref(url);
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

/** A person ticks the addresses to keep and accepts, or rejects the company. Named people start ticked; left-out addresses can't be ticked. */
export function CompanyReview(p: { workspaceId: string; item: Pick<Item, "id" | "revision" | "state">; review: Review; role: Role; onSettle: () => void;
  /** In the queue: A accepts and R rejects, each named on its button. */
  keys?: boolean }) {
  const r = p.review;
  const guessFor = r.guessFor ?? [];
  // Fit is judged against the Strategy's written audience, when there is one.
  const audience = useQuery(strategyQuery(p.workspaceId)).data?.current as StrategyBody | null | undefined;
  // Named people's addresses start ticked; shared inboxes and role addresses wait for a person to tick them.
  const [kept, setKept] = useState<number[]>(() => r.addresses.flatMap((a, i) => (a.kind === "named" && a.leftOut === null ? [i] : [])));
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const settle = async (action: () => Promise<string | null>) => {
    setPending(true);
    const code = await action().finally(() => setPending(false));
    if (code) setError(sayReview(code));
    else p.onSettle();
  };
  const deciding = p.item.state === "needs_approval" && mayApprove(p.role);
  const toggle = (i: number) => setKept((k) => (k.includes(i) ? k.filter((x) => x !== i) : [...k, i].sort((a, b) => a - b)));
  const accept =
    kept.length === 0 && guessFor.length > 0
      ? `Accept and guess addresses for ${guessFor.length === 1 ? "1 person" : `${guessFor.length} people`}`
      : `Accept and keep ${kept.length === 1 ? "1 address" : `${kept.length} addresses`}`;
  // With nothing to keep or guess, Accept is off, and this says why.
  const nothing = kept.length === 0 && guessFor.length === 0;
  const why = !nothing ? undefined : r.addresses.some((a) => a.leftOut === null) ? "Tick an address to keep, or reject this company." : "No address here can be kept, so reject this company.";
  const whyId = useId();

  return (
    <section aria-label="Company review" className="flex flex-col gap-3">
      <p>
        <PageLink url={r.website}>{r.name ?? r.domain}</PageLink> ({r.domain})
      </p>
      <p>
        Country: {r.country ? countryName(r.country.code) : "not found on the site"}
        {r.country?.quote && <> from &ldquo;{r.country.quote}&rdquo;</>}
      </p>
      {r.names.status !== "done" && <p>{namesWords(r.names.status, r.names.reason)}.</p>}

      {audience && (audience.whoFor || audience.personas.length > 0) && (
        <section aria-label="Who we're for" className="flex flex-col gap-1 rounded-card bg-muted p-3 text-sm">
          {audience.whoFor && <p>Who we&apos;re for: {audience.whoFor}</p>}
          {audience.personas.length > 0 && <p>Personas: {audience.personas.map((x) => x.name).join(", ")}</p>}
        </section>
      )}

      <h3 className="font-medium">Signals</h3>
      {r.signals.length === 0 ? (
        <p>None found.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {r.signals.map((s, n) => (
            <li key={n}>
              {SIGNAL_WORDS[s.type] ?? s.type}, {s.observedOn}: <q>{s.quote}</q> <PageLink url={s.pageUrl}>on this page</PageLink>
            </li>
          ))}
        </ul>
      )}

      <h3 className="font-medium">Addresses</h3>
      {r.addresses.length === 0 ? (
        <p>None found.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {r.addresses.map((a, i) => (
            <li key={a.id} className={a.leftOut ? "text-muted-foreground" : undefined}>
              <label className="inline-flex min-h-6 items-center gap-2">
                <input type="checkbox" disabled={!deciding || a.leftOut !== null} checked={a.leftOut === null && kept.includes(i)} onChange={() => toggle(i)} /> {a.email}
              </label>{" "}
              {KIND_WORDS[a.kind] ?? a.kind}, {a.source === "guessed" ? "guessed" : "published"}
              {a.name && `, ${a.name}`}
              {a.role && ` (${a.role})`}. <PageLink url={a.pageUrl}>Where it was found</PageLink>
              {a.personId && a.leftOut === null && " Already a Person here, so keeping it joins them."}
              {a.leftOut && ` Left out: ${leftOutWords(a.leftOut)}.`}
            </li>
          ))}
        </ul>
      )}

      {guessFor.length > 0 && (
        <>
          <h3 className="font-medium">People to guess an address for</h3>
          <p>Named on the site with no published address. When you accept, Direx guesses an address for each from the company&apos;s domain and keeps it only if the checking service says it&apos;s deliverable.</p>
          <ul>
            {guessFor.map((g) => (
              <li key={g.name}>
                {g.name}
                {g.role && ` (${g.role})`}
              </li>
            ))}
          </ul>
        </>
      )}

      {error && <Notice tone="error">{error}</Notice>}
      {deciding && why && (
        <p id={whyId} className="text-sm text-muted-foreground">
          {why}
        </p>
      )}
      {deciding && (
        <div className="flex flex-wrap gap-2">
          <Button label={accept} disabled={nothing} aria-describedby={why ? whyId : undefined} pending={pending} aria-keyshortcuts={p.keys ? "A" : undefined} onClick={() => void settle(() => keep(p.workspaceId, p.item, kept))}>
            {accept}
            {p.keys && <Key>A</Key>}
          </Button>
          <Button label="Reject this company" variant="outline" pending={pending} aria-keyshortcuts={p.keys ? "R" : undefined} onClick={() => void settle(() => reject(p.workspaceId, p.item))}>
            Reject this company
            {p.keys && <Key>R</Key>}
          </Button>
        </div>
      )}
    </section>
  );
}
