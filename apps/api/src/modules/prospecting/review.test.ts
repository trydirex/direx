// SPDX-License-Identifier: AGPL-3.0-only
// The company review Item over HTTP: made once a company's read and names are settled, never approved in
// bulk, and decided by a person who keeps addresses or rejects the company. Sites are fake and the
// names run is a stub; the database, the ledger, items and the item routes are real.
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient } from "../../../../../test/db";
import { createBoss } from "../../jobs/boss";
import { createFetchHtml } from "../agents/index";
import { createOutreach } from "../outreach/index";
import { addKey, createPerson } from "../people/index";
import { actionIdOf, itemsApp } from "./fixtures/support";
import { COMPANY_VERIFY_QUEUE, companyReviews, createCompanyReader, NAMES_OUTPUT_KEY, namesEnded, namesSink, prospectKinds, REJECTED_KEEP_DAYS, REVIEW_KIND, REVIEW_WARNING, type ReviewPayload, type StartNames } from "./index";

const NOW = new Date("2026-11-02T12:00:00Z");
const boss = createBoss();
await boss.start();
await boss.createQueue(COMPANY_VERIFY_QUEUE);
afterAll(() => boss.stop({ graceful: false, close: true }));
const { items, ledger, call, signIn, createOrg, addMember } = await itemsApp({ kinds: prospectKinds({ boss, now: () => NOW }) });
const verifyJobs = async (companyId: string) => (await boss.findJobs(COMPANY_VERIFY_QUEUE, { data: { companyId } })).map((j) => j.data);
const reviews = companyReviews({ items: () => items, now: () => NOW });
const owner = await signIn();
const W = (await createOrg(owner)).workspace.id;
const U = ((await (await call("/api/me", owner)).json()) as { user: { id: string } }).user.id;
const outreach = createOutreach({ items: () => items, send: () => undefined, baseUrl: () => "http://localhost" });
let c: Awaited<ReturnType<typeof appClient>>;
let runId: string;

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  await c.query("begin");
  try {
    await c.query("select set_config('app.workspace_id', $1, true)", [W]);
    const r = await c.query(text, params);
    await c.query("commit");
    return r.rows as T[];
  } catch (e) {
    await c.query("rollback");
    throw e;
  }
}

beforeAll(async () => {
  c = await appClient();
  runId = (
    await q<{ id: string }>(
      `insert into prospect_runs (workspace_id, source, signals, company_limit, confirmed_micros, confirmed_by, created_at, updated_at)
       values ($1, 'pasted', '{hiring}', 10, 0, $2, now(), now()) returning id`,
      [W, U],
    )
  )[0]!.id;
});
afterAll(() => c.end());

const FILLER = "<p>We are a firm of chartered accountants serving owner-managed businesses with tax, audit and advisory work.</p>";

/** A firm's site on its own domain, read with the given names start, and the company it was read for. */
async function readFirm(domain: string, opts: { start?: StartNames; robots?: string } = {}) {
  const pages: Record<string, string> = {
    "/robots.txt": opts.robots ?? "User-agent: *\nAllow: /",
    "/": `<html><body><nav><a href="/team">Team</a><a href="/contact">Contact</a><a href="/careers">Careers</a></nav>${FILLER}</body></html>`,
    "/team": `<h1>Our team</h1><p>Jane Doe, Managing Partner</p><a href="mailto:jane.doe@${domain}">Email Jane</a>`,
    "/contact": `<h1>Contact</h1><address>12 King Street West<br>Toronto, ON M5H 1A1<br>Canada</address>
      <p>New business: sales@${domain}. Say hi: hello@${domain}. General questions: info@${domain}. Our bookkeeper: books@partner.test</p>`,
    "/careers": `<h1>Careers</h1><p>We're hiring a senior accountant to join our Toronto office.</p>`,
  };
  const id = (
    await q<{ id: string }>(
      `insert into prospect_companies (workspace_id, domain, website, first_run_id, created_at, updated_at) values ($1, $2, $3, $4, now(), now()) returning id`,
      [W, domain, `https://${domain}/`, runId],
    )
  )[0]!.id;
  const reader = createCompanyReader({
    fetchHtml: createFetchHtml({
      maxChars: Infinity,
      resolve: async () => [{ address: "93.184.216.34" }],
      request: async (url) => {
        const page = pages[url.pathname];
        if (page === undefined) return new Response("not here", { status: 404, headers: { "content-type": "text/html" } });
        return new Response(page, { headers: { "content-type": url.pathname === "/robots.txt" ? "text/plain" : "text/html" } });
      },
    }),
    startNames: opts.start ?? (async () => ({ ok: true })),
    openReview: reviews.open,
    now: () => NOW,
  });
  await reader.read({ workspaceId: W, companyId: id });
  return { id, again: () => reader.read({ workspaceId: W, companyId: id }) };
}

