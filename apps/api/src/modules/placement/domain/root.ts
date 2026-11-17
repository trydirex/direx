// SPDX-License-Identifier: AGPL-3.0-only
// The root of trust for the Placement circle's member list: the signer keys and threshold this
// release ships. A list is trusted only when it chains from here; a list can't name its own signers.

/** Signer public keys (base64url of the raw 32 Ed25519 bytes) and how many must sign. */
export type Root = { keys: string[]; threshold: number };

/** Signatures a root of `signers` keys needs: 1 below three signers (the list is then bootstrap), else a strict majority. */
export const thresholdFor = (signers: number) => (signers < 3 ? 1 : Math.floor(signers / 2) + 1);

/** Whether a root of this many signers runs as bootstrap. */
export const isBootstrap = (signers: number) => signers < 3;

/**
 * Pinned in this release: the founder's signer key, so only lists it signs are trusted. Adding or
 * replacing a key here is how a lost or stolen signer key is
 * recovered: the next release re-pins.
 */
export const PINNED_ROOT: Root = { keys: ["gaael05_K3QdS4UfZ-QFYK9csntS2D6iQmJVza6e7Pg"], threshold: 1 };
