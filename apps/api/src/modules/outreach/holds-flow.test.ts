// SPDX-License-Identifier: AGPL-3.0-only
// Relationship holds against real Postgres: what each source does to the floor, the wait after a
// certain hold, colleagues at the same company, and letting a guess go.
import { OpenAPIHono } from "@hono/zod-openapi";
import { inWorkspace } from "./adapters/repo";
import { expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { createVault, rootKeyFromEnv } from "../credentials/index";
import { createItems } from "../items/index";
import { TEST_SECRET, testIdentity, testLedger } from "./fixtures/support";
import { createHmac } from "node:crypto";
import { createHoldHooks, createHolds, createOutreach, IN_CONVERSATION, MAY_BE_TALKING, outreachFloors, outreachRoutes, recordSentMail, type ReplyStop } from "./index";

process.env.DIREX_AUTH_SECRET = TEST_SECRET;
const DAY = 86_400_000;

const { clock, ledger } = await testLedger();
const items = createItems({ ledger, now: () => clock.at });
const outreach = createOutreach({ items: () => items, send: () => { throw new Error("no sending here"); }, baseUrl: () => "https://direx.example", ledger: () => ledger, now: () => clock.at });
const marked: { ids: string[]; status?: string }[] = [];
const replies: ReplyStop = { mark: async (_tx, ids, status) => (marked.push({ ids: [...ids], status }), ["item-1"]), cancel: async () => {} };
const resumed: string[] = [];
const holds = createHolds({
  replies: () => replies,
  ledger: () => ({ resumeHeldBy: async (_w, reason) => (resumed.push(reason), 0) }),
  now: () => clock.at,
});
const floors = outreachFloors(async () => true, () => clock.at);
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });
const holdHooks = createHoldHooks({ vault: () => vault, replies: () => replies, now: () => clock.at });

const { routes, signIn, createOrg, call } = testIdentity();
(routes as unknown as OpenAPIHono).route("/", outreachRoutes({ outreach: () => outreach, holds: () => holds, holdHooks: () => holdHooks }));
const email = `${crypto.randomUUID()}@example.com`;
const cookie = await signIn(email);
const W = (await createOrg(cookie, "Acme")).workspace.id;
const owner = await ownerClient();
const userId: string = (await owner.query(`select id from auth."user" where email = $1`, [email])).rows[0].id;
await owner.end();

const newPerson = async (address: string, ws = W, c = cookie) =>
  ((await (await call(`/api/w/${ws}/outreach/people`, c, { method: "POST", body: { email: address, country: "GB", basis: "published_address", evidence: "their site" } })).json()) as { id: string }).id;
const floor = (personId: string, touchClass = "cold", ws = W) =>
  inWorkspace(ws, (tx) => floors(tx, { workspaceId: ws, credentialId: null, capability: "email.send", spec: { touch: { personId, touchClass } } } as never, { approverId: userId, standingRuleId: null, producerDigest: null }));
const reasonOf = (r: { kind: string; reason?: string }) => r.reason ?? null;
const unique = (local: string, domain = `${crypto.randomUUID().slice(0, 8)}.example.com`) => `${local}@${domain}`;

test("a manual hold stops the Person's campaigns without counting as a reply, and blocks cold mail", async () => {
  const p = await newPerson(unique("jane"));
  expect(await holds.addManual(W, p, { reason: "Skipped on approval", userId })).toEqual({ ok: true });
  expect(marked.at(-1)).toEqual({ ids: [p], status: "removed" });
  expect(await floor(p)).toEqual({ kind: "block", reason: IN_CONVERSATION, detail: "Skipped on approval" });
  expect(await floor(p, "consented_marketing")).toMatchObject({ kind: "block", reason: IN_CONVERSATION });
  // The relationship itself is never held.
  expect(reasonOf(await floor(p, "sales_follow_up"))).not.toBe(IN_CONVERSATION);
  expect((await outreach.whyNot(W, [p], "cold", clock.at)).get(p)).toBe(IN_CONVERSATION);
});

