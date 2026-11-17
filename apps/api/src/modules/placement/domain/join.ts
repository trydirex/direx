// SPDX-License-Identifier: AGPL-3.0-only
// The join reply a new Circle member sends the signer: both join code parts, the joining address,
// its member key, and that key's signature over all four. The install builds it and the signer reads
// it back, both from here. Reading is strict: text that isn't exactly what joinText writes is not a
// join reply.

/** What a join reply proves: who joins, with which member key, and the two code parts it carried. */
export type Join = { part1: string; part2: string; address: string; key: string };
export type SignedJoin = Join & { sig: string };

export const JOIN_SUBJECT = "Joining the Placement circle";

// A code part is 16 random bytes, a key 32 and a signature 64, each base64url without padding.
export const JOIN_CODE = /^[A-Za-z0-9_-]{22}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** The exact text the member key signs. */
export const joinSigned = (j: Join) => ["direx-placement-join-1", j.part1, j.part2, j.address, j.key].join("\n");

const valid = (j: SignedJoin) => JOIN_CODE.test(j.part1) && JOIN_CODE.test(j.part2) && ADDRESS.test(j.address) && j.address === j.address.toLowerCase() && KEY.test(j.key) && SIG.test(j.sig);

/** The reply's whole text body. */
export function joinText(j: SignedJoin): string {
  if (!valid(j)) throw new Error("not a join reply");
  return [
    "This Mailbox asks to join the Placement circle. Direx wrote this reply for the signer's tool, which reads the lines below.",
    "",
    `Address: ${j.address}`,
    `Part 1: ${j.part1}`,
    `Part 2: ${j.part2}`,
    `Member key: ${j.key}`,
    `Signature: ${j.sig}`,
  ].join("\n");
}

/** The join reply in a text body, or null when the body is anything but one joinText wrote. */
export function parseJoin(text: string): SignedJoin | null {
  const body = text.replace(/\r\n/g, "\n").trim();
  const field = (name: string) => new RegExp(`^${name}: (\\S+)$`, "m").exec(body)?.[1] ?? "";
  const j = { address: field("Address"), part1: field("Part 1"), part2: field("Part 2"), key: field("Member key"), sig: field("Signature") };
  return valid(j) && joinText(j) === body ? j : null;
}
