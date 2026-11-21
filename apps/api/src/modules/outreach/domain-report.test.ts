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
  expect(await report({ ...GOOD, "_dmarc.acme.test": ["v=DMARC1; rua=mailto:d@acme.test"] })).toMatchObject({ dmarc: "missing" });
  expect(await report({ ...GOOD, "google._domainkey.acme.test": ["v=DKIM1; p="] })).toMatchObject({ dkim: "not_found" });
  expect(await report(GOOD, {}, "ENODATA")).toMatchObject({ mx: "missing" });
  expect(await report(GOOD, {}, [{ exchange: "." }])).toMatchObject({ mx: "missing" });
  expect(await report(GOOD, {}, "ESERVFAIL")).toMatchObject({ mx: "unknown" });
  for (const dmarc of ["none", "reject"]) expect(await report({ ...GOOD, "_dmarc.acme.test": [`v=DMARC1; p=${dmarc}`] })).toMatchObject({ dmarc });
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
