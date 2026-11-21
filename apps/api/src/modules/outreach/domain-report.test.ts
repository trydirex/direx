// SPDX-License-Identifier: AGPL-3.0-only
// The Mailbox domain report against DNS fixtures: each check's every result, when a domain counts as
// authenticated, and the route that reads a Mailbox's own domain.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { expect, test } from "vitest";
import { createVault, rootKeyFromEnv } from "../credentials/index";
import { testIdentity } from "../identity/test-auth";
import { authenticated, domainReport, type DomainDns } from "./domain/domain-report";
import { createMailboxDomains, outreachRoutes } from "./index";

const fail = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
/** DNS answering from `zone`: a name's TXT records, or an error code. MX comes from `mx`. */
function dns(zone: Record<string, string[] | string>, mx: { exchange: string }[] | string = [{ exchange: "mx.acme.test" }]): DomainDns {
  return {
    mx: async () => (typeof mx === "string" ? fail(mx) : mx),
    txt: async (name) => {
      const r = zone[name];
      if (r === undefined) return fail("ENOTFOUND");
      // Long records come split in chunks of at most 255 characters.
      return typeof r === "string" ? fail(r) : r.map((t) => [t.slice(0, 10), t.slice(10)]);
    },
  };
}
const GOOD = {
  "acme.test": ["google-site-verification=x", "v=spf1 include:_spf.google.com ~all"],
  "_dmarc.acme.test": ["v=DMARC1; p=quarantine; rua=mailto:d@acme.test"],
  "google._domainkey.acme.test": ["v=DKIM1; k=rsa; p=MIIBIjANBgkq"],
};
const report = (zone: Record<string, string[] | string>, a: Partial<Parameters<typeof domainReport>[2]> = {}, mx?: Parameters<typeof dns>[1]) =>
  domainReport("Acme.test.", dns(zone, mx), { consumer: false, provider: "google", ...a });

test("a Google Workspace domain with SPF, DKIM and DMARC passes", async () => {
  const r = await report(GOOD);
  expect(r).toEqual({ domain: "acme.test", consumer: false, mx: "pass", spf: "pass", dkim: "pass", dmarc: "quarantine" });
  expect(authenticated(r)).toBe(true);
});

test("multiple SPF records cannot authenticate a domain, even when the provider is unknown", async () => {
  const zone = { ...GOOD, "acme.test": [...GOOD["acme.test"], "v=spf1 include:spf.protection.outlook.com -all"] };
  for (const provider of ["google", null] as const) {
    const r = await report(zone, { provider });
    expect(r.spf).toBe("unknown");
    expect(authenticated(r)).toBe(false);
  }
});

test.each([["+", "pass"], ["-", "no_provider_include"], ["~", "no_provider_include"], ["?", "no_provider_include"]])(
  "an SPF include with qualifier %s reports %s",
  async (qualifier, status) => {
    const r = await report({ ...GOOD, "acme.test": ["google-site-verification=x", `v=spf1 ${qualifier}include:_spf.google.com ~all`] });
    expect(r.spf).toBe(status);
  },
);

test("multiple DMARC records are discarded, but unrelated TXT records do not count", async () => {
  const unrelated = "site-verification=x";
  const zone = { ...GOOD, "_dmarc.acme.test": [unrelated, ...GOOD["_dmarc.acme.test"]] };
  expect((await report(zone)).dmarc).toBe("quarantine");
  const r = await report({ ...zone, "_dmarc.acme.test": [...zone["_dmarc.acme.test"], "v=DMARC1; p=reject"] });
  expect(r.dmarc).toBe("missing");
  expect(authenticated(r)).toBe(false);
});

test("each record missing, or answered with an error, says which", async () => {
  expect(await report({})).toMatchObject({ spf: "missing", dkim: "not_found", dmarc: "missing" });
  expect(await report({ ...GOOD, "acme.test": ["v=spf1 include:spf.protection.outlook.com -all"] })).toMatchObject({ spf: "no_provider_include" });
  expect(await report({ ...GOOD, "acme.test": "ESERVFAIL", "_dmarc.acme.test": "ETIMEOUT", "google._domainkey.acme.test": "ETIMEOUT" })).toMatchObject({ spf: "unknown", dkim: "unknown", dmarc: "unknown" });
  expect(await report({ ...GOOD, "_dmarc.acme.test": ["v=DMARC1; rua=not-a-uri"] })).toMatchObject({ dmarc: "missing" });
  expect(await report({ ...GOOD, "google._domainkey.acme.test": ["v=DKIM1; p="] })).toMatchObject({ dkim: "not_found" });
  expect(await report(GOOD, {}, "ENODATA")).toMatchObject({ mx: "missing" });
  expect(await report(GOOD, {}, [{ exchange: "." }])).toMatchObject({ mx: "missing" });
  expect(await report(GOOD, {}, "ESERVFAIL")).toMatchObject({ mx: "unknown" });
  for (const dmarc of ["none", "reject"]) expect(await report({ ...GOOD, "_dmarc.acme.test": [`v=DMARC1; p=${dmarc}`] })).toMatchObject({ dmarc });
});

