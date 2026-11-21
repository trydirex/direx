// SPDX-License-Identifier: AGPL-3.0-only
import { bigint, boolean, index, integer, pgSchema, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Better Auth's own tables, in their own schema and outside tenancy: no workspace_id,
// no RLS. Only the identity module's adapters reach them, through authDb.
// Field names are Better Auth 1.7.14's; ids are uuids (advanced.database.generateId).

export const auth = pgSchema("auth");

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const user = auth.table("user", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: tz("created_at").notNull().defaultNow(),
  updatedAt: tz("updated_at").notNull().defaultNow(),
});

export const session = auth.table(
  "session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: tz("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

// Sign-in never keeps provider tokens: the identity module clears accessToken,
// refreshToken and idToken before insert. Mailbox access goes through the vault.
export const account = auth.table(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: tz("access_token_expires_at"),
    refreshTokenExpiresAt: tz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = auth.table(
  "verification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: tz("expires_at").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// Better Auth's rate limit counters (rateLimit.storage "database"), so every API process counts
// the same sign-in attempts and a restart doesn't clear them. `key` is the client address and path;
// `last_request` is epoch milliseconds, and Better Auth prunes old rows on that index.
export const rateLimit = auth.table(
  "rate_limit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull().unique(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (t) => [index("rate_limit_last_request_idx").on(t.lastRequest)],
);
