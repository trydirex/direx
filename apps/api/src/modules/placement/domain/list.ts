// SPDX-License-Identifier: AGPL-3.0-only
// The Placement circle's member list: who is in, who invited them, which signer checked the
// admission criteria, and who was removed and why. The checks here need no keys; signatures are
// checked where the list is read.
import { canonical } from "./canonical";

export type Signature = { key: string; sig: string };
/** The written admission criteria a signer checked for one Mailbox. */
export type Criteria = { named_person: boolean; business_website: boolean; domain_six_months: boolean };
export type Member = {
  address: string;
  provider: "google";
  /** The Mailbox's member key, base64url of the raw 32 Ed25519 bytes. */
  key: string;
  /** Another Circle member's address, or a signer's key. */
  invited_by: string;
  /** The key of the signer who checked the criteria. */
  criteria_checked_by: string;
  criteria: Criteria;
  listed_at: string;
  may_invite: boolean;
  /** A Mailbox the founder controls, which may send content probes before its fourth week. */
  founder_controlled: boolean;
};
export type Removal = { address: string; invited_by: string; reason: "abuse" | "left"; removed_in: number };
export type MemberList = { version: number; expires: string; bootstrap: boolean; members: Member[]; removed: Removal[]; signatures: Signature[] };
export type UnsignedList = Omit<MemberList, "signatures">;

export type EntryProblem = "duplicate_member" | "removed_still_listed" | "no_inviter" | "inviter_not_member" | "no_criteria_check" | "criteria_not_met" | "inviter_may_still_invite" | "removal_from_later_version";

/** Why the list's entries break the admission or removal rules, or null. `signers` are every signer key the root chain named. */
export function entryProblem(list: UnsignedList, signers: ReadonlySet<string>): EntryProblem | null {
  const addresses = new Set(list.members.map((m) => m.address));
  if (addresses.size !== list.members.length) return "duplicate_member";
  if (list.removed.some((r) => addresses.has(r.address))) return "removed_still_listed";
  const everListed = new Set([...addresses, ...list.removed.map((r) => r.address)]);
  for (const m of list.members) {
    if (!m.invited_by) return "no_inviter";
    if (m.invited_by === m.address || !(everListed.has(m.invited_by) || signers.has(m.invited_by))) return "inviter_not_member";
    if (!signers.has(m.criteria_checked_by)) return "no_criteria_check";
    if (!(m.criteria.named_person && m.criteria.business_website && m.criteria.domain_six_months)) return "criteria_not_met";
  }
  for (const r of list.removed) {
    if (r.removed_in > list.version) return "removal_from_later_version";
    if (r.reason !== "abuse" || r.removed_in !== list.version) continue;
    if (list.members.some((m) => m.address === r.invited_by && m.may_invite)) return "inviter_may_still_invite";
  }
  return null;
}

/**
 * Whether `next` is `prev` with only abuse removals made: the next version, the removed members
 * gone and recorded as abuse removals in this version, and their inviters no longer able to invite.
 * Such a version may be signed by one signer.
 */
export function onlyAbuseRemoval(prev: UnsignedList, next: UnsignedList): boolean {
  if (next.version !== prev.version + 1 || next.removed.length <= prev.removed.length) return false;
  if (canonical(next.removed.slice(0, prev.removed.length)) !== canonical(prev.removed)) return false;
  const added = next.removed.slice(prev.removed.length);
  const byAddress = new Map(prev.members.map((m) => [m.address, m]));
  const expectedRemovals = added.map((r) => ({ address: r.address, invited_by: byAddress.get(r.address)?.invited_by, reason: "abuse", removed_in: next.version }));
  if (canonical(added) !== canonical(expectedRemovals)) return false;
  const gone = new Set(added.map((r) => r.address));
  const inviters = new Set(added.map((r) => r.invited_by));
  const members = prev.members.filter((m) => !gone.has(m.address)).map((m) => (inviters.has(m.address) ? { ...m, may_invite: false } : m));
  return canonical({ ...prev, version: next.version, members, removed: next.removed }) === canonical(next);
}
