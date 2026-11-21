// SPDX-License-Identifier: AGPL-3.0-only
// What DNS says about the domain a Mailbox sends from, on its card: whether receivers can check that
// mail from it is genuine, and what to fix when they can't. Read when shown; it changes nothing.
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/Button";
import { domainQuery, type DomainReport as Report } from "./actions";

const CHECK_AGAIN = "Couldn't read it from DNS just now.";

/** One line per problem, each saying what to fix; none when the domain passes. */
export function domainProblems(r: Report): string[] {
  const out: string[] = [];
  if (r.mx === "missing") out.push("It has no MX record, so it can't receive replies or bounces. Add the MX records your email provider gives you.");
  if (r.spf === "missing") out.push("It has no SPF record. Add the SPF record your email provider gives you.");
  if (r.spf === "no_provider_include") out.push("Its SPF record doesn't include this account's email provider. Add the provider's include to it.");
  if (r.dkim === "not_found") out.push("No DKIM key was found. Turn on DKIM signing in your email provider's admin console.");
  if (r.dmarc === "missing") out.push("It has no DMARC record. Add one; p=none is enough to start.");
  if ([r.mx, r.spf, r.dkim, r.dmarc].includes("unknown")) out.push(CHECK_AGAIN);
  return out;
}

export function MailboxDomain(p: { workspaceId: string; credentialId: string }) {
  const query = useQuery(domainQuery(p.workspaceId, p.credentialId));
  // Not an alert: the card's own controls still work, and nothing waits on this.
  if (query.isError) return <p>Couldn't check the sending domain. <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button></p>;
  if (!query.isSuccess) return <p role="status">Checking the sending domain…</p>;
  const r = query.data;
  if (r.consumer) return <p>Sends from {r.domain}, whose sender checks are the provider's own.</p>;
  const problems = domainProblems(r);
  if (!problems.length) return <p>Sends from {r.domain}: SPF, DKIM and DMARC ({r.dmarc}) are set up, so receivers can check its mail is genuine.</p>;
  return (
    <div>
      <p>Sends from {r.domain}. {r.authenticated ? "Receivers can check its mail is genuine, but:" : "Receivers can't yet check its mail is genuine, so more of it may land in spam:"}</p>
      <ul className="list-disc pl-5">
        {problems.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
