// SPDX-License-Identifier: AGPL-3.0-only
// Logging a touch Direx didn't send, over HTTP: what is refused, what is listed, and the 10-minute undo.
import { OpenAPIHono } from "@hono/zod-openapi";
import { expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { createItems } from "../items/index";
import { TEST_SECRET, testIdentity, testLedger } from "./fixtures/support";
import { createOutreach, createOutsideTouches, outreachRoutes, type ReplyStop } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;

const { clock, ledger } = await testLedger();
const items = createItems({ ledger, now: () => clock.at });
const outreach = createOutreach({ items: () => items, send: () => { throw new Error("no sending here"); }, baseUrl: () => "https://direx.example", ledger: () => ledger, now: () => clock.at });
const marked: string[][] = [];
const replies: ReplyStop = { mark: async (_tx, ids) => (marked.push([...ids]), []), cancel: async () => {} };
const touches = createOutsideTouches({ replies: () => replies, now: () => clock.at });

const { routes, signIn, createOrg, call } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", outreachRoutes({ outreach: () => outreach, outsideTouches: () => touches }));
const cookie = await signIn();
const W = (await createOrg(cookie, "Acme")).workspace.id;
const req = async <T>(path: string, method: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const r = await call(`/api/w/${W}${path}`, cookie, body === undefined ? { method } : { method, body });
  return { status: r.status, body: (r.status === 204 ? null : await r.json()) as T };
};
type Touch = { id: string; channel: string; direction: string; occurredAt: string; source: string; canDelete: boolean };

const newPerson = async () =>
  (await req<{ id: string }>("/outreach/people", "POST", { email: `${crypto.randomUUID()}@example.com`, country: "GB", basis: "published_address", evidence: "their site" })).body.id;
const path = (p: string) => `/outreach/people/${p}/outside-touches`;

test("a call is logged and listed; a time in the future or an unknown Person is refused", async () => {
  const p = await newPerson();
  const at = new Date(clock.at.getTime() - 60 * 60_000).toISOString();
  const logged = await req<Touch>(path(p), "POST", { channel: "call", direction: "outbound", occurredAt: at });
  expect(logged.status).toBe(201);
  expect(logged.body).toMatchObject({ channel: "call", direction: "outbound", occurredAt: at, source: "manual", canDelete: true });

  const later = new Date(clock.at.getTime() + 5 * 60_000).toISOString();
  expect(await req(path(p), "POST", { channel: "call", direction: "outbound", occurredAt: later })).toMatchObject({ status: 400, body: { error: "in_future" } });
  expect((await req(path(crypto.randomUUID()), "POST", { channel: "call", direction: "outbound", occurredAt: at })).status).toBe(404);
  expect((await req(path(p), "POST", { channel: "fax", direction: "outbound", occurredAt: at })).status).toBe(400);

  const list = await req<{ touches: Touch[] }>(path(p), "GET");
  expect(list.body.touches.map((t) => t.id)).toEqual([logged.body.id]);
  expect(marked).toHaveLength(0);
});

test("a saved profile is listed with the Person's touches, so the form shows it when opened again", async () => {
  const p = await newPerson();
  expect(await req(path(p), "GET")).toMatchObject({ status: 200, body: { profiles: [] } });
  expect(await req(`/outreach/people/${p}/profiles`, "POST", { kind: "linkedin", url: "linkedin.com/in/Kim-Lee" })).toMatchObject({ status: 200, body: { url: "https://www.linkedin.com/in/kim-lee" } });
  expect((await req(path(p), "GET")).body).toMatchObject({ profiles: [{ kind: "linkedin", url: "https://www.linkedin.com/in/kim-lee" }] });
});

test("a logged reply stops the whole Person group in its campaigns", async () => {
  const p = await newPerson();
  expect((await req(path(p), "POST", { channel: "linkedin", direction: "inbound", occurredAt: clock.at.toISOString() })).status).toBe(201);
  expect(marked.at(-1)).toEqual([p]);
});

test("a manual entry can be removed for 10 minutes, then it stays", async () => {
  const p = await newPerson();
  const first = (await req<Touch>(path(p), "POST", { channel: "call", direction: "outbound", occurredAt: clock.at.toISOString() })).body;
  expect((await req(`${path(p)}/${first.id}`, "DELETE")).status).toBe(204);
  expect((await req(`${path(p)}/${first.id}`, "DELETE")).status).toBe(404);

  const second = (await req<Touch>(path(p), "POST", { channel: "call", direction: "outbound", occurredAt: clock.at.toISOString() })).body;
  // The window runs on wall time, so the row is aged rather than the clock moved.
  const owner = await ownerClient();
  try {
    await owner.query("update outside_touches set created_at = now() - interval '11 minutes' where id = $1", [second.id]);
  } finally {
    await owner.end();
  }
  expect((await req<{ touches: Touch[] }>(path(p), "GET")).body.touches[0]).toMatchObject({ id: second.id, canDelete: false });
  expect(await req(`${path(p)}/${second.id}`, "DELETE")).toMatchObject({ status: 409, body: { error: "too_late" } });
});
