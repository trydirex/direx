// SPDX-License-Identifier: AGPL-3.0-only
// A Mailbox's daily limit as reservations: the day fills to its limit and no further, even with many
// writers at once; staying on a held day always fits; cancelled work frees its place; automatic
// paths find the next day with room inside the hours.
import { afterAll, beforeAll, expect, test } from "vitest";
import { appClient, insertAuthUser } from "../../../../../test/db";
import { createVault, rootKeyFromEnv } from "../credentials/index";
import { inWorkspace } from "./adapters/schedule-repo";
import { mailboxDayCheck, mailboxDays, mailboxPace, nextMailboxTime, reserveMailbox, setMailboxPace, setTimeZone } from "./index";

const W = crypto.randomUUID();
const NOW = new Date("2026-11-09T07:00:00Z");
// Tuesday 10 Nov 2026, inside 09:00 to 17:00 UTC.
const TUE = new Date("2026-11-10T10:00:00Z");
let c: Awaited<ReturnType<typeof appClient>>;
let mailbox: string;

async function q(text: string, params: unknown[] = []) {
  await c.query("begin");
  await c.query("select set_config('app.workspace_id', $1, true)", [W]);
  const r = await c.query(text, params);
  await c.query("commit");
  return r.rows;
}

/** n draft emails from the Mailbox, or from nowhere when `credentialId` is null. */
async function emails(n: number, credentialId: string | null = mailbox, capability = "com.trydirex.gmail/email.send"): Promise<string[]> {
  const rows = await q(
    `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, spec, spec_hash, credential_id, created_at, updated_at)
     select $1, gen_random_uuid(), $2, 'blind', 'draft', '{}'::jsonb, 'h', $3, now(), now() from generate_series(1, $4) returning id`,
    [W, capability, credentialId, n],
  );
  return rows.map((r) => r.id as string);
}

const owner = crypto.randomUUID();
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => NOW });
/** A connected Mailbox credential, created by the Workspace's owner. */
async function newMailbox(key: string): Promise<string> {
  const made = await vault.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key, name: key, meta: {}, value: { key: "x" } });
  if (!made.ok) throw new Error(made.reason);
  await q("update credentials set connection = 'imap_smtp' where id = $1", [made.credential.id]);
  return made.credential.id;
}

beforeAll(async () => {
  c = await appClient();
  await insertAuthUser(owner);
  const org = crypto.randomUUID();
  await q("insert into organizations (id, name, created_at) values ($1, 'O', now())", [org]);
  await q("insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())", [W, org]);
  await q("insert into workspace_members (workspace_id, user_id, role, created_at) values ($1, $2, 'owner', now())", [W, owner]);
  mailbox = await newMailbox("me@acme.test");
  await q("update credentials set daily_limit = 3 where id = $1", [mailbox]);
});
afterAll(() => c.end());

test("a day fills to the Mailbox's limit and refuses the next, naming the day and the limit; staying on the day fits", async () => {
  const [a, b, d, e] = await emails(4);
  for (const id of [a!, b!, d!]) expect((await reserveMailbox(W, id, TUE, { now: NOW })).kind).toBe("reserved");
  expect(await reserveMailbox(W, e!, TUE, { now: NOW })).toEqual({ kind: "full", day: "2026-11-10", limit: 3 });
  // Approving or moving within a day it already holds never refuses.
  expect((await reserveMailbox(W, a!, new Date("2026-11-10T15:00:00Z"), { now: NOW })).kind).toBe("reserved");
  // Cancelled work frees its place.
  await q("update actions set state = 'cancelled' where id = $1", [b]);
  expect((await reserveMailbox(W, e!, TUE, { now: NOW })).kind).toBe("reserved");
  expect(await mailboxDays(W, new Date("2026-11-09T00:00:00Z"), new Date("2026-11-15T00:00:00Z"), { now: NOW })).toEqual([
    { credentialId: mailbox, name: "me@acme.test", day: "2026-11-10", counted: 3, limit: 3 },
  ]);
});

test("many writers at once never take more than the limit", async () => {
  const ids = await emails(12);
  const wed = new Date("2026-11-11T10:00:00Z");
  const results = await Promise.all(ids.map((id) => reserveMailbox(W, id, wed, { now: NOW })));
  expect(results.filter((r) => r.kind === "reserved")).toHaveLength(3);
  expect(results.filter((r) => r.kind === "full")).toHaveLength(9);
});

test("the next time with room skips full days and weekends and opens at the first sending minute", async () => {
  // Thursday 12 Nov full, Friday 13 has room from the given time.
  const fill = await emails(3);
  for (const id of fill) await reserveMailbox(W, id, new Date("2026-11-12T10:00:00Z"), { now: NOW });
  const [next] = await emails(1);
  expect(await nextMailboxTime(W, next!, new Date("2026-11-12T11:00:00Z"), { now: NOW })).toEqual(new Date("2026-11-13T09:00:00Z"));
  // After hours on Friday: Monday 09:00.
  expect(await nextMailboxTime(W, next!, new Date("2026-11-13T18:00:00Z"), { now: NOW })).toEqual(new Date("2026-11-16T09:00:00Z"));
});