const sink = namesSink(() => NOW, reviews.open);
/** What the agents module does when a names run proposes Jane Doe for this company. */
async function janeHandedOver(companyId: string) {
  const run = (
    await q<{ id: string }>(
      `insert into agent_runs (workspace_id, idempotency_key, agent, definition_version, prompt_revision, prompt_digest, tool_set_digest, trigger, status, deadline_ms, step_cap, cost_cap_micros, input, created_at, updated_at)
       values ($1, gen_random_uuid()::text, 'names_reader', 1, 'r', 'd', 'd', 'person', 'queued', 1000, 1, 1, '{}', now(), now()) returning id`,
      [W],
    )
  )[0]!.id;
  return sink(W, { kind: "draft", outputKey: NAMES_OUTPUT_KEY, body: { schemaVersion: 1, people: [{ first: "Jane", last: "Doe", role: "Managing Partner" }] } }, { runId: run, input: { companyId }, tainted: true, pagesRead: [], pages: [], producer: { agent: "names_reader", definitionVersion: 1, promptDigest: "d", routeHash: "r" } });
}

const reviewsOf = (companyId: string) => q<{ id: string }>(`select id from items where kind = $1 and payload ->> 'companyId' = $2`, [REVIEW_KIND, companyId]);
const company = async (id: string) => (await q<{ state: string; review_item_id: string | null }>("select state, review_item_id from prospect_companies where id = $1", [id]))[0]!;
const leftOut = async (id: string) =>
  Object.fromEntries((await q<{ email: string; left_out_reason: string | null }>("select email, left_out_reason from prospect_addresses where company_id = $1", [id])).map((r) => [r.email.split("@")[0], r.left_out_reason]));
type Detail = { item: { id: string; state: string; revision: number; warnings: { code: string; text: string }[]; clean: boolean }; content: ReviewPayload };
const detail = async (itemId: string, cookie = owner) => (await (await call(`/api/w/${W}/items/${itemId}`, cookie)).json()) as Detail;
const approve = (itemId: string, choice: string | undefined, cookie = owner) => call(`/api/w/${W}/items/${itemId}/approve`, cookie, { method: "POST", body: { revision: 1, ...(choice !== undefined && { choice }) } });
const REJECT_CHOICE = "reject";
const positionOf = (p: ReviewPayload, local: string) => p.addresses.findIndex((a) => a.email.startsWith(`${local}@`));

test("names done: one Item, made by the names hand-over, and a retried hand-over or read makes no second", async () => {
  const firm = await readFirm("done.test");
  expect(await reviewsOf(firm.id)).toEqual([]);

  const handed = await janeHandedOver(firm.id);
  const [made] = await reviewsOf(firm.id);
  expect(handed).toEqual({ ok: true, itemId: made!.id });
  expect(await company(firm.id)).toEqual({ state: "in_review", review_item_id: made!.id });

  expect(await janeHandedOver(firm.id)).toEqual({ ok: true, itemId: made!.id });
  await firm.again();
  expect(await reviews.open(W, firm.id)).toBe(made!.id);
  expect(await reviewsOf(firm.id)).toEqual([{ id: made!.id }]);

  const { item, content } = await detail(made!.id);
  expect(item).toMatchObject({ state: "needs_approval", warnings: [{ code: "untrusted_source", text: REVIEW_WARNING }], clean: false });
  expect(content).toMatchObject({ companyId: firm.id, domain: "done.test", country: { code: "CA", quote: "Toronto, ON M5H 1A1" }, names: { status: "done", reason: null } });
  expect(content.signals).toEqual([{ type: "hiring", quote: expect.stringContaining("hiring a senior accountant"), pageUrl: "https://done.test/careers", observedOn: expect.any(String) }]);
  const shown = Object.fromEntries(content.addresses.map((a) => [a.email, [a.kind, a.name, a.role, a.leftOut]]));
  expect(shown).toEqual({
    "jane.doe@done.test": ["named", "Jane Doe", "Managing Partner", null],
    "sales@done.test": ["function", null, null, null],
    "hello@done.test": ["function", null, null, null],
    "info@done.test": ["generic", null, null, "generic_address"],
    "books@partner.test": ["unknown", null, null, "other_domain"],
  });
  const jane = content.addresses[positionOf(content, "jane.doe")]!;
  expect(jane).toMatchObject({ pageUrl: "https://done.test/team", readAt: NOW.toISOString(), snapshotId: expect.any(String), personId: null });
  // What a person may keep comes first.
  expect(content.addresses.slice(0, 3).every((a) => a.leftOut === null)).toBe(true);
});

