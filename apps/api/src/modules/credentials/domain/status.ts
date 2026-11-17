// SPDX-License-Identifier: AGPL-3.0-only
// Pure: whether a credential may be used right now, and if not, why. No I/O.

export type Scope = "workspace" | "user";
export type Status = "active" | "needs_reauth" | "revoked";
export type NotReady = "missing" | "deleted" | "revoked" | "needs_reauth" | "owner_left";

export type ReadinessRow = { scope: Scope; status: Status; deletedAt: Date | null };

/** A user-scoped credential never falls back to anyone else's once its owner leaves. */
export function readiness(c: ReadinessRow | null, ownerIsMember: boolean): NotReady | null {
  if (!c) return "missing";
  if (c.deletedAt) return "deleted";
  if (c.status === "revoked") return "revoked";
  if (c.status === "needs_reauth") return "needs_reauth";
  return c.scope === "user" && !ownerIsMember ? "owner_left" : null;
}