test("after a manual hold ends, the Person stays out for 90 more days", async () => {
  const p = await newPerson(unique("sam"));
  await holds.addManual(W, p, { reason: "Deal", userId });
  const start = clock.at;
  clock.at = new Date(start.getTime() + 31 * DAY);
  expect(await floor(p)).toMatchObject({ reason: IN_CONVERSATION });
  clock.at = new Date(start.getTime() + 121 * DAY);
  expect(reasonOf(await floor(p))).not.toBe(IN_CONVERSATION);
  clock.at = start;
});

test("a colleague's hold holds others at the company, but a shared mail domain holds nobody", async () => {
  const domain = `${crypto.randomUUID().slice(0, 8)}.example.com`;
  const jane = await newPerson(unique("jane", domain));
  const bob = await newPerson(unique("bob", domain));
  const gmailJane = await newPerson(unique(`jane-${crypto.randomUUID().slice(0, 6)}`, "gmail.com"));
  const gmailBob = await newPerson(unique(`bob-${crypto.randomUUID().slice(0, 6)}`, "gmail.com"));
  await holds.addManual(W, jane, { reason: "Deal: renewal", userId });
  await holds.addManual(W, gmailJane, { reason: "Deal", userId });
  expect(await floor(bob)).toEqual({ kind: "hold", reason: MAY_BE_TALKING, detail: `company:${domain}` });
  expect(reasonOf(await floor(gmailBob))).not.toBe(MAY_BE_TALKING);
  // A guess holds cold mail only.
  expect(reasonOf(await floor(bob, "consented_marketing"))).not.toBe(MAY_BE_TALKING);

  await holds.release(W, bob, "company", userId);
  expect(reasonOf(await floor(bob))).not.toBe(MAY_BE_TALKING);
  expect(resumed.at(-1)).toBe(MAY_BE_TALKING);
});