test("at send time, a Mailbox that has already sent its limit today moves the email to its next day with room; one with room sends", async () => {
  // Monday 16 Nov: three sent, one still to go.
  const mon = new Date("2026-11-16T10:00:00Z");
  const [s1, s2, s3, waiting] = await emails(4);
  for (const id of [s1!, s2!, s3!]) await reserveMailbox(W, id, mon, { now: NOW });
  const check = mailboxDayCheck({ now: () => new Date("2026-11-16T12:00:00Z") });
  const run = () => inWorkspace(W, async (tx) => check(tx, { id: waiting!, capability: "com.trydirex.gmail/email.send", credentialId: mailbox } as never, { approverId: "x", standingRuleId: null, producerDigest: null }));
  // Reserved but not gone yet: nothing has been sent, so it sends.
  expect(await run()).toEqual({ kind: "ok" });
  await q("update actions set state = 'sent' where id = any($1)", [[s1, s2, s3]]);
  expect(await run()).toMatchObject({ kind: "later", reason: "mailbox_day_full", at: new Date("2026-11-17T09:00:00Z") });
});

test("whoever connected a Mailbox sets its first pace; after that only someone who manages credentials changes it, and every change is recorded", async () => {
  const other = await newMailbox("sales@acme.test");
  const pace = { dailyLimit: 120, sendFrom: 8 * 60, sendUntil: 18 * 60, sendWeekends: false };
  expect(await setMailboxPace(W, other, { ...pace, dailyLimit: 501 }, { userId: owner, mayManage: true })).toEqual({ ok: false, reason: "bad_pace" });
  expect(await setMailboxPace(W, other, { ...pace, sendFrom: 600, sendUntil: 600 }, { userId: owner, mayManage: true })).toEqual({ ok: false, reason: "bad_pace" });
  expect(await setMailboxPace(W, other, pace, { userId: crypto.randomUUID(), mayManage: false })).toEqual({ ok: false, reason: "forbidden" });
  expect(await setMailboxPace(W, other, pace, { userId: owner, mayManage: false })).toEqual({ ok: true });
  expect(await setMailboxPace(W, other, { ...pace, dailyLimit: 80 }, { userId: owner, mayManage: false })).toEqual({ ok: false, reason: "forbidden" });
  expect(await setMailboxPace(W, other, { ...pace, dailyLimit: 80 }, { userId: owner, mayManage: true })).toEqual({ ok: true });
  expect(await mailboxPace(W, other)).toEqual({ pace: { ...pace, dailyLimit: 80 }, timeZone: "UTC" });
  const changes = await q("select before, after, changed_by from mailbox_setting_changes where credential_id = $1 order by id", [other]);
  expect(changes.map((r) => [r.before.dailyLimit, r.after.dailyLimit, r.changed_by])).toEqual([
    [50, 120, owner],
    [120, 80, owner],
  ]);
  expect(await setTimeZone(W, "Mars/Olympus")).toEqual({ ok: false, reason: "bad_time_zone" });
  expect(await setTimeZone(W, "Europe/Berlin")).toEqual({ ok: true });
  expect((await mailboxPace(W, other))!.timeZone).toBe("Europe/Berlin");
  await setTimeZone(W, "UTC");
});

test("an Action that isn't an email from a Mailbox isn't counted", async () => {
  const [post] = await emails(1, null, "com.trydirex.linkedin/post.publish");
  expect(await reserveMailbox(W, post!, TUE, { now: NOW })).toEqual({ kind: "not_counted" });
});

test("Placement checks, reports, join replies and archiving neither take a place on the Mailbox's day nor wait for one", async () => {
  // Wednesday 18 Nov: the Mailbox has sent its limit.
  const wed = new Date("2026-11-18T10:00:00Z");
  const sent = await emails(3);
  for (const id of sent) await reserveMailbox(W, id, wed, { now: NOW });
  await q("update actions set state = 'sent' where id = any($1)", [sent]);
  const check = mailboxDayCheck({ now: () => new Date("2026-11-18T12:00:00Z") });
  for (const name of ["placement.send", "placement.report", "placement.join", "placement.archive"]) {
    const capability = `com.trydirex.gmail/${name}`;
    const [id] = await emails(1, mailbox, capability);
    expect(await reserveMailbox(W, id!, wed, { now: NOW })).toEqual({ kind: "not_counted" });
    expect(await inWorkspace(W, (tx) => check(tx, { id: id!, capability, credentialId: mailbox } as never, { approverId: "x", standingRuleId: null, producerDigest: null }))).toEqual({ kind: "ok" });
  }
  expect(await mailboxDays(W, new Date("2026-11-18T00:00:00Z"), new Date("2026-11-19T00:00:00Z"), { now: NOW })).toEqual([{ credentialId: mailbox, name: "me@acme.test", day: "2026-11-18", counted: 3, limit: 3 }]);
});
