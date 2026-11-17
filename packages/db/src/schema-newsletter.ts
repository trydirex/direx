// SPDX-License-Identifier: AGPL-3.0-only
// The Workspace's weekly newsletter: which list it goes to and when, and one row per issue with what
// the tool reported after sending.
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, jsonb, pgTable, primaryKey, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { credentials, items, workspaces } from "./schema";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const newsletterSettings = pgTable(
  "newsletter_settings",
  {
    workspaceId: uuid("workspace_id").primaryKey(),
    // "connected" sends through the credential's Kit or beehiiv list; "substack" is copied by hand.
    list: text("list").notNull(),
    credentialId: uuid("credential_id"),
    // ISO weekday, Monday 1 to Sunday 7, and a local time such as "09:00" in the time zone.
    weekday: smallint("weekday").notNull(),
    sendTime: text("send_time").notNull(),
    timeZone: text("time_zone").notNull(),
    enabled: boolean("enabled").notNull(),
    // Set when the tool refused to send on this plan; issues are copied by hand until it is cleared.
    readOnlySince: tz("read_only_since"),
    // The plan or reason the tool gave, such as "Pro"; set and cleared with read_only_since.
    readOnlyReason: text("read_only_reason"),
    lastSentAt: tz("last_sent_at"),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    foreignKey({ name: "newsletter_settings_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "newsletter_settings_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    check("newsletter_settings_list_check", sql`(${t.list} = 'connected' and ${t.credentialId} is not null) or (${t.list} = 'substack' and ${t.credentialId} is null)`),
    check("newsletter_settings_weekday_check", sql`${t.weekday} between 1 and 7`),
    check("newsletter_settings_send_time_check", sql`${t.sendTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
    check("newsletter_settings_read_only_check", sql`(${t.readOnlySince} is null) = (${t.readOnlyReason} is null)`),
  ],
);

export const newsletterIssues = pgTable(
  "newsletter_issues",
  {
    workspaceId: uuid("workspace_id").notNull(),
    id: uuid("id").notNull().defaultRandom(),
    slot: tz("slot").notNull(),
    itemId: uuid("item_id").notNull(),
    providerRef: text("provider_ref"),
    sentAt: tz("sent_at"),
    // What the tool reported: recipients, delivered (beehiiv), clicks, unsubscribes, opens.
    stats: jsonb("stats"),
    statsReadAt: tz("stats_read_at"),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.id] }),
    foreignKey({ name: "newsletter_issues_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "newsletter_issues_item_fk", columns: [t.workspaceId, t.itemId], foreignColumns: [items.workspaceId, items.id] }),
    // One issue per slot, so a second run of the weekly sweep makes nothing new.
    unique("newsletter_issues_slot_unique").on(t.workspaceId, t.slot),
  ],
);
