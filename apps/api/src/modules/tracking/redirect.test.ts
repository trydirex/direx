// SPDX-License-Identifier: AGPL-3.0-only
// The tracked-link redirect over HTTP (ADR 0035 rules 004, 005, 006, 009, 010 and 017): 302 to the
// stored destination only for an approved Action's link on its own host, never cached and without a
// cookie; likely automatic clicks kept apart from the rest; and counting that stops while the link
// still redirects.
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { testIdentity } from "../identity/test-auth";
import { createPerson } from "../people/index";
import { classify, countingEnded, FETCHER_LIST, PER_MINUTE } from "./domain/classify";
import { clicksOf, linkOn, ownerOf, trackingCampaign, trackingOff, useOf } from "./fixtures/campaign";
import { createRedirect, createTrackingDomains, trackingRedirectApp } from "./index";

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const NOW = new Date("2026-11-21T12:00:00Z");
let clock = NOW;
const app = trackingRedirectApp({ redirect: () => createRedirect({ now: () => clock }) });
const { signIn, createOrg } = testIdentity();
const txt = new Map<string, string>();
const domains = createTrackingDomains({ dns: { records: async (h) => ({ cname: ["t.direx.example"], txt: [txt.get(h) ?? ""] }), handshake: async () => true }, target: () => "t.direx.example" });

async function world() {
  const w = (await createOrg(await signIn())).workspace.id;
  const owner = await ownerOf(w);
  const hostname = `links${crypto.randomUUID().slice(0, 8)}.example.com`;
  const d = await domains.add(w, owner, hostname);
  if (typeof d === "string") throw new Error(d);
  txt.set(hostname, d.txtValue);
  await domains.check(w, d.id);
  const campaignId = await trackingCampaign(w, owner, d.id, { tracking: true, perPerson: true });
  const link = (destination = "https://acme.example/pricing", checkOnly = false) => linkOn(w, campaignId, d.id, destination, checkOnly);
  return { w, owner, hostname, domainId: d.id, campaignId, link };
}
const follow = (host: string, path: string, o: { method?: string; ua?: string | null } = {}) =>
  app.request(path, { method: o.method ?? "GET", headers: { host, ...(o.ua === null ? {} : { "user-agent": o.ua ?? BROWSER }) } });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const token = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

test("the fetcher list catches previews, scanners and HTTP libraries, and lets browsers through", () => {
  for (const ua of ["Slackbot-LinkExpanding 1.0", "facebookexternalhit/1.1", "Mozilla/5.0 (compatible; Googlebot/2.1)", "Barracuda Sentinel", "python-requests/2.32", "curl/8.5.0", "Mastodon/4.3 (http.rb)", "Mozilla/5.0 HeadlessChrome/120"])
    expect(FETCHER_LIST.some((f) => f.test(ua)), ua).toBe(true);
  expect(FETCHER_LIST.some((f) => f.test(BROWSER))).toBe(false);
  expect(classify({ method: "GET", userAgent: "   ", tokenSentAt: null, now: NOW })).toBe("automatic");
});

test("counting ends 12 months after the last send, and never for an unsent message", () => {
  const sent = new Date("2025-11-21T12:00:00Z");
  expect(countingEnded(sent, new Date("2026-11-21T11:59:59Z"))).toBe(false);
  expect(countingEnded(sent, NOW)).toBe(true);
  expect(countingEnded(null, NOW)).toBe(false);
});

test("an approved Action's link redirects with no-store and no cookie, and counts once as the rest", async () => {
  clock = NOW;
  const { w, hostname, link } = await world();
  const id = await link();
  await useOf(w, id, { state: "sent", sentAt: new Date("2026-11-20T09:00:00Z") });
  const r = await follow(`${hostname.toUpperCase()}:443`, `/t/${id}`);
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("https://acme.example/pricing");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(await clicksOf(w, id)).toEqual([{ day: "2026-11-21", bucket: "rest", classifier_version: 1, count: 1 }]);
});

test("unknown, malformed or unapproved links, and any other host, answer 404 and count nothing", async () => {
  clock = NOW;
  const { w, hostname, link } = await world();
  const other = await world();
  const draft = await link("https://acme.example/draft");
  await useOf(w, draft, { state: "needs_approval" });
  const held = await link("https://acme.example/held");
  await useOf(w, held, { state: "held" });
  const unused = await link("https://acme.example/unused");
  const live = await link("https://acme.example/live");
  await useOf(w, live, { state: "scheduled" });
  for (const [host, path] of [
    [hostname, `/t/${draft}`],
    [hostname, `/t/${held}`],
    [hostname, `/t/${unused}`],
    [hostname, "/t/short"],
    [hostname, `/t/${"A".repeat(22)}`],
    [other.hostname, `/t/${live}`],
    ["direx.example", `/t/${live}`],
  ] as const) {
    const r = await follow(host, path);
    expect(r.status, `${host}${path}`).toBe(404);
    expect(r.headers.get("cache-control")).toBe("no-store");
  }
  expect(await clicksOf(w, draft)).toEqual([]);
  expect(await clicksOf(w, live)).toEqual([]);
  expect((await follow(hostname, `/t/${live}`)).status).toBe(302);
});

