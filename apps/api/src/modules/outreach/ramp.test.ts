// SPDX-License-Identifier: AGPL-3.0-only
// A new Mailbox's ramp: it plans 20 emails a day below its daily limit, grows a step after clean days
// with an email sent, starts its clean days again after a bounce, and halves on a bounce pause, an
// abuse refusal or a sending-limit refusal. A Mailbox connected before the ramp has none.
import { afterAll, expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { testIdentity } from "../identity/test-auth";
import { mailboxPace, planMailbox } from "../schedule/index";
import { rampOf } from "./adapters/pauses";
import { inWorkspace } from "./adapters/repo";
import { halveRamp, sweepRamp } from "./domain/ramp";
import { pauseOnProviderAbuse, slowOnSendingLimit, sweepRamps } from "./index";

const DAY = 86_400_000;
const SEND = "com.trydirex.gmail/email.send";

test("halving never goes below the floor, and the sweep steps only after clean days with an email sent", () => {
  expect([halveRamp(50), halveRamp(30), halveRamp(20)]).toEqual([25, 20, 20]);
  const since = new Date("2026-11-01T00:00:00Z");
  const at = (days: number) => new Date(since.getTime() + days * DAY);
  const s = { ramp: 20, cleanSince: since, dailyLimit: 50, paused: false, sent: 3, bounced: 0 };
  expect(sweepRamp(s, at(1))).toEqual({ ramp: 20, restart: false });
  expect(sweepRamp(s, at(2))).toEqual({ ramp: 30, restart: true });
  expect(sweepRamp({ ...s, ramp: 45 }, at(2))).toEqual({ ramp: 50, restart: true });
  expect(sweepRamp({ ...s, ramp: 50 }, at(9))).toEqual({ ramp: 50, restart: false });
  expect(sweepRamp({ ...s, sent: 0 }, at(5))).toEqual({ ramp: 20, restart: false });
  expect(sweepRamp({ ...s, paused: true }, at(5))).toEqual({ ramp: 20, restart: false });
  expect(sweepRamp({ ...s, bounced: 1 }, at(5))).toEqual({ ramp: 20, restart: true });
});

const { signIn, createOrg } = testIdentity();
const W = (await createOrg(await signIn())).workspace.id;
const db = await ownerClient();
afterAll(() => db.end());
const q = async (text: string, values: unknown[] = []) => (await db.query(text, values)).rows;
const user = (await q("select user_id from workspace_members where workspace_id = $1", [W]))[0]!.user_id as string;
await q("insert into workspace_keys (workspace_id, key_version, wrapped_dek, root_key_id, created_at) values ($1, 1, 'k', 'r', now())", [W]);

/** A Mailbox as connecting one makes it; `established` is one connected before the ramp. */
async function mailbox(established = false) {
  const [row] = await q(
    `insert into credentials (workspace_id, scope, kind, key, name, ciphertext, nonce, key_version, created_by, created_at, updated_at${established ? ", ramp_limit, ramp_clean_since" : ""})
     values ($1, 'workspace', 'api_key', $2, 'Mailbox', 'c', 'n', 1, $3, now(), now()${established ? ", null, null" : ""}) returning id`,
    [W, `${crypto.randomUUID()}@acme.test`, user],
  );
  return row!.id as string;
}
const ramp = async (id: string) => (await q("select ramp_limit from credentials where id = $1", [id]))[0]!.ramp_limit as number | null;
const sentMail = (id: string, at: Date) => q(
  `insert into actions (workspace_id, idempotency_key, capability, dedupe_class, state, credential_id, first_dispatched_at, spec, spec_hash, created_at, updated_at)
   values ($1, gen_random_uuid(), $2, 'queryable', 'sent', $3, $4, '{}'::jsonb, 'h', now(), now()) returning id`,
  [W, SEND, id, at],
);
const perDay = (slots: Date[]) => {
  const days = new Map<string, number>();
  for (const d of slots) days.set(d.toISOString().slice(0, 10), (days.get(d.toISOString().slice(0, 10)) ?? 0) + 1);
  return [...days.values()];
};

test("a new Mailbox plans 20 a day; one connected before the ramp plans up to its daily limit", async () => {
  const fresh = await mailbox();
  const old = await mailbox(true);
  expect(await ramp(fresh)).toBe(20);
  expect(await ramp(old)).toBeNull();
  const now = new Date("2026-11-02T06:00:00Z");
  expect(perDay(await planMailbox(W, fresh, { on: "2026-11-02", count: 30, now }))).toEqual([20, 10]);
  expect(perDay(await planMailbox(W, old, { on: "2026-11-02", count: 30, now }))).toEqual([30]);
  // The pace a person sees and sets is the daily limit, not the ramp below it.
  expect((await mailboxPace(W, fresh))?.pace.dailyLimit).toBe(50);
  // A daily limit below the ramp still wins.
  await q("update credentials set daily_limit = 5 where id = $1", [fresh]);
  expect(perDay(await planMailbox(W, fresh, { on: "2026-11-02", count: 6, now }))).toEqual([5, 1]);
});

test("an abuse refusal and a sending-limit refusal each halve the ramp; an established Mailbox keeps none", async () => {
  const id = await mailbox();
  const old = await mailbox(true);
  const now = new Date();
  await q("update credentials set ramp_limit = 80 where id = $1", [id]);
  await inWorkspace(W, async (tx) => {
    await slowOnSendingLimit({ now: () => now })(tx, { capability: SEND, credentialId: id }, "sending_limit");
    await slowOnSendingLimit({ now: () => now })(tx, { capability: SEND, credentialId: id }, "abuse");
    await slowOnSendingLimit({ now: () => now })(tx, { capability: "com.trydirex.x/social.publish", credentialId: id }, "sending_limit");
  });
  expect(await ramp(id)).toBe(40);
  await inWorkspace(W, async (tx) => {
    await pauseOnProviderAbuse({ now: () => now })(tx, { capability: SEND, credentialId: id }, "abuse");
    await slowOnSendingLimit({ now: () => now })(tx, { capability: SEND, credentialId: old }, "sending_limit");
    await pauseOnProviderAbuse({ now: () => now })(tx, { capability: SEND, credentialId: old }, "abuse");
  });
  expect(await ramp(id)).toBe(20);
  expect(await ramp(old)).toBeNull();
  expect((await q("select pause_reason from credentials where id = $1", [old]))[0]!.pause_reason).toBe("provider_abuse");
});

test("the sweep grows a ramp after two clean days with an email sent, and a bounce starts the clean days again", async () => {
  const id = await mailbox();
  const now = new Date();
  await q("update credentials set ramp_clean_since = $2 where id = $1", [id, new Date(now.getTime() - 3 * DAY)]);
  await sweepRamps([{ workspaceId: W, credentialId: id }], now);
  expect(await ramp(id)).toBe(20);

  const [sent] = await sentMail(id, new Date(now.getTime() - DAY));
  await sweepRamps([{ workspaceId: W, credentialId: id }], now);
  expect(await ramp(id)).toBe(30);
  expect(await inWorkspace(W, (tx) => rampOf(tx, id))).toMatchObject({ ramp: 30, cleanSince: now, sent: 0, bounced: 0 });

  // A bounce on an email sent before the new clean days began still counts once it arrives.
  await q("update credentials set ramp_clean_since = $2 where id = $1", [id, new Date(now.getTime() - 3 * DAY)]);
  await q("insert into reply_signals (workspace_id, event_id, sender_email, kind, status, received_at, action_id) values ($1, 'e', 'mailer-daemon@x.test', 'bounce', 'recorded', now(), $2)", [W, sent!.id]);
  const later = new Date(now.getTime() + 1000);
  await sweepRamps([{ workspaceId: W, credentialId: id }], later);
  expect(await inWorkspace(W, (tx) => rampOf(tx, id))).toMatchObject({ ramp: 30, cleanSince: later });

  // A Mailbox connected before the ramp is skipped.
  const old = await mailbox(true);
  await sweepRamps([{ workspaceId: W, credentialId: old }], later);
  expect(await ramp(old)).toBeNull();
});

test("a sending limit committed during the sweep preserves the reduced ramp and its clean days", async () => {
  const id = await mailbox();
  const now = new Date();
  const warnedAt = new Date(now.getTime() - 1000);
  await q("update credentials set ramp_limit = 40, ramp_clean_since = $2 where id = $1", [id, new Date(now.getTime() - 3 * DAY)]);
  await sentMail(id, new Date(now.getTime() - DAY));

  const warning = await ownerClient();
  let sweep: Promise<void> | undefined;
  try {
    await warning.query("begin");
    const { rows: [blocker] } = await warning.query(
      "update credentials set ramp_limit = 20, ramp_clean_since = $2 where id = $1 returning pg_backend_pid() as pid",
      [id, warnedAt],
    );
    sweep = sweepRamps([{ workspaceId: W, credentialId: id }], now);
    await expect.poll(async () => (await q(
      "select exists(select from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as waiting",
      [blocker.pid],
    ))[0]!.waiting).toBe(true);
    await warning.query("commit");
  } finally {
    await warning.end();
    await sweep;
  }
  expect(await inWorkspace(W, (tx) => rampOf(tx, id))).toMatchObject({ ramp: 20, cleanSince: warnedAt });
});
