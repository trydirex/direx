// SPDX-License-Identifier: AGPL-3.0-only
// The Social account side of the capacity port (ADR 0038): a post holds one reservation on its
// account's day, placed and reserved under a lock on the account so two writers can't land inside
// each other's gap. The day's number is the account budget; nothing here adds another.
import { storedSpec } from "@direx/plugin-sdk/host";
import { warn, type CapacityPort, type CapacityResult, type PlaceTarget, type Placed } from "../../items/index";
import { actionStates } from "../../ledger/index";
import { withGroupRetry } from "../../people";
import { counts, mailboxDay, nextDay } from "../../schedule";
import { healthOf, inWorkspace, insertReservation, lockAccount, newestReservationFor, newestReservationsAround, paceRowOf, postActionOf, workspaceZone, type SocialTx } from "../adapters/repo";
import { capOf, FLOOR } from "../domain/budget";
import { budgetOf } from "./account-health";
import { offPace, paceOf, place, type OffPace, type SocialPace } from "./pace";

type Account = { credentialId: string; networkId: string };
type PostAction = NonNullable<Awaited<ReturnType<typeof postActionOf>>>;

const sameAccount = (a: Account, b: Account) => a.credentialId === b.credentialId && a.networkId === b.networkId;

const isPost = (capability: string) => capability.split("/").at(-1) === "social.publish";

/** A post's account: the login it publishes through and the network account its spec targets. */
function accountOf(credentialId: string | null, spec: unknown): Account | null {
  const target = storedSpec("social.publish", spec).target;
  return credentialId && typeof target === "string" && target ? { credentialId, networkId: target } : null;
}

const prevDay = (on: string) => new Date(Date.parse(`${on}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

const WORDS: Record<OffPace, (pace: SocialPace) => string> = {
  outside_hours: () => "This time is outside this account's posting hours.",
  inside_gap: (pace) => `Another post on this account is planned within ${pace.gapMinutes} minutes.`,
};

export function socialCapacity(d: { networks: () => readonly { connection: string; pace?: SocialPace }[] }): CapacityPort {
  /** The account's pace and the Workspace's time zone, or null when no such account is connected. */
  async function settingOf(tx: SocialTx, workspaceId: string, a: Account) {
    const row = await paceRowOf(tx, a);
    if (!row) return null;
    return { pace: paceOf(row, d.networks().find((n) => n.connection === row.connection)?.pace), timeZone: await workspaceZone(tx, workspaceId) };
  }

  /** The account's counted posts on the days around `on`, other than one Action, for the gap and the day's count. */
  async function countedAround(tx: SocialTx, a: Account, on: string, now: Date, exceptActionId?: string) {
    const rows = (await newestReservationsAround(tx, a, prevDay(on), nextDay(on))).filter((r) => r.actionId !== exceptActionId && sameAccount(a, r));
    const states = await actionStates(tx, rows.map((r) => r.actionId));
    return rows.filter((r) => counts(r.slot, states.get(r.actionId), now));
  }

  /** Posts a day: the budget now for today, the most it could reach for any later day. */
  async function limitOn(tx: SocialTx, workspaceId: string, a: Account, on: string, timeZone: string, now: Date) {
    const health = await healthOf(tx, workspaceId, a, FLOOR, now);
    if (on === mailboxDay(now, timeZone)) return budgetOf(health).posts;
    return capOf({ posts: health.postsLower ?? undefined }).posts;
  }

  async function placeIn(tx: SocialTx, workspaceId: string, t: PlaceTarget, now: Date): Promise<Placed> {
    const a = isPost(t.capability) ? accountOf(t.credentialId, t.spec) : null;
    const setting = a && (await settingOf(tx, workspaceId, a));
    if (!a || !setting) return { at: t.wanted };
    await lockAccount(tx, a);
    const taken = (await countedAround(tx, a, mailboxDay(t.wanted, setting.timeZone), now, t.exceptActionId)).map((r) => r.slot);
    const placed = t.mode === "auto" ? place({ wanted: t.wanted, ...setting, taken, seed: t.seed }) : null;
    if (placed) return { at: placed };
    // An exact time, or no room left on the day: the wanted time stands, with a warning when it breaks the pace.
    const why = offPace(t.wanted, setting.pace, setting.timeZone, taken);
    return why ? { at: t.wanted, warning: warn("unspecified", WORDS[why](setting.pace)) } : { at: t.wanted };
  }

  async function reserveIn(tx: SocialTx, workspaceId: string, actionId: string, slot: Date, now: Date): Promise<CapacityResult> {
    const action = await postActionOf(tx, actionId);
    return action ? reservePostIn(tx, workspaceId, actionId, action, slot, now) : { kind: "not_found" };
  }

  async function reservePostIn(tx: SocialTx, workspaceId: string, actionId: string, action: PostAction, slot: Date, now: Date): Promise<CapacityResult> {
    const a = isPost(action.capability) ? accountOf(action.credentialId, action.spec) : null;
    const setting = a && (await settingOf(tx, workspaceId, a));
    if (!a || !setting) return { kind: "not_counted" };
    await lockAccount(tx, a);
    const on = mailboxDay(slot, setting.timeZone);
    const own = await newestReservationFor(tx, actionId);
    const sameDay = own?.day === on && sameAccount(a, own);
    if (sameDay && own.slot.getTime() === slot.getTime()) return { kind: "reserved", day: on };
    if (!sameDay) {
      const limit = await limitOn(tx, workspaceId, a, on, setting.timeZone, now);
      const used = (await countedAround(tx, a, on, now, actionId)).filter((r) => r.day === on).length;
      if (used >= limit) return { kind: "full", day: on, limit, reason: "account_day_full" };
    }
    await insertReservation(tx, { workspaceId, actionId, ...a, day: on, slot });
    return { kind: "reserved", day: on };
  }

  async function nextPostTimeIn(tx: SocialTx, workspaceId: string, actionId: string, action: PostAction, wanted: Date, now: Date): Promise<Date> {
    const placed = await placeIn(tx, workspaceId, { capability: action.capability, credentialId: action.credentialId, spec: action.spec, seed: action.idempotencyKey, wanted, mode: "auto", exceptActionId: actionId }, now);
    return placed.at;
  }

  return {
    placeIn,
    reserveIn,
    reserve: (workspaceId, actionId, slot, opts) => inWorkspace(workspaceId, (tx) => reserveIn(tx, workspaceId, actionId, slot, opts?.now ?? new Date())),
    /** No person is there to choose: placeIn keeps the wanted time when nothing fits. */
    nextTime: (workspaceId, actionId, from, opts) =>
      inWorkspace(workspaceId, async (tx) => {
        const action = await postActionOf(tx, actionId);
        return action ? nextPostTimeIn(tx, workspaceId, actionId, action, from, opts?.now ?? new Date()) : from;
      }),
    reserveAutomatic: (workspaceId, actionId, wanted, now, checkSlot) =>
      withGroupRetry(workspaceId, async (tx) => {
        const action = await postActionOf(tx, actionId);
        if (!action) return { slot: wanted, result: { kind: "not_found" } };
        // Any Person-group lock comes before the account's (ADR 0038).
        await checkSlot?.lock(tx);
        const slot = await nextPostTimeIn(tx, workspaceId, actionId, action, wanted, now);
        const check = await checkSlot?.check(tx, slot);
        if (check && check !== "ok") return { slot, result: { kind: check } };
        // The account lock acquired in placement stays held through the reservation.
        return { slot, result: await reservePostIn(tx, workspaceId, actionId, action, slot, now) };
      }),
  };
}
