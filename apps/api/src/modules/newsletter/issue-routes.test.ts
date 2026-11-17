// SPDX-License-Identifier: AGPL-3.0-only
// The weekly issue's routes over HTTP: reading one, saving it, sending it for approval and marking it sent
// by hand, with a refusal as 404 or 409 and a bad title refused before the desk sees it. The desk is a
// stand-in here; what it does is covered by the issue tests.
import type { OpenAPIHono } from "@hono/zod-openapi";
import { expect, test } from "vitest";
import { TEST_SECRET, testIdentity } from "./fixtures/support";
import type { IssueView } from "./application/issues";
import { newsletterRoutes, type IssueDesk } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const ITEM = "00000000-0000-4000-8000-0000000000c1";
const MISSING = "00000000-0000-4000-8000-0000000000c2";
const view: IssueView = {
  item: { id: ITEM, state: "needs_approval", at: new Date("2026-11-10T08:00:00Z"), warnings: [], revision: 2 } as never,
  slot: "2026-11-10T08:00:00.000Z",
  title: "Week 46",
  previewText: "",
  markdown: "Hello.",
  html: "<p>Hello.</p>",
  handoffTo: null,
  sentAt: null,
  stats: null,
  statsReadAt: null,
};
const out = { itemId: ITEM, state: "needs_approval", approveBy: "2026-11-10T08:00:00.000Z", warnings: [], revision: 2, slot: view.slot, title: "Week 46", previewText: "", markdown: "Hello.", html: "<p>Hello.</p>", handoffTo: null, sentAt: null, stats: null, statsReadAt: null };
/** Answers for ITEM; anything else is not found, and `refuse` makes ITEM's writes refuse with it. */
let refuse: string | null = null;
const calls: unknown[][] = [];
const answer = (itemId: string) => (itemId !== ITEM ? { ok: false as const, reason: "not_found" } : refuse ? { ok: false as const, reason: refuse } : { ok: true as const, issue: view });
const page = { issues: [{ itemId: ITEM, slot: view.slot, title: "Week 46", state: "needs_approval", reason: null, sentAt: null, stats: null }], next: null };
const desk = {
  list: async (...a: unknown[]) => (calls.push(["list", ...a]), page),
  get: async (_ws: string, itemId: string) => (itemId === ITEM ? view : null),
  revise: async (...a: unknown[]) => (calls.push(["revise", ...a]), answer(a[1] as string)),
  submit: async (...a: unknown[]) => (calls.push(["submit", ...a]), answer(a[1] as string)),
  markSent: async (...a: unknown[]) => (calls.push(["markSent", ...a]), answer(a[1] as string)),
} as unknown as IssueDesk;

const { routes, signIn, createOrg, call } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", newsletterRoutes({ newsletter: () => { throw new Error("no settings here"); }, issues: () => desk }));
const cookie = await signIn();
const W = (await createOrg(cookie, "Letters")).workspace.id;
const issue = (id: string, tail = "", init?: { method: string; body?: unknown }) => call(`/api/w/${W}/newsletter/issues/${id}${tail}`, cookie, init);

test("the issue list pages from `before`, ten at a time unless asked, and refuses a page over 50", async () => {
  calls.length = 0;
  const first = await call(`/api/w/${W}/newsletter/issues`, cookie);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual(page);
  expect((await call(`/api/w/${W}/newsletter/issues?before=2026-11-10T08:00:00.000Z&limit=5`, cookie)).status).toBe(200);
  expect(calls).toEqual([
    ["list", W, null, 10],
    ["list", W, new Date("2026-11-10T08:00:00.000Z"), 5],
  ]);
  expect((await call(`/api/w/${W}/newsletter/issues?limit=51`, cookie)).status).toBe(400);
});

test("one issue reads as written and as it will be sent; one that isn't there is not found", async () => {
  const r = await issue(ITEM);
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual(out);
  const missing = await issue(MISSING);
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({ error: "not_found" });
});

test("saving, submitting and marking sent answer with the issue, as the signed-in person", async () => {
  refuse = null;
  calls.length = 0;
  const saved = await issue(ITEM, "", { method: "PUT", body: { title: "Week 46", previewText: "This week", markdown: "Hello." } });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual(out);
  expect((await issue(ITEM, "/submit", { method: "POST" })).status).toBe(200);
  expect((await issue(ITEM, "/sent", { method: "POST" })).status).toBe(200);
  expect(calls.map((c) => c[0])).toEqual(["revise", "submit", "markSent"]);
  expect(calls[0]![3]).toEqual({ title: "Week 46", previewText: "This week", markdown: "Hello." });
  // Each write names who made it.
  const who = calls[0]![4];
  expect(typeof who).toBe("string");
  expect(calls.every((c) => c.at(-1) === who)).toBe(true);
});

test("a write the desk refuses is 404 when the issue is gone and 409 otherwise, with its reason", async () => {
  refuse = "already_sent";
  for (const [tail, init] of [["", { method: "PUT", body: { title: "Week 46", markdown: "Hello." } }], ["/submit", { method: "POST" }], ["/sent", { method: "POST" }]] as const) {
    const refused = await issue(ITEM, tail, init);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "already_sent" });
    const gone = await issue(MISSING, tail, init);
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: "not_found" });
  }
  refuse = null;
});

test("a title or preview text over two lines, or an empty issue, is refused before the desk sees it", async () => {
  calls.length = 0;
  for (const body of [{ title: "Week\n46", markdown: "Hello." }, { title: "Week 46", previewText: "one\rtwo", markdown: "Hello." }, { title: "  ", markdown: "Hello." }, { title: "Week 46", markdown: "" }]) {
    const r = await issue(ITEM, "", { method: "PUT", body });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toEqual(expect.any(String));
  }
  expect(calls).toEqual([]);
});