test.each([
  ["v \t= DMARC1 ; p=reject", "reject", true],
  ["v=dmarc1; p=reject", "missing", false],
  ["v=DMARC1; rua=mailto:d@acme.test", "none", true],
  ["v=DMARC1; rua=mailto:?to=d@acme.test", "none", true],
  ["v=DMARC1; rua=mailto:?subject=reports&TO=d+reports@acme.test", "none", true],
  ["v=DMARC1; rua=mailto:?%74o=d%26alerts+reports%40acme.test", "none", true],
  ["v=DMARC1; rua=mailto:?subject=reports%26to%3Dd@acme.test", "missing", false],
  ["v=DMARC1; rua=mailto:?to=d@acme.test%20invalid", "missing", false],
  ["v=DMARC1; rua=mailto:?to=d@acme.test%00", "missing", false],
  ["v=DMARC1; rua=mailto:?to=d@acme.test%FF", "missing", false],
  ["v=DMARC1; rua=mailto:?subject=d@acme.test", "missing", false],
  ["v=DMARC1; rua=mailto:?to", "missing", false],
  ["v=DMARC1; rua=mailto:?to=not-an-address", "missing", false],
  ["v=DMARC1; rua=mailto:?to=d%zz@acme.test", "missing", false],
  ["v=DMARC1; rua=mailto:?subject=reports#&to=d@acme.test", "missing", false],
  ["v=DMARC1; p=invalid; rua=junk,mailto:d@acme.test!10m", "none", true],
  ["v=DMARC1; p=reject; sp=invalid; rua=mailto:d@acme.test", "none", true],
  ["v=DMARC1; p=reject; sp=invalid", "missing", false],
  ["v=DMARC1; p=reject; np=; rua=mailto:not-an-address", "missing", false],
  ["v=DMARC1; p=reject; np=invalid; rua=mailto:d%zz@acme.test", "missing", false],
  ["v=DMARC1; p=reject; sp=none; np=quarantine; rua=mailto:d@acme.test", "reject", true],
] as const)("reports the effective DMARC policy for %s", async (record, dmarc, auth) => {
  const r = await report({ ...GOOD, "_dmarc.acme.test": [record] });
  expect(r.dmarc).toBe(dmarc);
  expect(authenticated(r)).toBe(auth);
});

const sendingDomain = "sales.acme.test";
const sendingZone = {
  [sendingDomain]: GOOD["acme.test"],
  [`google._domainkey.${sendingDomain}`]: GOOD["google._domainkey.acme.test"],
};

test.each([
  ["an inherited sp tag", ["site-verification=x"], ["v=DMARC1; p=reject; SP = QUARANTINE"], "quarantine", true],
  ["an inherited p tag", "ENODATA", ["v=DMARC1; p=reject"], "reject", true],
  ["a local policy", ["v=DMARC1; p=none; sp=reject"], "ETIMEOUT", "none", true],
  ["a local reporting fallback", ["v=DMARC1; rua=mailto:d@acme.test"], ["v=DMARC1; p=reject"], "none", true],
  ["an invalid local policy", ["v=DMARC1; p=reject; np=invalid"], ["v=DMARC1; p=reject"], "missing", false],
  ["an inherited reporting fallback", "ENODATA", ["v=DMARC1; p=reject; sp=invalid; rua=mailto:d@acme.test"], "none", true],
  ["an invalid inherited policy", "ENODATA", ["v=DMARC1; p=reject; sp=invalid"], "missing", false],
  ["a local lookup failure", "ETIMEOUT", ["v=DMARC1; p=reject"], "unknown", false],
  ["a parent lookup failure", "ENOTFOUND", "ESERVFAIL", "unknown", false],
  ["no policy in the tree", "ENODATA", "ENOTFOUND", "missing", false],
] as const)("the sending subdomain reports %s", async (_case, local, parent, dmarc, auth) => {
  const r = await domainReport(sendingDomain, dns({
    ...sendingZone,
    [`_dmarc.${sendingDomain}`]: typeof local === "string" ? local : [...local],
    "_dmarc.acme.test": typeof parent === "string" ? parent : [...parent],
  }), { consumer: false, provider: "google" });
  expect(r.dmarc).toBe(dmarc);
  expect(authenticated(r)).toBe(auth);
});

