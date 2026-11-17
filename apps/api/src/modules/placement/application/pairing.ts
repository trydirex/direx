// SPDX-License-Identifier: AGPL-3.0-only
// Who checks whom each day, and what each check looks like to the receiver: its subject and the
// window it is sent in. Every install computes the same answers from the day, the trusted list and
// the two addresses, and asks no server. Kept in application/ because it hashes with node:crypto.
import { createHash } from "node:crypto";
import type { Member } from "../domain/list";
import { plainSubject } from "./render";

/** The day's seed: the UTC date and a hash of it with the trusted list's content hash. */
export type Seed = { day: string; value: string };
/** What pairing needs of a Circle member. Removed members are not in a list's `members`, so they never pair. */
export type PairMember = Pick<Member, "address" | "listed_at">;
export type ProbeKind = "plain" | "content";
export type ProbeIdentity = { kind: ProbeKind; sender: string; receiver: string; subject: string; expectedAt: Date; window: { after: Date; before: Date } };

/** Receivers per sender per day [DEFAULT]. Below 10 members a sender has at most 8 others, so this pairs it with all of them. */
export const RECEIVERS_PER_DAY = 8;
/** Checks are sent at a minute between 09:00 and 17:00 UTC [DEFAULT]. */
const SEND_FROM_MINUTE = 9 * 60;
const SEND_MINUTES = 8 * 60;
/**
 * The receiver looks for a check from 10 minutes before its expected time, for clocks that differ,
 * to 60 minutes after, which covers a send up to 30 minutes late (later ones are cancelled) and its
 * delivery [DEFAULT].
 */
export const WINDOW_BEFORE_MINUTES = 10;
export const WINDOW_AFTER_MINUTES = 60;

const SEQ: Record<ProbeKind, number> = { plain: 0, content: 1 };
const DAY_MS = 86_400_000;
const norm = (a: string) => a.trim().toLowerCase();
const hash = (...parts: (string | number)[]) => createHash("sha256").update(parts.join("\n")).digest();

export function seed(at: Date, listHash: string): Seed {
  const day = at.toISOString().slice(0, 10);
  return { day, value: hash("placement seed", day, listHash).toString("hex") };
}

/** Members listed by that day; a member listed later joins pairing from its listed day. */
const listedBy = (s: Seed, members: readonly PairMember[]) => members.filter((m) => m.listed_at <= s.day);

/** The sender's receivers that day, by rendezvous hashing over the other listed members; none if the sender is not listed. */
export function receiversFor(s: Seed, sender: string, members: readonly PairMember[], k = RECEIVERS_PER_DAY): string[] {
  const from = norm(sender);
  const listed = listedBy(s, members);
  if (!listed.some((m) => norm(m.address) === from)) return [];
  return listed
    .filter((m) => norm(m.address) !== from)
    .map((m) => ({ address: m.address, rank: hash("placement pair", s.value, from, norm(m.address)).toString("hex") }))
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
    .slice(0, k)
    .map((r) => r.address);
}

/** The members that send to this receiver that day: the same pairing, seen from the other side. */
export const sendersTo = (s: Seed, receiver: string, members: readonly PairMember[], k = RECEIVERS_PER_DAY): string[] =>
  members.filter((m) => receiversFor(s, m.address, members, k).some((r) => norm(r) === norm(receiver))).map((m) => m.address);

/** Whole days since the later of the two members was listed: the pair's plain check count, which no day's seed changes. */
export function pairDay(s: Seed, a: PairMember, b: PairMember): number {
  const since = a.listed_at > b.listed_at ? a.listed_at : b.listed_at;
  const days = (Date.parse(`${s.day}T00:00:00Z`) - Date.parse(`${since}T00:00:00Z`)) / DAY_MS;
  if (!Number.isSafeInteger(days) || days < 0) throw new Error("the pair is not listed on this day");
  return days;
}

/** When the sender sends check `seq` to the receiver that day: a minute between 09:00 and 17:00 UTC. */
export function expectedAt(s: Seed, sender: string, receiver: string, seq: number): Date {
  const minute = hash("placement time", s.value, norm(sender), norm(receiver), seq).readUInt32BE(0) % SEND_MINUTES;
  return new Date(Date.parse(`${s.day}T00:00:00Z`) + (SEND_FROM_MINUTE + minute) * 60_000);
}

/** The window the receiver searches for check `seq` in. */
export function matchWindow(s: Seed, sender: string, receiver: string, seq: number): { after: Date; before: Date } {
  const at = expectedAt(s, sender, receiver, seq).getTime();
  return { after: new Date(at - WINDOW_BEFORE_MINUTES * 60_000), before: new Date(at + WINDOW_AFTER_MINUTES * 60_000) };
}

/**
 * How the receiver finds a check: its sender, its window, and the text its subject holds. A plain
 * check's subject is the whole library subject. A content check carries the real step's subject,
 * which the receiver can't know, so the sender adds a short tag from the day's seed and the receiver
 * looks for that tag; see contentSubject.
 */
export function probeIdentity(s: Seed, sender: PairMember, receiver: PairMember, kind: ProbeKind): ProbeIdentity {
  const [from, to, seq] = [norm(sender.address), norm(receiver.address), SEQ[kind]];
  const subject = kind === "plain" ? plainSubject(from, to, pairDay(s, sender, receiver)) : `ref ${hash("placement tag", s.value, from, to).toString("hex").slice(0, 8)}`;
  return { kind, sender: from, receiver: to, subject, expectedAt: expectedAt(s, from, to, seq), window: matchWindow(s, from, to, seq) };
}

/** The subject a content check is sent with: the step's subject and the tag the receiver looks for. */
export function contentSubject(stepSubject: string, id: ProbeIdentity): string {
  if (id.kind !== "content") throw new Error("only a content check carries a tag");
  return `${stepSubject} (${id.subject})`;
}
