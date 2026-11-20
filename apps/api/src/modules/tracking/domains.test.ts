// SPDX-License-Identifier: AGPL-3.0-only
// Tracking domains through identity's real sign-in (ADR 0035 rules 007 and 008): who may manage them,
// a hostname unique on the server, a check that needs both DNS records and then a handshake and never
// moves a domain back, stop and remove, and the edge's ask answering yes only for checked hosts.
import { expect, test } from "vitest";
import { testIdentity } from "../identity/test-auth";
import { campaignUsingDomain } from "./fixtures/campaign";
import { createTrackingDomains, trackingAskApp, trackingRoutes, type DnsLookup } from "./index";

const TARGET = "track.direx.example";
const dnsFor = new Map<string, { cname: string[]; txt: string[] }>();
let handshakeOk = false;
const dns: DnsLookup = { records: async (h) => dnsFor.get(h) ?? { cname: [], txt: [] }, handshake: async () => handshakeOk };
const domains = createTrackingDomains({ dns, target: () => TARGET });
const unconfigured = createTrackingDomains({ dns, target: () => null });
const { routes, call, signIn, createOrg, addMember } = testIdentity();
routes.route("/", trackingRoutes({ domains: () => domains }));
const ask = trackingAskApp({ domains: () => domains });

type View = { id: string; hostname: string; state: string; cnameTarget: string | null; txtName: string; txtValue: string; checkedAt: string | null };
const api = (w: string, rest = "") => `/api/w/${w}/tracking/domains${rest}`;
const host = () => `links${crypto.randomUUID().slice(0, 8)}.example.com`;
const asks = async (h: string) => (await ask.request(`/ask?domain=${encodeURIComponent(h)}`)).status;

async function world() {
  const owner = await signIn();
  const w = (await createOrg(owner)).workspace.id;
  return { owner, w };
}
async function add(w: string, cookie: string, hostname: string): Promise<View> {
  const res = await call(api(w), cookie, { method: "POST", body: { hostname } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { domain: View }).domain;
}
const check = async (w: string, cookie: string, id: string) => ((await (await call(api(w, `/${id}/check`), cookie, { method: "POST" })).json()) as { result?: string }).result;
const list = async (w: string, cookie: string) => ((await (await call(api(w), cookie)).json()) as { domains: View[] }).domains;

test("an Admin adds a domain and sees the records to set; a Marketer can't manage domains", async () => {
  const { owner, w } = await world();
  const hostname = host();
  const d = await add(w, owner, `  ${hostname.toUpperCase()}. `);
  expect(d).toMatchObject({ hostname, state: "pending", cnameTarget: TARGET, txtName: `_direx-tracking.${hostname}`, checkedAt: null });
  expect(d.txtValue).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(await list(w, owner)).toEqual([d]);
  const m = await addMember(owner, w, "marketer");
  expect((await call(api(w), m.cookie)).status).toBe(403);
  expect((await call(api(w), m.cookie, { method: "POST", body: { hostname: host() } })).status).toBe(403);
});

test("a hostname must be one, belongs to one Workspace on the server, and needs a tracking target", async () => {
  const a = await world();
  const b = await world();
  expect((await call(api(a.w), a.owner, { method: "POST", body: { hostname: "localhost" } })).status).toBe(400);
  const taken = host();
  await add(a.w, a.owner, taken);
  const again = await call(api(b.w), b.owner, { method: "POST", body: { hostname: taken } });
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: "taken" });
  expect(await unconfigured.add(a.w, crypto.randomUUID(), host())).toBe("not_configured");
});

test("a check needs both records, commits dns_ok before the handshake, and verifies only on a good handshake", async () => {
  const { owner, w } = await world();
  const hostname = host();
  const d = await add(w, owner, hostname);
  expect(await asks(hostname)).toBe(404);

  dnsFor.set(hostname, { cname: [`${TARGET}.`], txt: ["something else"] });
  expect(await check(w, owner, d.id)).toBe("dns_mismatch");
  expect((await list(w, owner))[0]).toMatchObject({ state: "pending", checkedAt: expect.any(String) });

  dnsFor.set(hostname, { cname: [TARGET.toUpperCase()], txt: [d.txtValue] });
  handshakeOk = false;
  expect(await check(w, owner, d.id)).toBe("dns_ok");
  expect((await list(w, owner))[0]!.state).toBe("dns_ok");
  expect(await asks(hostname)).toBe(200);
  expect(await asks(hostname.toUpperCase())).toBe(200);

  handshakeOk = true;
  expect(await check(w, owner, d.id)).toBe("verified");
  expect(await asks(hostname)).toBe(200);

  // DNS that later stops matching is reported, and the domain stays verified so sent links keep working.
  dnsFor.delete(hostname);
  expect(await check(w, owner, d.id)).toBe("dns_mismatch");
  expect((await list(w, owner))[0]!.state).toBe("verified");
  expect(await unconfigured.check(w, d.id)).toBe("not_configured");
  expect(await check(w, owner, crypto.randomUUID())).toBeUndefined();
});

test("a stopped domain takes no checks and gets no certificates; one in use can't be removed", async () => {
  const { owner, w } = await world();
  const hostname = host();
  const d = await add(w, owner, hostname);
  dnsFor.set(hostname, { cname: [TARGET], txt: [d.txtValue] });
  handshakeOk = false;
  await check(w, owner, d.id);
  expect((await call(api(w, `/${d.id}/stop`), owner, { method: "POST" })).status).toBe(200);
  expect(await check(w, owner, d.id)).toBe("stopped");
  expect(await asks(hostname)).toBe(404);

  const used = await add(w, owner, host());
  const me = ((await (await call("/api/me", owner)).json()) as { user: { id: string } }).user.id;
  await campaignUsingDomain(w, me, used.id);
  const refused = await call(api(w, `/${used.id}`), owner, { method: "DELETE" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "in_use" });
  expect((await call(api(w, `/${d.id}`), owner, { method: "DELETE" })).status).toBe(200);
  expect((await list(w, owner)).map((x) => x.id)).toEqual([used.id]);
  expect((await call(api(w, `/${d.id}`), owner, { method: "DELETE" })).status).toBe(404);
  expect((await call(api(w, `/${d.id}/stop`), owner, { method: "POST" })).status).toBe(404);
  expect((await call(api(w, `/${crypto.randomUUID()}/check`), owner, { method: "POST" })).status).toBe(404);
});

test("the ask refuses what isn't a hostname, and knows nothing of unknown hosts", async () => {
  expect(await asks("")).toBe(404);
  expect(await asks("not a host")).toBe(404);
  expect(await asks("links.example.com:8443")).toBe(404);
  expect(await asks("user@links.example.com")).toBe(404);
  expect(await asks(host())).toBe(404);
  expect((await ask.request("/ask")).status).toBe(404);
});
