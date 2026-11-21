// SPDX-License-Identifier: AGPL-3.0-only
// What DNS says about the domain a Mailbox sends from: whether it takes mail, and whether its SPF,
// DKIM and DMARC records let receivers trust it. DNS only, through the lookups given, so it costs
// nothing and sends nothing. Gmail and Yahoo require SPF, DKIM and a DMARC record of bulk senders.

/** The two DNS lookups the report makes. Each throws with a Node DNS code when there's no answer. */
export type DomainDns = {
  mx: (domain: string) => Promise<{ exchange: string }[]>;
  txt: (name: string) => Promise<string[][]>;
};

export type MailProvider = "google" | "microsoft";

export type DomainReport = {
  domain: string;
  /** A shared mail provider's domain, such as gmail.com: its SPF, DKIM and DMARC are the provider's. */
  consumer: boolean;
  mx: "pass" | "missing" | "unknown";
  /** `no_provider_include`: an SPF record that doesn't name the Mailbox's provider. */
  spf: "pass" | "missing" | "no_provider_include" | "unknown";
  dkim: "pass" | "not_found" | "unknown";
  dmarc: "none" | "quarantine" | "reject" | "missing" | "unknown";
};

/** The include each provider's SPF needs. */
const SPF_INCLUDE: Record<MailProvider, string> = { google: "_spf.google.com", microsoft: "spf.protection.outlook.com" };
/** The selectors each provider publishes DKIM keys under, unless the domain set its own. */
const DKIM_SELECTORS: Record<MailProvider, string[]> = { google: ["google"], microsoft: ["selector1", "selector2"] };
/** Codes for a name that doesn't exist, or exists with no record of the type asked for. */
const NONE = new Set(["ENOTFOUND", "ENODATA"]);

type Lookup<T> = { ok: true; value: T } | { ok: false; missing: boolean };
async function lookup<T>(f: () => Promise<T>): Promise<Lookup<T>> {
  try {
    return { ok: true, value: await f() };
  } catch (e) {
    return { ok: false, missing: NONE.has((e as { code?: string }).code ?? "") };
  }
}
const records = (txt: string[][]) => txt.map((chunks) => chunks.join(""));

function spfOf(r: Lookup<string[][]>, provider: MailProvider | null): DomainReport["spf"] {
  if (!r.ok) return r.missing ? "missing" : "unknown";
  const spfs = records(r.value).filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  if (spfs.length > 1) return "unknown"; // SPF receivers treat multiple records as a permanent error.
  const [spf] = spfs;
  if (!spf) return "missing";
  if (provider) {
    const include = `include:${SPF_INCLUDE[provider]}`;
    if (!spf.toLowerCase().split(/\s+/).some((term) => term === include || term === `+${include}`)) return "no_provider_include";
  }
  return "pass";
}

function dmarcPolicy(value: string | undefined) {
  const policy = value?.toLowerCase();
  return policy === "none" || policy === "quarantine" || policy === "reject" ? policy : undefined;
}

