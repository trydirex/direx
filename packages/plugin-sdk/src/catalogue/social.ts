// SPDX-License-Identifier: MIT
// What a social network answers: whose account a sign-in is, and whether it still works. Then the
// post a person approves, the same on every network; each network's own rules stay in its plugin.
import { z } from "zod";
import { mediaRef } from "../media";
import { noInput } from "./entry";

const text = z.string().min(1);

export const socialIdentity = {
  name: "social.identity",
  version: 1,
  input: noInput,
  output: z.strictObject({
    accountId: text,
    accountLabel: text,
    accountType: text.optional(),
    scopes: z.array(text).optional(),
    grantExpiresAt: z.iso.datetime().optional(),
    /** What this login can post to, when that isn't just the account itself. */
    targets: z.array(z.strictObject({ id: text, name: text, type: text })).optional(),
  }),
} as const;

export const socialHealth = {
  name: "social.health",
  version: 1,
  input: noInput,
  /** "auth" when the network refused the sign-in, so a reconnect fixes it. */
  output: z.strictObject({ ok: z.boolean(), reason: z.enum(["auth", "other"]).optional() }),
} as const;

// A Social account's own published posts, newest first (ADR 0039 rule 001). A list passes `cursor` (the
// plugin's own opaque string; none gives the newest); a lookup passes `ids` and gets back those that still
// exist, so a missing id means deleted. `next` pages back in time; `newest` is the cursor a later read passes
// for newer posts only. `text` is the account's own words, never a quoted post's.
const target = z.string().optional();
const url = z.url({ protocol: /^https?$/ });
const outsidePost = z.strictObject({
  id: text,
  accountId: text,
  kind: z.enum(["original", "reply", "repost", "quote"]),
  createdAt: z.iso.datetime(),
  editedAt: z.iso.datetime().optional(),
  text: z.string(),
  links: z.array(url),
  permalink: url.optional(),
});
export const socialPosts = {
  name: "social.posts",
  version: 1,
  input: z.union([z.strictObject({ target, cursor: z.string().optional(), limit: z.number().int().min(1).max(100) }), z.strictObject({ target, ids: z.array(text).min(1).max(100) })]),
  output: z.strictObject({ posts: z.array(outsidePost), next: z.string().optional(), newest: z.string().optional() }),
} as const;

// A post with no video or images has no `media` at all, so a text post approved before either existed keeps
// its hash; nor does a video post have `alt`. `media` is one video, or up to four images in the order shown,
// with `alt` the words a screen reader says for each.
const post = {
  text: z.string(),
  followUps: z.array(z.string()),
  target: z.string().nullable(),
  media: z.array(mediaRef).min(1).max(4).optional(),
  alt: z.array(z.string().max(1000)).max(4).optional(),
};

/** `links`: whether the network keeps links here; without, prepare takes them out. */
export const socialPublish = { name: "social.publish", version: 1, input: z.strictObject({ ...post, links: z.boolean() }), spec: z.looseObject(post) } as const;