test("names skipped: the Item is made at the end of the read; a site not read gets none", async () => {
  const skipped = await readFirm("skipped.test", { start: async () => ({ ok: false, reason: "no_route" }) });
  const [made] = await reviewsOf(skipped.id);
  expect((await detail(made!.id)).content.names).toEqual({ status: "skipped", reason: "no_route" });
  // Without a name, Jane's address could be anyone's.
  const jane = (await detail(made!.id)).content.addresses.find((a) => a.email.startsWith("jane.doe@"));
  expect(jane).toMatchObject({ kind: "unknown", leftOut: "no_known_person" });

  const blocked = await readFirm("blocked.test", { robots: "User-agent: *\nDisallow: /" });
  expect(await reviewsOf(blocked.id)).toEqual([]);
  expect(await reviews.open(W, blocked.id)).toBeNull();
  expect(await company(blocked.id)).toEqual({ state: "new", review_item_id: null });
});

test("a capped names run settles the names and makes the Item", async () => {
  const firm = await readFirm("capped.test");
  expect(await reviewsOf(firm.id)).toEqual([]);
  await namesEnded({ workspaceId: W, agent: "names_reader", status: "cost_capped", input: { companyId: firm.id } }, NOW, reviews.open);
  await namesEnded({ workspaceId: W, agent: "names_reader", status: "cost_capped", input: { companyId: firm.id } }, NOW, reviews.open);
  const made = await reviewsOf(firm.id);
  expect(made).toHaveLength(1);
  expect((await detail(made[0]!.id)).content.names).toEqual({ status: "skipped", reason: "cost_capped" });
});

test("an Item made but never linked, as after a crash, is linked on the retry instead of made again", async () => {
  const firm = await readFirm("crash.test");
  await q("update prospect_companies set names_status = 'skipped', names_reason = 'no_route' where id = $1", [firm.id]);
  const first = await reviews.open(W, firm.id);
  await q("update prospect_companies set review_item_id = null, state = 'new' where id = $1", [firm.id]);
  expect(await reviews.open(W, firm.id)).toBe(first);
  expect(await reviewsOf(firm.id)).toEqual([{ id: first }]);
  expect(await company(firm.id)).toEqual({ state: "in_review", review_item_id: first });
});

test("approve all clean refuses it, a left-out address can't be kept, and keeping ends Applied with the choice stored", async () => {
  const firm = await readFirm("accept.test");
  const { itemId } = (await janeHandedOver(firm.id)) as { itemId: string };
  const { content } = await detail(itemId);

  const bulk = await call(`/api/w/${W}/items/approve-clean`, owner, { method: "POST", body: { items: [{ id: itemId, revision: 1 }] } });
  expect(await bulk.json()).toEqual({ results: [{ id: itemId, ok: false, reason: "not_clean" }] });

  const generic = await approve(itemId, `${positionOf(content, "jane.doe")},${positionOf(content, "info")}`);
  expect(generic.status).toBe(409);
  expect(await generic.json()).toEqual({ error: "address_left_out" });
  expect(await (await approve(itemId, "99")).json()).toEqual({ error: "unknown_address" });
  expect(await (await approve(itemId, undefined)).json()).toEqual({ error: "choice_required" });
  expect(await (await approve(itemId, "jane")).json()).toEqual({ error: "choice_required" });
  // A long list is a choice like any other: positions past the first dozen still reach the review.
  expect(await (await approve(itemId, Array.from({ length: 60 }, (_, i) => i + 100).join(","))).json()).toEqual({ error: "unknown_address" });
  // Dismissing would strand the company in review, so it's refused; Reject is the way out.
  expect(await (await call(`/api/w/${W}/items/${itemId}/cancel`, owner, { method: "POST" })).json()).toEqual({ error: "choice_required" });
  // Jane's address is published and the firm is in Canada, so there is no one to guess for.
  expect(content.guessFor).toEqual([]);
  expect(await (await approve(itemId, "none")).json()).toEqual({ error: "nothing_to_keep" });
  expect((await detail(itemId)).item.state).toBe("needs_approval");

  const kept = await approve(itemId, `${positionOf(content, "jane.doe")},${positionOf(content, "hello")}`);
  expect(kept.status).toBe(200);
  expect(((await kept.json()) as Detail).item.state).toBe("applied");
  expect(await company(firm.id)).toMatchObject({ state: "accepted" });
  expect(await leftOut(firm.id)).toEqual({ "jane.doe": null, hello: null, sales: "not_kept", info: "generic_address", books: "other_domain" });
  expect(await q("select verification_result from prospect_addresses where company_id = $1 and verification_result is not null", [firm.id])).toEqual([]);
  // The checks wait for a job queued with the approval, never inside it.
  expect(await verifyJobs(firm.id)).toEqual([{ workspaceId: W, companyId: firm.id }]);
  // Decided once: approving again finds it Applied.
  expect(await (await approve(itemId, REJECT_CHOICE)).json()).toEqual({ error: "draft_version_moved" });
});

