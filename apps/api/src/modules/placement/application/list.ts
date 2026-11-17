// SPDX-License-Identifier: AGPL-3.0-only
// Reading and trusting the Placement circle's member list. The founder pulls the private list
// repository; the install reads the checkout named by DIREX_PLACEMENT_LIST and trusts a list only
// when it chains from the root pinned in this release, is unexpired, is not older than or a fork of
// the list this Workspace last trusted, and carries enough signatures.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { inWorkspace, listState, saveListState } from "../adapters/repo";
import { canonical, unsigned } from "../domain/canonical";
import { entryProblem, onlyAbuseRemoval, type EntryProblem, type MemberList, type UnsignedList } from "../domain/list";
import { isBootstrap, PINNED_ROOT, thresholdFor, type Root } from "../domain/root";

const Key = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Address = z.string().regex(/^[^\sA-Z@]+@[^\sA-Z@]+\.[^\sA-Z@]+$/);
const Signatures = z.array(z.strictObject({ key: Key, sig: z.string().min(1) }));
// Strict throughout: a field this release doesn't know, such as a list naming its own signers or
// threshold, makes the whole list malformed.
const MemberListSchema = z.strictObject({
  version: z.number().int().min(1),
  expires: z.iso.datetime({ offset: true }),
  bootstrap: z.boolean(),
  members: z.array(
    z.strictObject({
      address: Address,
      provider: z.literal("google"),
      key: Key,
      invited_by: z.string(),
      criteria_checked_by: z.string(),
      criteria: z.strictObject({ named_person: z.boolean(), business_website: z.boolean(), domain_six_months: z.boolean() }),
      listed_at: z.iso.date(),
      may_invite: z.boolean(),
      founder_controlled: z.boolean(),
    }),
  ),
  removed: z.array(z.strictObject({ address: Address, invited_by: z.string(), reason: z.enum(["abuse", "left"]), removed_in: z.number().int().min(1) })),
  signatures: Signatures,
});
const RootChain = z.array(z.strictObject({ keys: z.array(Key).min(1), threshold: z.number().int().min(1), signatures: Signatures }));

/** A trusted list, the length and hash of the root chain it was trusted under, and the hash of the root the release pinned. */
export type TrustedList = { version: number; contentHash: string; list: UnsignedList; rootChainLength: number; rootChainHash: string; pinnedRootHash: string };
export type Refusal = "no_root_pinned" | "inviter_may_not_invite" | "malformed" | "bad_threshold" | "root_change_unsigned" | "root_chain_older" | "root_chain_forked" | "bootstrap_mismatch" | "expired" | "older" | "forked" | "not_enough_signatures" | EntryProblem;
export type Verdict = { ok: true; trusted: TrustedList } | { ok: false; reason: Refusal };

/** Whether `sig` is a valid Ed25519 signature by `key` (both base64url) over `data`. */
export function verifySignature(key: string, data: string | Uint8Array, sig: string): boolean {
  try {
    return verify(null, Buffer.from(data), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key }, format: "jwk" }), Buffer.from(sig, "base64url"));
  } catch {
    return false;
  }
}

/** How many distinct keys of `keys` validly signed the document. */
function signedBy(doc: { signatures: { key: string; sig: string }[] }, keys: readonly string[]): number {
  const body = canonical(unsigned(doc));
  return new Set(doc.signatures.filter((s) => keys.includes(s.key) && verifySignature(s.key, body, s.sig)).map((s) => s.key)).size;
}

const wellFormedRoot = (r: Root) => new Set(r.keys).size === r.keys.length && r.threshold === thresholdFor(r.keys.length);

/** The content hash of a list, over everything but its signatures; it names the list in the daily seed. */
export const contentHash = (list: UnsignedList) => createHash("sha256").update(canonical(list)).digest("hex");

/** The hash of a pinned root's keys and threshold. */
export const pinnedRootHash = (root: Root) => createHash("sha256").update(canonical({ keys: root.keys, threshold: root.threshold })).digest("hex");

/** The hash of a root chain's changes, over each change's keys and threshold. */
export const rootChainHash = (chain: Root[]) => createHash("sha256").update(canonical(chain.map((c) => ({ keys: c.keys, threshold: c.threshold })))).digest("hex");

/**
 * Whether to trust `candidate`. `rootChain` is every root change since the pinned root, oldest
 * first; each must be signed by the threshold of the root before it and of itself. `lastTrusted`
 * is the list this Workspace last trusted, or null on first read. A release that pins a different root
 * than the one `lastTrusted` was trusted under starts trust over: after a lost or stolen signer key,
 * neither the old version floor nor the old chain binds.
 */
