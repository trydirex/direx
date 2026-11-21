// SPDX-License-Identifier: AGPL-3.0-only
// A new Mailbox's ramp: it plans 20 emails a day below its daily limit. A Mailbox connected before
// the ramp has none.
import { afterAll, expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { testIdentity } from "../identity/test-auth";
import { mailboxPace, planMailbox } from "../schedule/index";

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