test("hand-written mail holds for 90 days; a release lasts until the next email", async () => {
  const address = unique("ann");
  const p = await newPerson(address);
  const made = await vault.create({ workspaceId: W, actorUserId: userId, scope: "workspace", kind: "api_key", key: "me@acme.test", name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!made.ok) throw new Error(made.reason);
  const credentialId = made.credential.id;
  await holds.recordWritten(W, credentialId, [{ email: address.toUpperCase(), at: new Date(clock.at.getTime() - 20 * DAY) }]);
  expect(await floor(p)).toEqual({ kind: "hold", reason: MAY_BE_TALKING, detail: "sent_mail" });

  await holds.release(W, p, "inferred", userId);
  expect(reasonOf(await floor(p))).not.toBe(MAY_BE_TALKING);
  clock.at = new Date(clock.at.getTime() + 1000);
  await holds.recordWritten(W, credentialId, [{ email: address, at: clock.at }]);
  expect(await floor(p)).toMatchObject({ reason: MAY_BE_TALKING });

  const old = unique("old");
  const q = await newPerson(old);
  await holds.recordWritten(W, credentialId, [{ email: old, at: new Date(clock.at.getTime() - 100 * DAY) }]);
  expect(reasonOf(await floor(q))).not.toBe(MAY_BE_TALKING);
});

test("Sent mail: a hand-written email holds; old, Direx, newsletter and crowd mail hold nobody", async () => {
  const made = await vault.create({ workspaceId: W, actorUserId: userId, scope: "workspace", kind: "api_key", key: "sent@acme.test", name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!made.ok) throw new Error(made.reason);
  const sent = (recipients: string[], o: { daysAgo?: number; xDirexAction?: string; listUnsubscribe?: string } = {}) =>
    inWorkspace(W, (tx) =>
      recordSentMail(
        tx,
        {
          workspaceId: W,
          credentialId: made.credential.id,
          data: { messageId: `<${crypto.randomUUID()}@mail.gmail.com>`, recipients, sentAt: clock.at.getTime() - (o.daysAgo ?? 20) * DAY, xDirexAction: o.xDirexAction ?? null, listUnsubscribe: o.listUnsubscribe ?? null, precedence: null },
        },
        clock.at,
      ),
    );
  const [kim, old, cold, news] = [unique("kim"), unique("old"), unique("cold"), unique("news")];
  const crowd = Array.from({ length: 12 }, (_, i) => unique(`c${i}`));
  const pKim = await newPerson(kim);
  const others = [await newPerson(old), await newPerson(cold), await newPerson(news), await newPerson(crowd[0]!)];
  await sent([kim]);
  await sent([old], { daysAgo: 100 });
  await sent([cold], { xDirexAction: crypto.randomUUID() });
  await sent([news], { listUnsubscribe: "<mailto:u@acme.test>" });
  await sent(crowd);
  // Garbage from a plugin never reaches here: the host refuses it against the mail.sent entry (plugins/trigger-data.test.ts).

  expect(await floor(pKim)).toEqual({ kind: "hold", reason: MAY_BE_TALKING, detail: "sent_mail" });
  for (const p of others) expect(reasonOf(await floor(p))).not.toBe(MAY_BE_TALKING);
});

test("a hold in one Workspace means nothing in another", async () => {
  const address = unique("lee");
  const mine = await newPerson(address);
  await holds.addManual(W, mine, { reason: "Deal", userId });
  const other = await signIn();
  const W2 = (await createOrg(other, "Beta")).workspace.id;
  const theirs = await newPerson(address, W2, other);
  expect(reasonOf(await floor(theirs, "cold", W2))).not.toBe(IN_CONVERSATION);
});

test("over HTTP: add a hold, see it, end it, and the wait still holds; another Workspace's Person is not found", async () => {
  const p = await newPerson(unique("http"));
  const base = `/api/w/${W}/outreach`;
  expect((await call(`${base}/people/${p}/holds`, cookie, { method: "POST", body: { reason: "Skipped on approval" } })).status).toBe(200);
  const seen = (await (await call(`${base}/people/${p}/holds`, cookie)).json()) as { hold: { reason: string; detail: string }; holds: { id: string; reason: string }[] };
  expect(seen.hold).toEqual({ reason: IN_CONVERSATION, detail: "Skipped on approval", release: null, waitUntil: null });
  expect(seen.holds.map((h) => h.reason)).toEqual(["Skipped on approval"]);

  expect((await call(`${base}/holds/${seen.holds[0]!.id}/end`, cookie, { method: "POST" })).status).toBe(200);
  const after = (await (await call(`${base}/people/${p}/holds`, cookie)).json()) as { hold: { reason: string; waitUntil: string | null } | null; holds: unknown[] };
  expect(after.holds).toEqual([]);
  expect(after.hold?.reason).toBe(IN_CONVERSATION);
  // Ended, so only the 90-day wait is left, and it says when that ends.
  expect(new Date(after.hold!.waitUntil!).getTime() - clock.at.getTime()).toBeGreaterThan(89 * 86_400_000);
  expect((await call(`${base}/holds/${seen.holds[0]!.id}/end`, cookie, { method: "POST" })).status).toBe(404);

  const listed = (await (await call(base, cookie)).json()) as { people: { id: string; hold: { reason: string; waitUntil: string | null } | null }[] };
  expect(listed.people.find((x) => x.id === p)?.hold?.reason).toBe(IN_CONVERSATION);
  expect(listed.people.find((x) => x.id === p)?.hold?.waitUntil).toBe(after.hold!.waitUntil);

  const other = await signIn();
  const W2 = (await createOrg(other, "Gamma")).workspace.id;
  const theirs = await newPerson(unique("them"), W2, other);
  expect((await call(`${base}/people/${theirs}/holds`, cookie, { method: "POST", body: { reason: "x" } })).status).toBe(404);
  expect((await call(`${base}/people/${theirs}/holds/release`, cookie, { method: "POST", body: { kind: "inferred" } })).status).toBe(404);
});

test("webhook (R8): a bad signature changes nothing; a good one holds; sending it again never shortens; nothing can end a hold", async () => {
  const base = `/api/w/${W}/outreach/hold-hook`;
  const made = (await (await call(base, cookie, { method: "POST" })).json()) as { id: string; path: string; secret: string };
  expect(made.path).toBe(`/api/hooks/holds/${W}/${made.id}`);
  expect((await call(base, cookie, { method: "POST" })).status).toBe(409);
  // The secret is shown once: the status has none.
  expect(await (await call(base, cookie)).json()).toEqual({ hook: { id: made.id, path: made.path, createdAt: expect.any(String) } });

  const send = (body: unknown, secret = made.secret, path = made.path) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return routes.request(path, { method: "POST", headers: { "content-type": "application/json", "x-signature": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` }, body: raw });
  };
  const address = unique("deal");
  const p = await newPerson(address);
  const held = async () => ((await holds.ofPerson(W, p)).holds as { source: string; expiresAt: string }[]).filter((h) => h.source === "webhook");

  expect((await send({ holds: [{ email: address, reason: "Deal" }] }, "wrong-secret")).status).toBe(401);
  expect(await held()).toEqual([]);

  const body = { holds: [{ email: address.toUpperCase(), reason: "Deal: renewal", days: 60 }] };
  const first = await send(body);
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, held: 1 });
  expect(marked.at(-1)).toEqual({ ids: [p], status: "removed" });
  expect(await floor(p)).toEqual({ kind: "block", reason: IN_CONVERSATION, detail: "Deal: renewal" });
  const until = (await held())[0]!.expiresAt;
  expect(until).toBe(new Date(clock.at.getTime() + 60 * DAY).toISOString());

  // A replayed body and a shorter one leave one row that ends no sooner.
  expect((await send(body)).status).toBe(200);
  expect((await send({ holds: [{ email: address, reason: "Deal", days: 1 }] })).status).toBe(200);
  expect((await held()).map((h) => h.expiresAt)).toEqual([until]);

  // No body can end or shorten a hold, and the limits hold.
  expect((await send({ holds: [{ email: address, reason: "Deal", days: 0 }] })).status).toBe(400);
  expect((await send({ holds: [{ email: address, reason: "Deal", end: true }] })).status).toBe(400);
  expect((await send({ end: [address] })).status).toBe(400);
  expect((await send({ holds: Array.from({ length: 101 }, (_, i) => ({ email: unique(`m${i}`), reason: "Deal" })) })).status).toBe(400);
  expect((await send("x".repeat(65 * 1024))).status).toBe(413);
  expect((await held()).map((h) => h.expiresAt)).toEqual([until]);

  // An address Direx hasn't seen is held when it arrives.
  const later = unique("later");
  expect((await send({ holds: [{ email: later, reason: "Deal" }] })).status).toBe(200);
  expect(await floor(await newPerson(later))).toMatchObject({ kind: "block", reason: IN_CONVERSATION });

  // Rotating stops the old secret at once; another Workspace's path doesn't open this hook.
  const turned = (await (await call(`${base}/${made.id}/rotate`, cookie, { method: "POST" })).json()) as { secret: string };
  expect((await send(body)).status).toBe(401);
  expect((await send(body, turned.secret)).status).toBe(200);
  const other = await signIn();
  const W2 = (await createOrg(other, "Delta")).workspace.id;
  expect((await send(body, turned.secret, `/api/hooks/holds/${W2}/${made.id}`)).status).toBe(401);
  expect((await call(`/api/w/${W2}/outreach/hold-hook/${made.id}/rotate`, other, { method: "POST" })).status).toBe(404);
});
