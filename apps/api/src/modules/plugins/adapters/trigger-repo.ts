// SPDX-License-Identifier: AGPL-3.0-only
// Every SQL statement of the trigger intake: seen event ids, poll cursors and webhook addresses.
import { withWorkspace, type WorkspaceTx } from "@direx/db";
import { pluginWebhooks, triggerCursors, triggerEvents } from "@direx/db/schema";
import { and, eq } from "drizzle-orm";

export type PluginTx = WorkspaceTx;
export const inWorkspace = withWorkspace;

type Key = { workspaceId: string; pluginId: string; trigger: string; credentialId: string | null };

// One mailbox's history marker means nothing to another, so each credential keeps its own place.
const scoped = ({ workspaceId, pluginId, trigger, credentialId }: Key) => ({ workspaceId, pluginId, trigger, scope: credentialId ?? "" });

/**
 * Records the event ids not seen before and returns them. A concurrent transaction
 * inserting the same id waits for this one, then sees it as already seen.
 */
export async function markNew(tx: PluginTx, k: Key, eventIds: string[], at: Date): Promise<Set<string>> {
  const ids = [...new Set(eventIds)];
  if (!ids.length) return new Set();
  const rows = await tx
    .insert(triggerEvents)
    .values(ids.map((eventId) => ({ ...scoped(k), eventId, receivedAt: at })))
    .onConflictDoNothing()
    .returning({ eventId: triggerEvents.eventId });
  return new Set(rows.map((r) => r.eventId));
}

export type CursorRow = { cursor: string | null; version: number | null };

export async function readCursor(tx: PluginTx, k: Key): Promise<CursorRow> {
  const [row] = await tx
    .select({ cursor: triggerCursors.cursor, version: triggerCursors.version })
    .from(triggerCursors)
    .where(and(eq(triggerCursors.workspaceId, k.workspaceId), eq(triggerCursors.pluginId, k.pluginId), eq(triggerCursors.trigger, k.trigger), eq(triggerCursors.scope, scoped(k).scope)));
  return row ?? { cursor: null, version: null };
}

/** Moves the cursor only if it is still at `from`; false means another poll moved it first. */
export async function advanceCursor(tx: PluginTx, k: Key, from: CursorRow, cursor: string, at: Date): Promise<boolean> {
  if (from.version === null) {
    const rows = await tx
      .insert(triggerCursors)
      .values({ ...scoped(k), cursor, updatedAt: at })
      .onConflictDoNothing()
      .returning({ v: triggerCursors.version });
    return rows.length === 1;
  }
  const rows = await tx
    .update(triggerCursors)
    .set({ cursor, version: from.version + 1, updatedAt: at })
    .where(
      and(
        eq(triggerCursors.workspaceId, k.workspaceId),
        eq(triggerCursors.pluginId, k.pluginId),
        eq(triggerCursors.trigger, k.trigger),
        eq(triggerCursors.scope, scoped(k).scope),
        eq(triggerCursors.version, from.version),
      ),
    )
    .returning({ v: triggerCursors.version });
  return rows.length === 1;
}

export type WebhookRow = typeof pluginWebhooks.$inferSelect;

/** False when this trigger already has a webhook in the Workspace. */
export async function insertWebhook(tx: PluginTx, row: typeof pluginWebhooks.$inferInsert): Promise<boolean> {
  return (await tx.insert(pluginWebhooks).values(row).onConflictDoNothing().returning({ id: pluginWebhooks.id })).length === 1;
}

export async function webhookById(tx: PluginTx, id: string): Promise<WebhookRow | null> {
  const [row] = await tx.select().from(pluginWebhooks).where(eq(pluginWebhooks.id, id));
  return row ?? null;
}

export async function webhookFor(tx: PluginTx, pluginId: string, trigger: string): Promise<WebhookRow | null> {
  const [row] = await tx.select().from(pluginWebhooks).where(and(eq(pluginWebhooks.pluginId, pluginId), eq(pluginWebhooks.trigger, trigger)));
  return row ?? null;
}

export const webhooksIn = (tx: PluginTx): Promise<WebhookRow[]> => tx.select().from(pluginWebhooks).orderBy(pluginWebhooks.createdAt);

/** When this trigger last read its source successfully, or null if it never has. */
export async function lastPollAt(tx: PluginTx, k: Key): Promise<Date | null> {
  const [row] = await tx
    .select({ at: triggerCursors.updatedAt })
    .from(triggerCursors)
    .where(and(eq(triggerCursors.workspaceId, k.workspaceId), eq(triggerCursors.pluginId, k.pluginId), eq(triggerCursors.trigger, k.trigger), eq(triggerCursors.scope, scoped(k).scope)));
  return row?.at ?? null;
}
