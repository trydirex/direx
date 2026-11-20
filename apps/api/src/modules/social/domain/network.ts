// SPDX-License-Identifier: AGPL-3.0-only
// What this module needs to know of a social network: the descriptions the composition root passes
// in (the first-party ones live with their plugins). Core imports no plugin package.

export type SocialAvailability = "available" | "awaiting_approval" | "not_built" | "not_available";

export type NetworkFeature = {
  key: "publish" | "links" | "follow_ups" | "video" | "image" | "analytics" | "comments";
  built: boolean;
  /** Granted scopes it needs; a missing one offers a reconnect. */
  scopes: readonly string[];
  needsOwnApp?: boolean;
  needsPublicUrl?: boolean;
};

export type SocialNetworkInfo = {
  connection: string;
  label: string;
  variantOf?: string;
  accountTypes: readonly string[];
  connect: "oauth" | "form";
  availability: { cloud: SocialAvailability; self_host: SocialAvailability };
  features: readonly NetworkFeature[];
  tokenEnds?: boolean;
  noDailyHealth?: boolean;
  monthlyPostLimit?: number;
  /** The most characters one post takes, counted in code points. */
  postLimit?: number;
  noIdenticalAcrossAccounts?: boolean;
  angleForEachAccount?: boolean;
  fields?: readonly { name: string; label: string; optional?: boolean }[];
  /** Shown under "can do" while the Workspace's own app is in use. */
  ownAppLimits?: readonly string[];
  wizard?: { consoleUrl: string; scopes: readonly string[]; steps: readonly string[] };
};