test("HEAD, a fetcher and a missing user agent count as likely automatic; nothing about the request is kept", async () => {
  clock = NOW;
  const { w, hostname, link } = await world();
  const id = await link();
  await useOf(w, id, { state: "sent", sentAt: new Date("2026-11-01T00:00:00Z") });
  expect((await follow(hostname, `/t/${id}`, { method: "HEAD" })).status).toBe(302);
  expect((await follow(hostname, `/t/${id}`, { ua: "Slackbot-LinkExpanding 1.0" })).status).toBe(302);
  expect((await follow(hostname, `/t/${id}`, { ua: null })).status).toBe(302);
  expect((await follow(hostname, `/t/${id}`)).status).toBe(302);
  // The stored row holds a day, a bucket, a version and a count: no header, address or agent.
  expect(await clicksOf(w, id)).toEqual([
    { day: "2026-11-21", bucket: "automatic", classifier_version: 1, count: 3 },
    { day: "2026-11-21", bucket: "rest", classifier_version: 1, count: 1 },
  ]);
});

test("a token answers only on its own link, and its click within a minute of the send is likely automatic", async () => {
  const { w, hostname, link } = await world();
  const id = await link();
  const otherLink = await link("https://acme.example/other");
  const t = token();
  const personId = await createPerson(w);
  const sentAt = new Date("2026-11-21T12:00:00Z");
  await useOf(w, id, { state: "sent", sentAt, tokenHash: sha(t), personId });
  await useOf(w, otherLink, { state: "sent", sentAt });
  clock = new Date(sentAt.getTime() + 30_000);
  expect((await follow(hostname, `/t/${id}/${t}`)).status).toBe(302);
  clock = new Date(sentAt.getTime() + 61_000);
  expect((await follow(hostname, `/t/${id}/${t}`)).status).toBe(302);
  expect(await clicksOf(w, id)).toEqual([
    { day: "2026-11-21", bucket: "automatic", classifier_version: 1, count: 1 },
    { day: "2026-11-21", bucket: "rest", classifier_version: 1, count: 1 },
  ]);
  expect((await follow(hostname, `/t/${id}/${token()}`)).status).toBe(404);
  expect((await follow(hostname, `/t/${otherLink}/${t}`)).status).toBe(404);
  expect((await follow(hostname, `/t/${id}/not-a-token`)).status).toBe(404);
});

test("past 12 months, with tracking off, for a check-only link, or over the minute's limit, it still redirects but doesn't count", async () => {
  const { w, hostname, campaignId, link } = await world();
  const old = await link("https://acme.example/old");
  await useOf(w, old, { state: "sent", sentAt: new Date("2025-10-01T00:00:00Z") });
  const check = await link("https://acme.example/check", true);
  await useOf(w, check, { state: "sent", sentAt: new Date("2026-11-21T00:00:00Z") });
  const busy = await link("https://acme.example/busy");
  await useOf(w, busy, { state: "scheduled" });
  clock = NOW;
  expect((await follow(hostname, `/t/${old}`)).status).toBe(302);
  expect((await follow(hostname, `/t/${check}`)).status).toBe(302);
  expect(await clicksOf(w, old)).toEqual([]);
  expect(await clicksOf(w, check)).toEqual([]);
  for (let i = 0; i <= PER_MINUTE; i++) expect((await follow(hostname, `/t/${busy}`)).status).toBe(302);
  expect(await clicksOf(w, busy)).toEqual([{ day: "2026-11-21", bucket: "rest", classifier_version: 1, count: PER_MINUTE }]);
  // The next minute counts again.
  clock = new Date(NOW.getTime() + 60_000);
  await follow(hostname, `/t/${busy}`);
  expect(await clicksOf(w, busy)).toEqual([{ day: "2026-11-21", bucket: "rest", classifier_version: 1, count: PER_MINUTE + 1 }]);
  await trackingOff(w, campaignId);
  expect((await follow(hostname, `/t/${busy}`)).status).toBe(302);
  expect(await clicksOf(w, busy)).toEqual([{ day: "2026-11-21", bucket: "rest", classifier_version: 1, count: PER_MINUTE + 1 }]);
});

test("a stopped domain keeps answering for links already sent", async () => {
  clock = NOW;
  const { w, hostname, domainId, link } = await world();
  const id = await link();
  await useOf(w, id, { state: "sent", sentAt: new Date("2026-11-20T00:00:00Z") });
  await domains.stop(w, domainId);
  expect((await follow(hostname, `/t/${id}`)).status).toBe(302);
});
