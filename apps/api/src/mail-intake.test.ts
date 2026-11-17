// SPDX-License-Identifier: AGPL-3.0-only
// The real startWorker, with only Gmail pointed at a fake: the mailbox poll job reads the inbox, and a
// reply asking to stop reaches the opt-out intake and suppresses that Person.
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { afterAll, expect, test } from "vitest";
import { appClient } from "../../../test/db";
import { createBoss } from "./jobs/boss";
import { createVault, rootKeyFromEnv } from "./modules/credentials/index";
import { seedMember } from "./modules/identity/fixtures/member";
import { passMailboxCheck } from "./modules/outreach/fixtures/support";
import { createOutreach } from "./modules/outreach/index";
import { EMAIL_RECEIVED } from "./modules/plugins/index";
import { PLACEMENT_WORDING_VERSION } from "./modules/placement/index";
import { MAILBOX_POLLS, PLACEMENT_DAILY, PLACEMENT_SWEEP } from "./worker";
import { testWorker } from "./compose/fixtures/worker";

// No Placement circle list is configured, as on every install that hasn't joined one.
delete process.env.DIREX_PLACEMENT_LIST;
const fake = startFakeGmail();
const W = crypto.randomUUID();
const owner = crypto.randomUUID();
await seedMember(W, owner);
const db = await appClient();
const q = async (text: string, params: unknown[] = []) => {
  await db.query("begin");
  await db.query("select set_config('app.workspace_id', $1, true)", [W]);
  const r = await db.query(text, params);
  await db.query("commit");
  return r.rows;
};

const real = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });
const made = await real.create({ workspaceId: W, actorUserId: owner, scope: "workspace", kind: "api_key", key: "me@acme.test", name: "Mailbox", meta: {}, value: { key: "x" } });
if (!made.ok) throw new Error(made.reason);
const mailbox = made.credential.id;
await q("update credentials set connection = 'google' where id = $1", [mailbox]);
await passMailboxCheck(W, mailbox);
// Only this Mailbox reaches the fake; every other credential resolves as it would in production.
const vault = { ...real, credentials: (async (ws, id, use) => (id === mailbox ? { accessToken: fake.token, expiresAt: "" } : real.credentials(ws, id, use))) as typeof real.credentials };

const worker = await testWorker({ vault, pluginSources: [createGmailPlugin({ baseUrl: fake.url, timeoutMs: 1000 })] });
const boss = createBoss();
await boss.start();
afterAll(async () => {
  await worker.plugins?.stopPolling(W, "com.trydirex.gmail", EMAIL_RECEIVED, mailbox);
  await worker.stop();
  await boss.stop({ graceful: false, close: true });
  await db.end();
  fake.stop();
});

test("the worker's mailbox poll reads a reply asking to stop and suppresses that Person", { timeout: 30_000 }, async () => {
  const outreach = createOutreach({ items: () => worker.items, send: worker.sendFor!, baseUrl: () => "http://direx.test", now: () => new Date() });
  const to = `${crypto.randomUUID()}@example.com`;
  const person = await outreach.addPerson(W, { email: to, country: "US", basis: "published_address", evidence: "their site", userId: owner });
  expect(person.ok).toBe(true);

  fake.deliver({ from: `Kim <${to}>`, subject: "Re: Hello", text: "Please remove me" });
  await boss.send(MAILBOX_POLLS, {});

  const suppressed = async () => (await q("select reason from suppressions where email = $1", [to]))[0]?.reason as string | undefined;
  await expect.poll(suppressed, { timeout: 25_000, interval: 250 }).toBe("reply");
  expect(await q("select status, decided_by from reply_signals where sender_email = $1", [to])).toEqual([{ status: "opted_out", decided_by: "rule" }]);
});

test("with no placement list, the worker's placement jobs make no Action and no check, even for a Mailbox with a yes", { timeout: 30_000 }, async () => {
  await q("insert into placement_grants (workspace_id, credential_id, answer, wording_version, answered_by, answered_at) values ($1, $2, 'yes', $3, $4, now())", [W, mailbox, PLACEMENT_WORDING_VERSION, owner]);
  for (const queue of [PLACEMENT_DAILY, PLACEMENT_SWEEP]) {
    const id = await boss.send(queue, {});
    await expect.poll(async () => (await boss.getJobById(queue, id!))?.state, { timeout: 25_000, interval: 250 }).toBe("completed");
  }
  expect(await q("select count(*)::int as n from actions where capability like '%/placement.%'")).toEqual([{ n: 0 }]);
  expect(await q("select count(*)::int as n from placement_probes")).toEqual([{ n: 0 }]);
});
