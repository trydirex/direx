// SPDX-License-Identifier: AGPL-3.0-only
// Tracked links (ADR 0035): a Campaign's links rewritten onto the customer's own tracking domain, and
// which message used which link. Click counts, per-Person clicks, marks and the redirect's rate
// counter come with the code that writes them. Nothing here holds a client IP address, user agent or other request
// header (rule 009). Links never change once made (rule 004), so the app may not update or delete them.
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { actions, people, workspaces } from "./schema";
import { campaignDms, campaigns } from "./schema-campaigns";

const tz = (name: string) => timestamp(name, { withTimezone: true });

// A hostname of the customer's own, pointed at the deployment by CNAME. One Workspace per hostname on
// the whole deployment (rule 007), which the unique index holds across tenants.
export const trackingDomains = pgTable(
  "tracking_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    // Lowercase, international names as punycode: the form the edge asks about.
    hostname: text("hostname").notNull(),
    // What the `_direx-tracking.<hostname>` TXT record must hold.
    txtValue: text("txt_value").notNull(),
    state: text("state").notNull().default("pending"),
    checkedAt: tz("checked_at"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("tracking_domains_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("tracking_domains_hostname_key").on(t.hostname),
    foreignKey({ name: "tracking_domains_workspace_fk", columns: [t.workspaceId], foreignColumns: [workspaces.workspaceId] }),
    check("tracking_domains_state_check", sql`${t.state} in ('pending', 'dns_ok', 'verified', 'stopped')`),
    check("tracking_domains_hostname_check", sql`${t.hostname} = lower(${t.hostname}) and ${t.hostname} ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' and length(${t.hostname}) <= 253`),
  ],
);

// One destination of one step, the same URL for every recipient of that step (rule 011). A check-only
// link serves Placement content checks: it redirects and never counts (rule 002).
export const trackedLinks = pgTable(
  "tracked_links",
  {
    // 128 random bits as base64url (rule 005).
    id: text("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    campaignId: uuid("campaign_id").notNull(),
    stepKey: text("step_key").notNull(),
    domainId: uuid("domain_id").notNull(),
    destination: text("destination").notNull(),
    checkOnly: boolean("check_only").notNull().default(false),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("tracked_links_workspace_id_id_key").on(t.workspaceId, t.id),
    // A step reuses its link for the same destination.
    unique("tracked_links_destination_key").on(t.workspaceId, t.campaignId, t.stepKey, t.domainId, t.destination, t.checkOnly),
    foreignKey({ name: "tracked_links_campaign_fk", columns: [t.workspaceId, t.campaignId], foreignColumns: [campaigns.workspaceId, campaigns.id] }),
    foreignKey({ name: "tracked_links_domain_fk", columns: [t.workspaceId, t.domainId], foreignColumns: [trackingDomains.workspaceId, trackingDomains.id] }),
    check("tracked_links_id_check", sql`${t.id} ~ '^[A-Za-z0-9_-]{22}$'`),
    check("tracked_links_destination_check", sql`${t.destination} like 'https://%' and length(${t.destination}) <= 2048`),
  ],
);

// One message's use of a link: an Action (email, post, Placement check) or a DM. A per-Person token is
// per use, never per Person, so it builds no profile across Campaigns (rule 005); only its SHA-256 is kept.
export const trackedLinkUses = pgTable(
  "tracked_link_uses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    linkId: text("link_id").notNull(),
    actionId: uuid("action_id"),
    dmId: uuid("dm_id"),
    tokenHash: text("token_hash"),
    personId: uuid("person_id"),
    // The tracking inputs when the draft was fixed; a change before dispatch holds the Action (rule 015).
    inputsHash: text("inputs_hash").notNull(),
    sentAt: tz("sent_at"),
    createdAt: tz("created_at").notNull(),
  },
  (t) => [
    unique("tracked_link_uses_workspace_id_id_key").on(t.workspaceId, t.id),
    unique("tracked_link_uses_token_hash_key").on(t.tokenHash),
    index("tracked_link_uses_action_idx").on(t.workspaceId, t.actionId),
    index("tracked_link_uses_link_idx").on(t.workspaceId, t.linkId),
    foreignKey({ name: "tracked_link_uses_link_fk", columns: [t.workspaceId, t.linkId], foreignColumns: [trackedLinks.workspaceId, trackedLinks.id] }),
    foreignKey({ name: "tracked_link_uses_action_fk", columns: [t.workspaceId, t.actionId], foreignColumns: [actions.workspaceId, actions.id] }),
    foreignKey({ name: "tracked_link_uses_dm_fk", columns: [t.workspaceId, t.dmId], foreignColumns: [campaignDms.workspaceId, campaignDms.id] }),
    foreignKey({ name: "tracked_link_uses_person_fk", columns: [t.workspaceId, t.personId], foreignColumns: [people.workspaceId, people.id] }),
    check("tracked_link_uses_one_message_check", sql`(${t.actionId} is null) <> (${t.dmId} is null)`),
    check("tracked_link_uses_token_check", sql`(${t.tokenHash} is null) = (${t.personId} is null)`),
    check("tracked_link_uses_token_hash_check", sql`${t.tokenHash} is null or ${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    // DMs never carry a token (rule 012).
    check("tracked_link_uses_dm_token_check", sql`${t.dmId} is null or ${t.tokenHash} is null`),
  ],
);