export function verifyList(candidate: unknown, pinnedRoot: Root, rootChain: unknown, last: TrustedList | null, now: Date): Verdict {
  const refuse = (reason: Refusal): Verdict => ({ ok: false, reason });
  if (pinnedRoot.keys.length === 0) return refuse("no_root_pinned");
  if (!wellFormedRoot(pinnedRoot)) return refuse("bad_threshold");
  const pinned = pinnedRootHash(pinnedRoot);
  const lastTrusted = last?.pinnedRootHash === pinned ? last : null;
  const chain = RootChain.safeParse(rootChain);
  if (!chain.success) return refuse("malformed");
  // The chain only grows: going back to an older root, or a different one, would undo a key change.
  if (lastTrusted && chain.data.length < lastTrusted.rootChainLength) return refuse("root_chain_older");
  if (lastTrusted && rootChainHash(chain.data.slice(0, lastTrusted.rootChainLength)) !== lastTrusted.rootChainHash) return refuse("root_chain_forked");
  let root = pinnedRoot;
  const signers = new Set(root.keys);
  for (const change of chain.data) {
    if (!wellFormedRoot(change)) return refuse("bad_threshold");
    if (signedBy(change, root.keys) < root.threshold || signedBy(change, change.keys) < change.threshold) return refuse("root_change_unsigned");
    root = { keys: change.keys, threshold: change.threshold };
    for (const k of root.keys) signers.add(k);
  }

  const parsed = MemberListSchema.safeParse(candidate);
  if (!parsed.success) return refuse("malformed");
  const list: MemberList = parsed.data;
  const body = unsigned(list);
  if (list.bootstrap !== isBootstrap(root.keys.length)) return refuse("bootstrap_mismatch");
  if (now.getTime() >= Date.parse(list.expires)) return refuse("expired");
  const hash = contentHash(body);
  if (lastTrusted && list.version < lastTrusted.version) return refuse("older");
  if (lastTrusted && list.version === lastTrusted.version && hash !== lastTrusted.contentHash) return refuse("forked");
  const problem = entryProblem(body, signers);
  if (problem) return refuse(problem);
  // A member who lost the right to invite can't bring in anyone new; a signer key always can.
  if (lastTrusted) {
    const known = new Set(lastTrusted.list.members.map((m) => m.address));
    const barred = new Set(lastTrusted.list.members.filter((m) => !m.may_invite).map((m) => m.address));
    if (list.members.some((m) => !known.has(m.address) && barred.has(m.invited_by))) return refuse("inviter_may_not_invite");
  }

  const signed = signedBy(list, root.keys);
  const abuseOnly = signed >= 1 && lastTrusted !== null && onlyAbuseRemoval(lastTrusted.list, body);
  if (signed < root.threshold && !abuseOnly) return refuse("not_enough_signatures");
  return { ok: true, trusted: { version: list.version, contentHash: hash, list: body, rootChainLength: chain.data.length, rootChainHash: rootChainHash(chain.data), pinnedRootHash: pinned } };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/**
 * The member list this Workspace trusts now: the checkout's `members.json` (and `roots.json`, the
 * root changes, when there are any) verified against the last trusted list, which it then replaces.
 * A refused list leaves the last trusted one recorded but is not used.
 */
export async function trustList(workspaceId: string, opts: { dir?: string | undefined; root?: Root; now?: Date } = {}): Promise<Verdict | { ok: false; reason: "not_configured" | "unreadable" }> {
  const dir = "dir" in opts ? opts.dir : process.env.DIREX_PLACEMENT_LIST;
  if (!dir) return { ok: false, reason: "not_configured" };
  let candidate: unknown;
  let chain: unknown;
  try {
    candidate = await readJson(join(dir, "members.json"));
    chain = await readJson(join(dir, "roots.json")).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const now = opts.now ?? new Date();
  return inWorkspace(workspaceId, async (tx) => {
    const last = await listState(tx);
    const lastTrusted = last ? { version: last.version, contentHash: last.contentHash, list: last.list as UnsignedList, rootChainLength: last.rootChainLength, rootChainHash: last.rootChainHash, pinnedRootHash: last.pinnedRootHash } : null;
    const verdict = verifyList(candidate, opts.root ?? PINNED_ROOT, chain, lastTrusted, now);
    if (verdict.ok && (verdict.trusted.contentHash !== last?.contentHash || verdict.trusted.rootChainHash !== last.rootChainHash || verdict.trusted.pinnedRootHash !== last.pinnedRootHash)) {
      await saveListState(tx, { workspaceId, ...verdict.trusted, trustedAt: now });
    }
    return verdict;
  });
}
