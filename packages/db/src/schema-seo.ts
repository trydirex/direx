// SPDX-License-Identifier: AGPL-3.0-only
// SEO briefs a person approved: the page, the query, the numbers that picked it and the page as it
// was read, kept so a later report can compare before and after. Rows are never edited.
import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { items, workspaces } from "./schema";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const seoBriefs = pgTable(
  "seo_briefs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    itemId: uuid("item_id").notNull(),
    pageUrl: text("page_url").notNull(),
    query: text("query").notNull(),
    selector: text("selector").notNull(),
    // Impressions, clicks, position and the date window they were read over.
    numbers: jsonb("numbers").notNull(),
    // The gaps the brief named.
    brief: jsonb("brief").notNull(),
    pageText: text("page_text").notNull(),
    pageReadAt: tz("page_read_at").notNull(),
    approvedBy: uuid("approved_by").notNull().references(() => user.id),
    approvedAt: tz("approved_at").notNull(),
  },
  (t) => [
    unique("seo_briefs_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("seo_briefs_item_key").on(t.workspaceId, t.itemId),
    index("seo_briefs_page_idx").on(t.workspaceId, t.pageUrl, t.approvedAt),
    foreignKey({ name: "seo_briefs_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "seo_briefs_item_fk", columns: [t.workspaceId, t.itemId], foreignColumns: [items.workspaceId, items.id] }),
    check("seo_briefs_selector_check", sql`${t.selector} in ('near_page_one', 'slipping', 'competing', 'step')`),
    check("seo_briefs_page_text_check", sql`octet_length(${t.pageText}) <= 204800`),
  ],
);
