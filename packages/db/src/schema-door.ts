// SPDX-License-Identifier: AGPL-3.0-only
// External tokens (ADR 0032 rule 005): the one credential a caller outside a session gets. Only the
// token's SHA-256 is kept, with a 4-character hint to tell tokens apart. What a token may read and
// propose is fixed when it is made; the app may change only who revoked it, when, and when it was
// last used (migration grants), and never deletes a row.
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { items, workspaces } from "./schema";

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
export const DOOR_OUTCOMES = [
  "ok",
  "invalid_input",
  "reader_not_allowed",
  "rate_limited",
  "too_large",
  "bad_cursor",
  "error",
  // A proposal's refusals (ADR 0032 rules 004 and 006).
  "kind_not_allowed",
  "already_waiting",
  "idempotency_conflict",
  "proposal_cap",
  "refused",
] as const;

// One row per door request made with a live token: which reader or proposal kind, how it ended and
// when, never what was asked or answered. Append-only for the app. It grows with use, so it is on the
// large list; the primary key leads with the token, which is the index the tokens page reads its
// latest rows by. `operation` replaces `reader`, which only fits reads (DX-R-0029-005, migration 0151):
// every new row gets both; a later release fills `operation` on older rows in batches, makes it NOT NULL
// and drops `reader`, and reads move to `operation` then.
export const doorRequests = pgTable(
  "door_requests",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity(),
    workspaceId: uuid("workspace_id").notNull(),
    tokenId: uuid("token_id").notNull(),
    reader: text("reader").notNull(),
    operation: text("operation"),
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

// One row per proposal a token made, keyed by the token's idempotency key so a retry with the same key
// and body gets the same Item back, and a reused key with another body is refused (ADR 0032 rule 004).
// The body itself is never kept, only its SHA-256. Append-only for the app, and on the large list.
export const doorProposals = pgTable(
  "door_proposals",
  {
    workspaceId: uuid("workspace_id").notNull(),
    tokenId: uuid("token_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    bodyDigest: text("body_digest").notNull(),
    kind: text("kind").notNull(),
    // Null records a successful proposal that required no Item.
    itemId: uuid("item_id"),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ name: "door_proposals_pkey", columns: [t.workspaceId, t.tokenId, t.idempotencyKey] }),
    foreignKey({ name: "door_proposals_token_fk", columns: [t.workspaceId, t.tokenId], foreignColumns: [externalTokens.workspaceId, externalTokens.id] }),
    foreignKey({ name: "door_proposals_item_fk", columns: [t.workspaceId, t.itemId], foreignColumns: [items.workspaceId, items.id] }),
    check("door_proposals_key_check", sql`char_length(${t.idempotencyKey}) between 1 and 200`),
    check("door_proposals_body_digest_check", sql`${t.bodyDigest} ~ '^[0-9a-f]{64}$'`),
    check("door_proposals_kind_check", sql`${t.kind} in ('fact_proposal', 'draft')`),
  ],
);
