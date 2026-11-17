// SPDX-License-Identifier: AGPL-3.0-only
// External tokens (ADR 0032 rule 005): the one credential a caller outside a session gets. Only the
// token's SHA-256 is kept, with a 4-character hint to tell tokens apart. What a token may read and
// propose is fixed when it is made; the app may change only who revoked it, when, and when it was
// last used (migration grants), and never deletes a row.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { workspaces } from "./schema";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const externalTokens = pgTable(
  "external_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    hint: text("hint").notNull(),
    readers: text("readers").array().notNull(),
    kinds: text("kinds").array().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: tz("created_at").notNull(),
    expiresAt: tz("expires_at").notNull(),
    revokedBy: uuid("revoked_by").references(() => user.id),
    revokedAt: tz("revoked_at"),
    lastUsedAt: tz("last_used_at"),
  },
  (t) => [
    foreignKey({ name: "external_tokens_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    unique("external_tokens_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("external_tokens_workspace_id_token_hash_key").on(t.workspaceId, t.tokenHash),
    check("external_tokens_name_check", sql`char_length(${t.name}) between 1 and 60`),
    check("external_tokens_token_hash_check", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("external_tokens_hint_check", sql`char_length(${t.hint}) = 4`),
    // A token always expires, and never more than a year after it was made.
    check("external_tokens_expiry_check", sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '365 days'`),
    check("external_tokens_revoked_check", sql`(${t.revokedBy} is null) = (${t.revokedAt} is null)`),
  ],
);

/** Every way a door request ends; one row each, with no input or output (ADR 0032 rule 011). */
export const DOOR_OUTCOMES = ["ok", "invalid_input", "reader_not_allowed", "rate_limited", "too_large", "bad_cursor", "error"] as const;

// One row per door request made with a live token: which reader, how it ended and when, never what
// was asked or answered. Append-only for the app. It grows with use, so it is on the large list; the
// primary key leads with the token, which is the index the tokens page reads its latest rows by.
export const doorRequests = pgTable(
  "door_requests",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    tokenId: uuid("token_id").notNull(),
    reader: text("reader").notNull(),
    outcome: text("outcome").notNull(),
    at: tz("at").notNull(),
  },
  (t) => [
    primaryKey({ name: "door_requests_pkey", columns: [t.workspaceId, t.tokenId, t.id] }),
    foreignKey({ name: "door_requests_token_fk", columns: [t.workspaceId, t.tokenId], foreignColumns: [externalTokens.workspaceId, externalTokens.id] }),
    check("door_requests_outcome_check", sql.raw(`outcome in (${DOOR_OUTCOMES.map((o) => `'${o}'`).join(", ")})`)),
  ],
);

// Requests counted per minute, per token (`token:<id>`) and per Workspace (`workspace`), so every API
// process shares one count (ADR 0032 rule 006). Rows older than a few minutes are deleted as requests
// come in, so the table stays small.
export const doorCounters = pgTable(
  "door_counters",
  {
    workspaceId: uuid("workspace_id").notNull(),
    scope: text("scope").notNull(),
    minute: tz("minute").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [
    primaryKey({ name: "door_counters_pkey", columns: [t.workspaceId, t.scope, t.minute] }),
    foreignKey({ name: "door_counters_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    check("door_counters_count_check", sql`${t.count} > 0`),
  ],
);
