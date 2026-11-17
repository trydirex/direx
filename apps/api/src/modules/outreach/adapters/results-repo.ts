// SPDX-License-Identifier: AGPL-3.0-only
// What Home's replies and opt-outs are compared on, and the facts that may explain them. Reads only.
import { actions, items } from "@direx/db/schema";
import { campaigns } from "@direx/db/schema-campaigns";
import { replySignals } from "@direx/db/schema-outreach";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { ResultFacts } from "../domain/results";
import { countReplies, type OutreachTx } from "./repo";

async function sentBetween(tx: OutreachTx, from: Date, to: Date): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(actions)
    .innerJoin(items, eq(items.actionId, actions.id))
    .where(and(eq(actions.state, "sent"), eq(items.channel, "email"), gte(actions.firstDispatchedAt, from), lt(actions.firstDispatchedAt, to)));
  return r!.n;
}

/** [from, mid) is the window before, [mid, to) this one. */
export async function resultFacts(tx: OutreachTx, from: Date, mid: Date, to: Date): Promise<ResultFacts> {
  const [now, before] = [await countReplies(tx, mid, to), await countReplies(tx, from, mid)];
  const bySubject = await tx
    .select({ subject: items.title, replies: sql<number>`count(*)::int`, optedOut: sql<number>`count(*) filter (where ${replySignals.status} = 'opted_out')::int` })
    .from(replySignals)
    .innerJoin(items, eq(items.actionId, replySignals.actionId))
    .where(and(eq(replySignals.kind, "reply"), gte(replySignals.receivedAt, mid), lt(replySignals.receivedAt, to)))
    .groupBy(items.title)
    .orderBy(desc(sql`count(*)`))
    .limit(3);
  const paused = await tx.select({ at: campaigns.pausedAt }).from(campaigns).where(and(gte(campaigns.pausedAt, from), lt(campaigns.pausedAt, to)));
  return {
    replies: { now: now.replies, before: before.replies },
    optedOut: { now: now.optedOut, before: before.optedOut },
    sent: { now: await sentBetween(tx, mid, to), before: await sentBetween(tx, from, mid) },
    bySubject,
    pausedOn: paused.map((p) => p.at!),
  };
}