test.each([
  ["v=DMARC1; p=quarantine", "v=DMARC1; p=reject", "reject"],
  ["v=DMARC1; p=quarantine; psd=n", "ETIMEOUT", "quarantine"],
  ["v=DMARC1; p=quarantine", "v=DMARC1; p=reject; psd=y", "quarantine"],
] as const)("discovers the organizational policy with records %s and %s", async (parent, ancestor, expected) => {
  const r = await domainReport("east.sales.acme.test", dns({
    "_dmarc.sales.acme.test": [parent],
    "_dmarc.acme.test": ancestor === "ETIMEOUT" ? ancestor : [ancestor],
  }), { consumer: false, provider: "google" });
  expect(r.dmarc).toBe(expected);
});

test("deep sending domains make at most eight DMARC queries and still reach the organizational domain", async () => {
  const domain = "a.b.c.d.e.f.g.h.sales.acme.test";
  const fixture = dns({ "_dmarc.acme.test": ["v=DMARC1; p=reject"] });
  const queries: string[] = [];
  const r = await domainReport(domain, {
    ...fixture,
    txt: (name) => {
      if (name.startsWith("_dmarc.")) queries.push(name);
      return fixture.txt(name);
    },
  }, { consumer: false, provider: "google" });
  expect(queries).toHaveLength(8);
  expect(queries.slice(0, 2)).toEqual([`_dmarc.${domain}`, "_dmarc.e.f.g.h.sales.acme.test"]);
  expect(r.dmarc).toBe("reject");
});

test("a marked public suffix policy applies if its immediate child has no policy", async () => {
  const r = await domainReport("east.sales.acme.test", dns({
    "_dmarc.sales.acme.test": ["v=DMARC1; p=none"],
    "_dmarc.test": ["v=DMARC1; p=quarantine; psd=y"],
  }), { consumer: false, provider: "google" });
  expect(r.dmarc).toBe("quarantine");
});

test("Microsoft selectors and a domain's own selector are read; an unknown provider needs only an SPF record", async () => {
  const microsoft = { "acme.test": ["v=spf1 include:spf.protection.outlook.com -all"], "_dmarc.acme.test": ["v=DMARC1; p=none"], "selector2._domainkey.acme.test": ["v=DKIM1; p=MIGf"] };
  expect(await report(microsoft, { provider: "microsoft" })).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "none" });
  const own = { ...GOOD, "google._domainkey.acme.test": "ENOTFOUND", "s2024._domainkey.acme.test": ["p=MIGf"] };
  expect(await report(own)).toMatchObject({ dkim: "not_found" });
  expect(await report(own, { selectors: ["s2024"] })).toMatchObject({ dkim: "pass" });
  expect(await report({ ...microsoft, "google._domainkey.acme.test": ["p=MIGf"] }, { provider: null })).toMatchObject({ spf: "pass", dkim: "pass" });
});

test("only SPF, DKIM and a DMARC record together authenticate a domain; a shared provider's domain always does", async () => {
  expect(authenticated(await report({ ...GOOD, "_dmarc.acme.test": "ENOTFOUND" }))).toBe(false);
  expect(authenticated(await report({ ...GOOD, "acme.test": ["v=spf1 -all"] }))).toBe(false);
  expect(authenticated(await report({ ...GOOD, "google._domainkey.acme.test": "ENOTFOUND" }))).toBe(false);
  expect(authenticated(await report({}, { consumer: true }))).toBe(true);
});

test("the route reads the Mailbox's own domain, with its provider's selectors, for anyone in the Workspace", async () => {
  const { routes, signIn, createOrg, call, addMember } = testIdentity();
  (routes as unknown as OpenAPIHono).route("/", outreachRoutes({ outreach: () => ({}) as never, domains: () => createMailboxDomains({ dns: dns(GOOD) }) }));
  const cookie = await signIn();
  const W = (await createOrg(cookie)).workspace.id;
  const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });
  const owner = ((await (await call("/api/me", cookie)).json()) as { user: { id: string } }).user.id;
  const made = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: "Sam@Acme.test", name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!made.ok) throw new Error(made.reason);
  const viewer = (await addMember(cookie, W, "viewer")).cookie;
  const r = await call(`/api/w/${W}/outreach/mailboxes/${made.credential.id}/domain`, viewer);
  expect(r.status).toBe(200);
  // No provider is known for this connection, so either provider's selectors count.
  expect(await r.json()).toEqual({ domain: "acme.test", consumer: false, mx: "pass", spf: "pass", dkim: "pass", dmarc: "quarantine", authenticated: true });
  expect((await call(`/api/w/${W}/outreach/mailboxes/${crypto.randomUUID()}/domain`, viewer)).status).toBe(404);
});
