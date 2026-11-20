// SPDX-License-Identifier: AGPL-3.0-only
// What the app shows for each social network, so it holds no network names. A plugin's capabilities
// are in its manifest; this is how a person connects it and what it can do for them.
import { FACEBOOK_SCOPES } from "./social/facebook/provider";
import { INSTAGRAM_SCOPES } from "./social/instagram/provider";
import { LINKEDIN_SCOPES } from "./social/linkedin/provider";
import { THREADS_SCOPES } from "./social/threads/provider";
import { X_SCOPES } from "./social/x/provider";
import { YOUTUBE_SCOPES } from "./social/youtube/provider";

export type SocialAvailability = "available" | "awaiting_approval" | "not_built" | "not_available";

export type NetworkFeature = {
  key: "publish" | "links" | "follow_ups" | "video" | "image" | "analytics" | "comments";
  /** Set once the module behind this feature is built on this network. */
  built: boolean;
  /** Granted scopes it needs; a missing one offers a reconnect. */
  scopes: readonly string[];
  /** Direx's choice on cost: the feature needs the Workspace's own app for this network. */
  needsOwnApp?: boolean;
  /** The network fetches from Direx itself, so this works only where Direx has a public address. */
  needsPublicUrl?: boolean;
};

export type SocialNetworkInfo = {
  connection: string;
  label: string;
  /** Another way into a network already listed, on an app of its own. */
  variantOf?: string;
  accountTypes: readonly string[];
  connect: "oauth" | "form";
  availability: { cloud: SocialAvailability; self_host: SocialAvailability };
  features: readonly NetworkFeature[];
  /** The token's end needs a person, so warn before it. A token that renews itself warns only for its grant. */
  tokenEnds?: boolean;
  /** Reads are billed per call on this network, so no daily check runs. */
  noDailyHealth?: boolean;
  /** Posts a month per Workspace on Direx's own app, because Direx pays for each. */
  monthlyPostLimit?: number;
  /** The most characters one post takes, counted in code points. A post copied by hand has no plugin to count it, so this warns before approval. */
  postLimit?: number;
  /** The network's rules treat one text on several of its accounts as spam, so it warns. */
  noIdenticalAcrossAccounts?: boolean;
  /** The network allows several accounts only for different purposes, so each one after the first states its own. */
  angleForEachAccount?: boolean;
  fields?: readonly { name: string; label: string; optional?: boolean }[];
  /** Sentences shown under "can do" while the Workspace's own app is in use. */
  ownAppLimits?: readonly string[];
  /** How a self-hoster registers their own app. */
  wizard?: { consoleUrl: string; scopes: readonly string[]; steps: readonly string[] };
};

const awaiting = { cloud: "awaiting_approval", self_host: "awaiting_approval" } as const;
const feature = (key: NetworkFeature["key"], scopes: readonly string[] = [], over: Partial<NetworkFeature> = {}): NetworkFeature => ({ key, built: false, scopes, ...over });

const BUILT = { built: true };

// Meta's apps in development mode let only people with a role on the app sign in.
const META_OWN_APP_LIMITS = ["While your app is in development mode, only accounts with a role on the app can connect."];

const unbuilt = (connection: string, label: string, ...accountTypes: string[]): SocialNetworkInfo => ({
  connection,
  label,
  accountTypes,
  connect: "oauth",
  availability: { cloud: "not_built", self_host: "not_built" },
  features: [],
});

