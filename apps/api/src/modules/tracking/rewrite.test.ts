// SPDX-License-Identifier: AGPL-3.0-only
// Rewriting a Campaign step's links (ADR 0035 rules 001, 004, 011 to 013): which URLs are tracked, one
// link per step and destination, a per-Person token only for a US Person whose country a person
// stated and only while the per-Person switch is on, and plain text whenever the Campaign doesn't track.
import { expect, test } from "vitest";
import { testIdentity } from "../identity/test-auth";
import { createPerson } from "../people/index";
import { MAX_DESTINATION, rewriteLinks } from "./domain/rewrite";
import { ownerOf, personCountry, trackingCampaign } from "./fixtures/campaign";
import { createTrackingDomains, fixLinks } from "./index";

const tracked = (d: string) => `<${d}>`;

test.each([
  ["a bare URL", "See https://acme.example/pricing today", "See <https://acme.example/pricing> today"],
  ["a Markdown link", "[Pricing](https://acme.example/pricing)", "[Pricing](<https://acme.example/pricing>)"],
  ["a URL ending a sentence", "Read https://acme.example/a.", "Read <https://acme.example/a>."],
  ["brackets the URL opened", "https://en.example/wiki/A_(b)", "<https://en.example/wiki/A_(b)>"],
  ["an angle-bracket link", "<https://acme.example/x>", "<<https://acme.example/x>>"],
  ["a URL with a query", "https://acme.example/?a=1&b=2, then", "<https://acme.example/?a=1&b=2>, then"],
])("%s is tracked", (_, text, out) => {
  expect(rewriteLinks(text, tracked).text).toBe(out);
});

test.each([
  ["http", "Visit http://acme.example/a now"],
  ["a mail address", "Write to sam@acme.example"],
  ["a URL that doesn't parse", "https://exa%zz mple"],
  ["a URL too long to store", `https://acme.example/${"a".repeat(MAX_DESTINATION)}`],
])("%s stays as written", (_, text) => {
  expect(rewriteLinks(text, tracked)).toEqual({ text, destinations: [] });
});

test("each destination is listed once, in order, and one the caller skips stays as written", () => {
  const r = rewriteLinks("https://b.example/ and https://a.example/ and https://b.example/", (d) => (d.startsWith("https://a.") ? null : "T"));
  expect(r).toEqual({ text: "T and https://a.example/ and T", destinations: ["https://b.example/", "https://a.example/"] });
});

const { signIn, createOrg } = testIdentity();
const txt = new Map<string, string>();
const domains = createTrackingDomains({ dns: { records: async (h) => ({ cname: ["t.direx.example"], txt: [txt.get(h) ?? ""] }), handshake: async () => true }, target: () => "t.direx.example" });

type Switches = { tracking?: boolean; perPerson?: boolean; state?: "verified" | "pending" | "stopped" };
async function world(s: Switches = {}) {
  const cookie = await signIn();
  const w = (await createOrg(cookie)).workspace.id;
  const owner = await ownerOf(w);
  const hostname = `links${crypto.randomUUID().slice(0, 8)}.example.com`;
  const added = await domains.add(w, owner, hostname);
  if (typeof added === "string") throw new Error(added);
  txt.set(hostname, added.txtValue);
  if (s.state !== "pending") await domains.check(w, added.id);
  if (s.state === "stopped") await domains.stop(w, added.id);
  const campaignId = await trackingCampaign(w, owner, added.id, { tracking: s.tracking ?? true, perPerson: s.perPerson ?? false });
  const person = async (country?: string, confidence: "stated" | "inferred" = "stated") => {
    const id = await createPerson(w);
    if (country) await personCountry(w, owner, id, country, confidence);
    return id;
  };
  const fix = (personId: string, text: string, stepKey = "s1") => fixLinks(w, { campaignId, stepKey, personId, text, now: new Date() });
  return { w, hostname, person, fix };
}

const LINK = /^https:\/\/([^/]+)\/t\/([A-Za-z0-9_-]{22})(?:\/([A-Za-z0-9_-]{43}))?$/;

test("a tracking Campaign's links move onto its domain, one link per step and destination", async () => {
  const { hostname, person, fix } = await world();
  const p = await person("FR");
  const a = (await fix(p, "Try https://acme.example/a and [this](https://acme.example/a), or http://acme.example/b"))!;
  const url = a.text.split(" ")[1]!;
  const [, host, linkId, token] = LINK.exec(url)!;
  expect(host).toBe(hostname);
  expect(token).toBeUndefined();
  expect(a.text).toBe(`Try ${url} and [this](${url}), or http://acme.example/b`);
  expect(a).toMatchObject({ perRecipient: false, uses: [{ linkId, tokenHash: null, personId: null }] });
  // Another recipient of the step gets the same link; another step gets its own.
  expect((await fix(await person(), "https://acme.example/a"))!.text).toBe(url);
  expect((await fix(p, "https://acme.example/a", "s2"))!.text).not.toBe(url);
  // A link already on the domain isn't wrapped again.
  expect(await fix(p, `Again: ${url}`)).toMatchObject({ text: `Again: ${url}`, uses: [] });
});

test("only a US Person whose country a person stated gets a token, and only while per-Person is on", async () => {
  const on = await world({ perPerson: true });
  const us = await on.person("US");
  const a = (await on.fix(us, "https://acme.example/a and https://acme.example/b"))!;
  expect(a.perRecipient).toBe(true);
  const tokens = a.text.split(" and ").map((u) => LINK.exec(u)![3]);
  expect(tokens.every((t) => typeof t === "string")).toBe(true);
  expect(new Set(tokens).size).toBe(2);
  expect(a.uses.every((u) => /^[0-9a-f]{64}$/.test(u.tokenHash!) && u.personId === us)).toBe(true);
  for (const p of [await on.person("US", "inferred"), await on.person("CA"), await on.person()]) {
    const r = (await on.fix(p, "https://acme.example/a"))!;
    expect(r.perRecipient).toBe(false);
    expect(LINK.exec(r.text)![3]).toBeUndefined();
  }
  // No link, no token, so no line either.
  expect(await on.fix(us, "No links here")).toMatchObject({ text: "No links here", perRecipient: false, uses: [] });
  const off = await world();
  expect((await off.fix(await off.person("US"), "https://acme.example/a"))!.perRecipient).toBe(false);
});

test("the inputs hash changes with what the links depend on", async () => {
  const { person, fix } = await world({ perPerson: true });
  const hashOf = async (country?: string, confidence?: "stated" | "inferred") => (await fix(await person(country, confidence), "https://acme.example/a"))!.inputsHash;
  const us = await hashOf("US");
  expect(await hashOf("US")).toBe(us);
  expect(new Set([us, await hashOf("US", "inferred"), await hashOf("FR"), await hashOf()]).size).toBe(4);
});

test.each<[string, Switches]>([
  ["tracking off", { tracking: false }],
  ["a domain not yet checked", { state: "pending" }],
  ["a stopped domain", { state: "stopped" }],
])("%s leaves the text as written", async (_, s) => {
  const { person, fix } = await world(s);
  expect(await fix(await person("US"), "https://acme.example/a")).toBeNull();
});

test("no such Campaign leaves the text as written", async () => {
  const { w, person } = await world();
  expect(await fixLinks(w, { campaignId: crypto.randomUUID(), stepKey: "s1", personId: await person(), text: "https://acme.example/a", now: new Date() })).toBeNull();
});