function hasReportingUri(value: string | undefined): boolean {
  return value?.split(",").some((entry) => {
    // DMARC still accepts the obsolete optional !size suffix.
    const uri = entry.trim().replace(/![0-9]+[kmgt]?$/i, "");
    if (!/^[a-z][a-z0-9+.-]*:[a-z0-9._~:/?#[\]@&'()*+;=%$-]+$/i.test(uri) || /%(?![0-9a-f]{2})/i.test(uri)) return false;
    if (/^mailto:\?/i.test(uri)) {
      // RFC 6068 also allows the recipient in a query header.
      if (uri.includes("#") || !uri.slice("mailto:?".length).split("&").some((field) => /^to=[^@?]+@[^@?]+$/i.test(field))) return false;
    } else if (/^mailto:/i.test(uri) && !/^mailto:[^@?]+@[^@?]+(?:\?|$)/i.test(uri)) return false;
    return URL.canParse(uri);
  }) ?? false;
}

async function discoverDmarc(domain: string, dns: DomainDns): Promise<DomainReport["dmarc"]> {
  const labels = domain.split(".");
  let inherited: { labels: number; policy: Exclude<DomainReport["dmarc"], "unknown"> } | undefined;

  // RFC 9989: query the sending domain first, then walk up from at most seven labels.
  for (let count = labels.length; count > 0; count = Math.min(count - 1, 7)) {
    const name = labels.slice(-count).join(".");
    const answer = await lookup(() => dns.txt(`_dmarc.${name}`));
    if (!answer.ok) {
      if (!answer.missing) return "unknown";
      continue;
    }
    const policies = records(answer.value).filter((t) => /^[vV][ \t]*=[ \t]*DMARC1[ \t]*(?:;|$)/.test(t.trim()));
    const [record] = policies;
    if (policies.length !== 1 || !record) continue;
    const tags = new Map<string, string>();
    for (const field of record.split(";")) {
      const equals = field.indexOf("=");
      if (equals === -1) continue;
      const key = field.slice(0, equals).trim().toLowerCase();
      if (!tags.has(key)) tags.set(key, field.slice(equals + 1).trim());
    }
    const policy = dmarcPolicy(tags.get("p"));
    const subdomain = dmarcPolicy(tags.get("sp"));
    const invalid = !policy || (tags.has("sp") && !subdomain) || (tags.has("np") && !dmarcPolicy(tags.get("np")));
    const effective = invalid
      ? hasReportingUri(tags.get("rua")) ? "none" : "missing"
      : count === labels.length ? policy : subdomain ?? policy;
    if (count === labels.length) return effective;
    const psd = tags.get("psd")?.toLowerCase();
    if (psd === "n") return effective;
    // At a public suffix, the organization is one label below it.
    if (psd === "y") return inherited?.labels === count + 1 ? inherited.policy : effective;
    inherited = { labels: count, policy: effective };
  }
  return inherited?.policy ?? "missing";
}

/**
 * The report for `domain`. `provider` names the Mailbox's provider when Direx knows it, so SPF is
 * checked for its include and DKIM under its selectors; `selectors` adds the domain's own.
 */
export async function domainReport(domain: string, dns: DomainDns, a: { consumer: boolean; provider: MailProvider | null; selectors?: readonly string[] }): Promise<DomainReport> {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  const selectors = [...new Set([...(a.provider ? DKIM_SELECTORS[a.provider] : [...DKIM_SELECTORS.google, ...DKIM_SELECTORS.microsoft]), ...(a.selectors ?? [])])];
  const [mx, spf, dmarc, ...dkim] = await Promise.all([
    lookup(() => dns.mx(d)),
    lookup(() => dns.txt(d)),
    discoverDmarc(d, dns),
    ...selectors.map((s) => lookup(() => dns.txt(`${s}._domainkey.${d}`))),
  ]);
  const dkimKey = dkim.some((r) => r.ok && records(r.value).some((t) => /(^|;)\s*p\s*=\s*[A-Za-z0-9+/]/.test(t)));
  return {
    domain: d,
    consumer: a.consumer,
    mx: mx.ok ? (mx.value.some((r) => r.exchange !== "" && r.exchange !== ".") ? "pass" : "missing") : mx.missing ? "missing" : "unknown",
    spf: spfOf(spf, a.provider),
    dkim: dkimKey ? "pass" : dkim.every((r) => r.ok || r.missing) ? "not_found" : "unknown",
    dmarc,
  };
}

/** Whether a domain is authenticated as Gmail and Yahoo require: SPF and DKIM pass, and DMARC exists with any policy. A shared provider's domain is the provider's to set up. */
export const authenticated = (r: DomainReport): boolean =>
  r.consumer || (r.spf === "pass" && r.dkim === "pass" && (r.dmarc === "none" || r.dmarc === "quarantine" || r.dmarc === "reject"));
