// SPDX-License-Identifier: AGPL-3.0-only
// Ask Direx: what a person typed, and the reply their run handed back. Each person has their own
// conversation in a Workspace. Streamed text is never stored; only the reply the run proposed.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { items, workspaces } from "./schema";
import { agentRuns } from "./schema-agents";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const askMessages = pgTable(
  "ask_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id),
    text: text("text").notNull(),
    // The Item the person asked about, when they opened Ask from one.
    itemId: uuid("item_id"),
    // The Agent the person named with @, as its id.
    agent: text("agent"),
    // Null when the run could not start; the reply then says why.
    runId: uuid("run_id"),
    // The run's typed reply: an answer, a question, cannot, or what it proposed.
    reply: jsonb("reply"),
    createdAt: tz("created_at").notNull(),
    // The order messages were written in, which two sent in the same instant still have (rule 022).
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
  },
  (t) => [
    unique("ask_messages_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("ask_messages_run_key").on(t.workspaceId, t.runId),
    foreignKey({ name: "ask_messages_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "ask_messages_item_fk", columns: [t.workspaceId, t.itemId], foreignColumns: [items.workspaceId, items.id] }),
    foreignKey({ name: "ask_messages_run_fk", columns: [t.workspaceId, t.runId], foreignColumns: [agentRuns.workspaceId, agentRuns.id] }),
    index("ask_messages_conversation").on(t.workspaceId, t.userId, t.createdAt),
    check("ask_messages_text_check", sql`length(${t.text}) between 1 and 4000`),
  ],
);

// One row per accepted `ask_start` Item (ADR 0008 rules 028 and 029). Written in the approval's
// transaction; the start job then records the work it made, or the code it was refused with.
// The Item id is the start's idempotency key.
export const askStarts = pgTable(
  "ask_starts",
  {
    workspaceId: uuid("workspace_id").notNull(),
    itemId: uuid("item_id").notNull(),
    // The reply that offered the Item, so the done line finds it.
    messageId: uuid("message_id").notNull(),
    // What the owning module started: its kind (an agent run, a clip run, a company read) and id.
    workKind: text("work_kind"),
    workId: text("work_id"),
    refused: text("refused"),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "ask_starts_pkey", columns: [t.workspaceId, t.itemId] }),
    foreignKey({ name: "ask_starts_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "ask_starts_item_fk", columns: [t.workspaceId, t.itemId], foreignColumns: [items.workspaceId, items.id] }),
    foreignKey({ name: "ask_starts_message_fk", columns: [t.workspaceId, t.messageId], foreignColumns: [askMessages.workspaceId, askMessages.id] }),
    index("ask_starts_message").on(t.workspaceId, t.messageId),
    check("ask_starts_work_check", sql`(${t.workKind} is null) = (${t.workId} is null)`),
    check("ask_starts_outcome_check", sql`${t.workKind} is null or ${t.refused} is null`),
  ],
);