export const socialNetworks = (): readonly SocialNetworkInfo[] => [
  {
    ...unbuilt("linkedin", "LinkedIn", "member"),
    postLimit: 3000,
    availability: awaiting,
    tokenEnds: true,
    features: [feature("publish", ["w_member_social"], BUILT), feature("links", ["w_member_social"], BUILT), feature("video", ["w_member_social"], BUILT), feature("image", ["w_member_social"], BUILT), feature("analytics", ["r_member_postAnalytics"]), feature("comments", ["w_member_social_feed"])],
    wizard: {
      consoleUrl: "https://www.linkedin.com/developers/apps",
      scopes: LINKEDIN_SCOPES,
      steps: [
        "Create an app. LinkedIn may ask you to link a Page to it.",
        "Under Products, add Sign In with LinkedIn using OpenID Connect, and Share on LinkedIn.",
        "Under Auth, add the callback URL below. LinkedIn only accepts HTTPS.",
        "Copy the client ID and client secret into the fields below.",
      ],
    },
  },
  // LinkedIn offers this only to registered legal organisations, so it stays unbuilt until a company exists.
  { ...unbuilt("linkedin_page", "LinkedIn Pages", "page"), variantOf: "linkedin", tokenEnds: true, postLimit: 3000 },
  {
    ...unbuilt("x", "X", "user"),
    postLimit: 280,
    availability: awaiting,
    noDailyHealth: true,
    monthlyPostLimit: 500,
    noIdenticalAcrossAccounts: true,
    // X's developer rules forbid several accounts "for same duplicative purpose".
    angleForEachAccount: true,
    // Direx pays per post on its own app, so links, analytics and comments need the Workspace's own X keys.
    features: [
      feature("publish", ["tweet.write"], BUILT),
      feature("links", ["tweet.write"], { ...BUILT, needsOwnApp: true }),
      // Not built until the pilot's X app shows its tier allows media upload; the plugin already uploads.
      feature("video", ["tweet.write", "media.write"]),
      feature("image", ["tweet.write", "media.write"]),
      feature("analytics", ["tweet.read"], { needsOwnApp: true }),
      feature("comments", ["tweet.read", "tweet.write"], { needsOwnApp: true }),
    ],
    wizard: {
      consoleUrl: "https://console.x.com",
      scopes: X_SCOPES,
      steps: [
        "Create an app and choose Web App as its type. X bills your account for what it uses.",
        "Add the callback URL below. Use 127.0.0.1, not localhost, for local work.",
        "Copy the OAuth 2.0 client ID and client secret into the fields below. The API key and secret won't work.",
      ],
    },
  },
  {
    ...unbuilt("bluesky", "Bluesky", "user"),
    postLimit: 300,
    connect: "form",
    availability: awaiting,
    fields: [
      { name: "username", label: "Bluesky handle" },
      { name: "password", label: "App password, from Bluesky's settings" },
    ],
    features: [feature("publish", [], BUILT), feature("links", [], BUILT), feature("follow_ups", [], BUILT), feature("video", [], BUILT), feature("image", [], BUILT), feature("analytics"), feature("comments")],
  },
  {
    ...unbuilt("facebook", "Facebook", "page"),
    availability: awaiting,
    ownAppLimits: META_OWN_APP_LIMITS,
    tokenEnds: true,
    features: [feature("publish", ["pages_manage_posts", "pages_read_engagement"], BUILT), feature("links", ["pages_manage_posts", "pages_read_engagement"], BUILT), feature("follow_ups", ["pages_manage_engagement"], BUILT), feature("video", ["pages_manage_posts", "pages_read_engagement"], BUILT), feature("image", ["pages_manage_posts", "pages_read_engagement"]), feature("analytics", ["read_insights"]), feature("comments", ["pages_read_engagement", "pages_read_user_content", "pages_manage_engagement"])],
    wizard: {
      consoleUrl: "https://developers.facebook.com/apps",
      scopes: FACEBOOK_SCOPES,
      steps: ["Create a Business type app and add Facebook Login.", "Add the callback URL below as a valid OAuth redirect URI.", "Copy the app ID and app secret into the fields below."],
    },
  },
  {
    ...unbuilt("instagram", "Instagram", "professional"),
    postLimit: 2200,
    availability: awaiting,
    ownAppLimits: META_OWN_APP_LIMITS,
    features: [feature("publish", ["instagram_business_content_publish"]), feature("links", ["instagram_business_content_publish"]), feature("analytics", ["instagram_business_manage_insights"]), feature("comments", ["instagram_business_manage_comments"])],
    wizard: {
      consoleUrl: "https://developers.facebook.com/apps",
      scopes: INSTAGRAM_SCOPES,
      steps: [
        "Create a Business type app and add Instagram. Only professional accounts can connect.",
        "Add the callback URL below. Meta may add a trailing slash, which must match exactly.",
        "Add your Instagram account to the app in the dashboard.",
        "Copy the Instagram app ID and secret into the fields below.",
      ],
    },
  },
  {
    ...unbuilt("threads", "Threads", "profile"),
    postLimit: 500,
    availability: awaiting,
    ownAppLimits: META_OWN_APP_LIMITS,
    features: [feature("publish", ["threads_content_publish"], BUILT), feature("links", ["threads_content_publish"], BUILT), feature("follow_ups", ["threads_manage_replies"], BUILT), feature("video", ["threads_content_publish"], { ...BUILT, needsPublicUrl: true }), feature("image", ["threads_content_publish"], { needsPublicUrl: true }), feature("analytics", ["threads_manage_insights"]), feature("comments", ["threads_read_replies", "threads_manage_replies"])],
    wizard: {
      consoleUrl: "https://developers.facebook.com/apps",
      scopes: THREADS_SCOPES,
      steps: ["Create a Business type app and add Threads.", "Add the callback URL below. Meta may add a trailing slash, which must match exactly.", "Invite your Threads account as a tester, then accept in Threads settings.", "Copy the Threads app ID and secret into the fields below."],
    },
  },
  {
    ...unbuilt("youtube", "YouTube", "channel"),
    availability: awaiting,
    ownAppLimits: ["In Personal mode, only the Google account that made the app can connect.", "In production without Google's review, people see a warning screen first, and at most 100 can ever connect."],
    features: [feature("video", ["https://www.googleapis.com/auth/youtube.upload"]), feature("analytics", ["https://www.googleapis.com/auth/yt-analytics.readonly"]), feature("comments", ["https://www.googleapis.com/auth/youtube.force-ssl"])],
    wizard: {
      consoleUrl: "https://console.cloud.google.com/apis/credentials",
      scopes: YOUTUBE_SCOPES,
      steps: [
        "Create a Google Cloud project, or reuse the one you made for Search Console.",
        "Enable the YouTube Data API v3.",
        "On the OAuth consent screen, choose Personal if only you will connect. Otherwise choose External and set it In production. Don't leave it in Testing: Google ends its tokens after 7 days.",
        "Create an OAuth client of type Web application, and add the callback URL below as an authorized redirect URI.",
        "Copy the client ID and client secret into the fields below.",
      ],
    },
  },
  unbuilt("gmb", "Google Business Profile", "location"),
  unbuilt("tiktok", "TikTok", "creator", "business"),
  unbuilt("pinterest", "Pinterest", "user"),
  unbuilt("dribbble", "Dribbble", "user"),
  unbuilt("mastodon", "Mastodon", "user"),
  unbuilt("lemmy", "Lemmy", "user"),
  unbuilt("farcaster", "Farcaster", "user"),
  unbuilt("nostr", "Nostr", "key"),
  unbuilt("vk", "VK", "user"),
  unbuilt("tumblr", "Tumblr", "blog"),
  unbuilt("mewe", "MeWe", "user"),
  unbuilt("moltbook", "Moltbook", "agent"),
  unbuilt("whop", "Whop", "company"),
  { ...unbuilt("reddit", "Reddit", "user"), availability: { cloud: "not_available", self_host: "not_available" } },
];
