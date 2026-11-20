// SPDX-License-Identifier: AGPL-3.0-only
// What a Workspace export leaves out (ADR 0030 rule 008, spec Q10): credential ciphertext, key
// material, and the hashes and sealed state that prove a bearer token or link. Every other column of
// every tenant table goes into the ZIP. export.test.ts fails on a ciphertext-like column not listed
// here or in KEPT.
export const OMITTED: Readonly<Record<string, readonly string[]>> = {
  // Sealed secret values (credentials module, ADR 0003) and the per-Workspace data key that opens them.
  "public.credentials": ["ciphertext", "nonce"],
  "public.workspace_keys": ["wrapped_dek"],
  // Private signing keys: approval signatures, and a Placement list member's mailbox key.
  "public.approval_keys": ["ciphertext", "nonce"],
  "public.placement_member_keys": ["ciphertext", "nonce"],
  // The key that hashes addresses for relationship holds and correspondents.
  "public.outreach_settings": ["email_hash_key"],
  // What proves a bearer token, an invite link, an unsubscribe link, a calendar feed, a connect link or a
  // per-Person tracked link (ADR 0035).
  "public.external_tokens": ["token_hash"],
  "public.workspace_invites": ["token_hash"],
  "public.unsubscribe_tokens": ["token_hash"],
  "public.review_feeds": ["token_hash"],
  "public.connect_links": ["token_hash", "state_hash", "sealed_state"],
  "public.tracked_link_uses": ["token_hash"],
};

/** Columns that look like secrets and are not: they go into the export. */
export const KEPT: Readonly<Record<string, readonly string[]>> = {
  // A post's link preview image.
  "public.social_posts": ["link_image"],
  // A Placement list member's public key.
  "public.placement_member_keys": ["public_key"],
  // Addresses hashed under the omitted key: the hash alone tells nothing.
  "public.correspondents": ["email_hash"],
  "public.relationship_holds": ["email_hash"],
};