test("a person named with no published address is listed to guess for, and accepting with none kept queues the checks", async () => {
  const firm = await readFirm("guess.test");
  // Outside Canada, and with no address published under her name, Jane can only be reached by a guess.
  await q("update prospect_companies set country = 'US' where id = $1", [firm.id]);
  await q("update prospect_addresses set email = 'partners@guess.test', kind = 'unknown' where company_id = $1 and email like 'jane.doe@%'", [firm.id]);
  const { itemId } = (await janeHandedOver(firm.id)) as { itemId: string };
  const { content } = await detail(itemId);
  expect(content.guessFor).toEqual([{ name: "Jane Doe", role: "Managing Partner" }]);

  const accepted = await approve(itemId, "none");
  expect(accepted.status).toBe(200);
  expect(await company(firm.id)).toMatchObject({ state: "accepted" });
  expect(await leftOut(firm.id)).toEqual({ partners: "no_known_person", hello: "not_kept", sales: "not_kept", info: "generic_address", books: "other_domain" });
  expect(await verifyJobs(firm.id)).toEqual([{ workspaceId: W, companyId: firm.id }]);
});

test("rejecting ends Applied, marks the company rejected and expires its pages in 90 days", async () => {
  const firm = await readFirm("reject.test", { start: async () => ({ ok: false, reason: "no_route" }) });
  const [made] = await reviewsOf(firm.id);
  const r = await approve(made!.id, REJECT_CHOICE);
  expect(((await r.json()) as Detail).item.state).toBe("applied");
  expect(await company(firm.id)).toMatchObject({ state: "rejected" });
  expect(await verifyJobs(firm.id)).toEqual([]);
  const expiry = new Date(NOW.getTime() + REJECTED_KEEP_DAYS * 86_400_000).toISOString();
  const pages = await q<{ expires_at: Date }>("select expires_at from prospect_snapshots where company_id = $1", [firm.id]);
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.map((p) => p.expires_at.toISOString())).toEqual(pages.map(() => expiry));
});

test("an opted-out address and a Person already written to show as left out with why; a known Person is joined", async () => {
  const domain = "known.test";
  const person = async (email: string) => {
    const id = await createPerson(W);
    expect((await addKey(W, id, "email", email)).ok).toBe(true);
    return id;
  };
  await person(`sales@${domain}`);
  await outreach.addSuppression(W, `sales@${domain}`);
  const jane = await person(`jane.doe@${domain}`);
  const hello = await person(`hello@${domain}`);
  const sentItem = await items.createActionItem(W, {
    idempotencyKey: crypto.randomUUID(),
    capability: "test.post",
    dedupe: "blind",
    spec: { to: [`jane.doe@${domain}`], body: "hello" },
    actor: { userId: U },
    details: { title: "An email", warnings: [] },
  });
  await items.submitItem(W, sentItem.id, { userId: U });
  expect((await approve(sentItem.id, undefined)).status).toBe(200);
  await ledger.run(W, await actionIdOf(W, sentItem.id));
  expect((await items.view(W, sentItem.id))!.state).toBe("sent");

  const firm = await readFirm(domain);
  const { itemId } = (await janeHandedOver(firm.id)) as { itemId: string };
  const { content } = await detail(itemId);
  const shown = Object.fromEntries(content.addresses.map((a) => [a.email.split("@")[0], [a.leftOut, a.personId]]));
  expect(shown).toMatchObject({ "jane.doe": ["already_contacted", jane], sales: ["opted_out", expect.any(String)], hello: [null, hello] });

  for (const local of ["jane.doe", "sales"]) expect(await (await approve(itemId, String(positionOf(content, local)))).json()).toEqual({ error: "address_left_out" });
  expect((await approve(itemId, String(positionOf(content, "hello")))).status).toBe(200);
});

test("deciding a review follows the item routes' roles", async () => {
  const firm = await readFirm("roles.test", { start: async () => ({ ok: false, reason: "no_route" }) });
  const [made] = await reviewsOf(firm.id);
  const keep = String(positionOf((await detail(made!.id)).content, "sales"));
  for (const role of ["viewer", "contributor"]) {
    const m = await addMember(owner, W, role);
    expect((await approve(made!.id, keep, m.cookie)).status).toBe(403);
    expect((await call(`/api/w/${W}/items/${made!.id}`, m.cookie)).status).toBe(200);
  }
  const stranger = await signIn();
  await createOrg(stranger, "Other");
  expect((await approve(made!.id, keep, stranger)).status).toBe(404);
  const marketer = await addMember(owner, W, "marketer");
  expect((await approve(made!.id, keep, marketer.cookie)).status).toBe(200);
}, 30_000);
