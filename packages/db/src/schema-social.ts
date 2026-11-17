// SPDX-License-Identifier: AGPL-3.0-only
// What a Workspace can post to. One login can reach several targets, such as a person's Pages, so
// each target is a row under its credential. No token is held here: Page tokens are fetched at call time.
import { sql } from "drizzle-orm";
import { check, foreignKey, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { actions, bytea, credentials, items, workspaces } from "./schema";
import { campaignSteps } from "./schema-campaigns";
import { clips } from "./schema-clips";

const tz = (name: string) => timestamp(name, { withTimezone: true });

export const socialAccounts = pgTable(
  "social_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    connection: text("connection").notNull(),
    accountType: text("account_type").notNull(),
    networkId: text("network_id").notNull(),
    name: text("name").notNull(),
    lastCheckedAt: tz("last_checked_at"),
    createdAt: tz("created_at").notNull().defaultNow(),
    // Where the account itself says who runs it, as a person wrote it; null until they do.
    runBy: text("run_by"),
    // What this account is for, beside the Workspace's other accounts on the same network.
    angle: text("angle"),
  },
  (t) => [
    foreignKey({ name: "social_accounts_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    foreignKey({ name: "social_accounts_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    unique("social_accounts_target_unique").on(t.credentialId, t.networkId),
    check("social_accounts_about_check", sql`char_length(${t.runBy}) <= 200 and char_length(${t.angle}) <= 200`),
  ],
);

// How much one account may publish in a day, and whether it is paused. Today's use is counted from
// the ledger, never stored. Budgets only grow through the daily sweep and only shrink on a warning
// sign or a person's lower limit; the ceiling lives in code.
export const socialAccountHealth = pgTable(
  "social_account_health",
  {
    workspaceId: uuid("workspace_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    networkId: text("network_id").notNull(),
    posts: integer("posts").notNull(),
    replies: integer("replies").notNull(),
    links: integer("links").notNull(),
    // A person's lower limits; null where they set none.
    postsLower: integer("posts_lower"),
    repliesLower: integer("replies_lower"),
    linksLower: integer("links_lower"),
    // Clean since the last step, pause or unpause; the sweep steps from here.
    cleanSince: tz("clean_since").notNull(),
    pausedAt: tz("paused_at"),
    pauseReason: text("pause_reason"),
    pauseDetail: text("pause_detail"),
    updatedAt: tz("updated_at").notNull(),
  },
  (t) => [
    unique("social_account_health_account").on(t.workspaceId, t.credentialId, t.networkId),
    foreignKey({ name: "social_account_health_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    check("social_account_health_counts_check", sql`${t.posts} >= 0 and ${t.replies} >= 0 and ${t.links} >= 0`),
    check("social_account_health_pause_check", sql`(${t.pausedAt} is null) = (${t.pauseReason} is null)`),
  ],
);

// One post per Network account per campaign step, or per clip for a clips step. Not tied to social_accounts: a post outlives a
// disconnect, and a copy-and-paste post may have no connected account at all. Nothing is deleted. A post a person wrote on the
// Calendar has no campaign, and its step key is `calendar:<item id>`, so each is its own.
export const socialPosts = pgTable(
  "social_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id"),
    stepKey: text("step_key").notNull(),
    connection: text("connection").notNull(),
    // Empty for copy and paste with no connected account.
    networkId: text("network_id").notNull(),
    credentialId: uuid("credential_id"),
    accountName: text("account_name"),
    itemId: uuid("item_id").notNull(),
    // Null for copy and paste, which never reaches the ledger.
    actionId: uuid("action_id"),
    postedUrl: text("posted_url"),
    // The clip a clips step posts here; null for a post step. One account may carry several clips of one step.
    clipId: uuid("clip_id"),
    // The first link in the post's text as the network would show it: { url, preview } where preview is
    // { title, description, site } or null when the page couldn't be read. Read once per link, on view.
    linkPreview: jsonb("link_preview"),
    // That page's image, fetched once and served from Direx so the browser never loads another site.
    linkImage: bytea("link_image"),
    linkImageType: text("link_image_type"),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("social_posts_one_per_account").on(t.workspaceId, t.campaignId, t.stepKey, t.connection, t.networkId, t.clipId).nullsNotDistinct(),
    foreignKey({ name: "social_posts_step_fk", columns: [t.workspaceId, t.campaignId, t.stepKey], foreignColumns: [campaignSteps.workspaceId, campaignSteps.campaignId, campaignSteps.stepKey] }),
    foreignKey({ name: "social_posts_credential_fk", columns: [t.workspaceId, t.credentialId], foreignColumns: [credentials.workspaceId, credentials.id] }),
    foreignKey({ name: "social_posts_item_fk", columns: [t.workspaceId, t.itemId], foreignColumns: [items.workspaceId, items.id] }),
    foreignKey({ name: "social_posts_action_fk", columns: [t.workspaceId, t.actionId], foreignColumns: [actions.workspaceId, actions.id] }),
    foreignKey({ name: "social_posts_clip_fk", columns: [t.workspaceId, t.clipId], foreignColumns: [clips.workspaceId, clips.id] }),
  ],
);
