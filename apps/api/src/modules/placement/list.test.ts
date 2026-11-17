// SPDX-License-Identifier: AGPL-3.0-only
// The Placement circle's member list: trusted only when it chains from the pinned root, is unexpired,
// is not older than or a fork of the last trusted list, has enough signatures, and every entry names
// an inviter and a signer's criteria check. A single signer may publish an abuse removal alone.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { testIdentity } from "../identity/test-auth";
import { inWorkspace, listState } from "./adapters/repo";
import { contentHash, pinnedRootHash, rootChainHash, verifyList, type TrustedList } from "./application/list";
import { canonical } from "./domain/canonical";
import type { Member, UnsignedList } from "./domain/list";
import { PINNED_ROOT, thresholdFor, type Root } from "./domain/root";
import { trustList } from "./index";

type Signer = { pub: string; priv: KeyObject };
const signer = (): Signer => {
  const k = generateKeyPairSync("ed25519");
  return { pub: k.publicKey.export({ format: "jwk" }).x!, priv: k.privateKey };
};
const signed = <T extends object>(doc: T, by: Signer[]) => ({ ...doc, signatures: by.map((s) => ({ key: s.pub, sig: sign(null, Buffer.from(canonical(doc)), s.priv).toString("base64url") })) });
const rootOf = (...s: Signer[]): Root => ({ keys: s.map((x) => x.pub), threshold: thresholdFor(s.length) });
const change = (to: Signer[], by: Signer[], threshold = thresholdFor(to.length)) => signed({ keys: to.map((s) => s.pub), threshold }, by);

const [S1, S2, S3] = [signer(), signer(), signer()];
const NOW = new Date("2026-11-10T12:00:00Z");
const memberKey = () => signer().pub;
const entry = (address: string, invitedBy: string, over: Partial<Member> = {}): Member => ({
  address,
  provider: "google",
  key: memberKey(),
  invited_by: invitedBy,
  criteria_checked_by: S1.pub,
  criteria: { named_person: true, business_website: true, domain_six_months: true },
  listed_at: "2026-11-10",
  may_invite: true,
  founder_controlled: true,
  ...over,
});
const FOUNDER = entry("founder@contosohq.example", S1.pub);
const NEW = entry("dominik@trydirex.com", FOUNDER.address);
const base = (over: Partial<UnsignedList> = {}): UnsignedList => ({ version: 1, expires: "2026-12-10T00:00:00Z", bootstrap: true, members: [FOUNDER, NEW], removed: [], ...over });
const trusted = (list: UnsignedList, chain: Root[] = [], pinned: Root = BOOT): TrustedList => ({ version: list.version, contentHash: contentHash(list), list, rootChainLength: chain.length, rootChainHash: rootChainHash(chain), pinnedRootHash: pinnedRootHash(pinned) });
const BOOT = rootOf(S1);
const THREE = rootOf(S1, S2, S3);
/** Bootstrap to three signers: signed by the old root's threshold and the new one's. */
const TO_THREE = [change([S1, S2, S3], [S1, S2])];

const refusal = (v: ReturnType<typeof verifyList>) => (v.ok ? "ok" : v.reason);

// Allow.

test("a bootstrap list, 1 of 1, is trusted", () => {
  const v = verifyList(signed(base(), [S1]), BOOT, [], null, NOW);
  expect(v.ok && v.trusted).toMatchObject({ version: 1, contentHash: contentHash(base()) });
});

test("a 2-of-3 list chained from the bootstrap root is trusted, and so is the same list again", () => {
  const list = base({ version: 2, bootstrap: false });
  expect(refusal(verifyList(signed(list, [S2, S3]), BOOT, TO_THREE, trusted(base()), NOW))).toBe("ok");
  expect(refusal(verifyList(signed(list, [S1, S3]), THREE, [], trusted(list, [], THREE), NOW))).toBe("ok");
  expect(refusal(verifyList(signed(list, [S1, S3]), BOOT, TO_THREE, trusted(list, TO_THREE), NOW))).toBe("ok");
});

test("one signer alone may publish an abuse removal that stops the inviter inviting; the removed member leaves the list", () => {
  const before = base({ version: 2, bootstrap: false });
  const after = base({ version: 3, bootstrap: false, members: [{ ...FOUNDER, may_invite: false }], removed: [{ address: NEW.address, invited_by: FOUNDER.address, reason: "abuse", removed_in: 3 }] });
  const v = verifyList(signed(after, [S3]), THREE, [], trusted(before, [], THREE), NOW);
  expect(refusal(v)).toBe("ok");
  expect(v.ok && v.trusted.list.members.map((m) => m.address)).toEqual([FOUNDER.address]);
});

// Block.

test("the release pins the founder's one signer key, so a list signed by any other key is refused", () => {
  expect(PINNED_ROOT).toEqual({ keys: ["gaael05_K3QdS4UfZ-QFYK9csntS2D6iQmJVza6e7Pg"], threshold: 1 });
  expect(verifyList(signed(base(), [S1]), PINNED_ROOT, [], null, NOW).ok).toBe(false);
});

test("a list not chained from the pinned root is refused", () => {
  expect(refusal(verifyList(signed(base(), [S2]), BOOT, [], null, NOW))).toBe("not_enough_signatures");
  expect(refusal(verifyList(signed(base({ version: 2, bootstrap: false }), [S2, S3]), BOOT, [], null, NOW))).toBe("bootstrap_mismatch");
  const tampered = { ...signed(base(), [S1]), expires: "2027-12-10T00:00:00Z" };
  expect(refusal(verifyList(tampered, BOOT, [], null, NOW))).toBe("not_enough_signatures");
});

test("a root change signed by the new keys only is refused", () => {
  const list = signed(base({ version: 2, bootstrap: false }), [S2, S3]);
  expect(refusal(verifyList(list, BOOT, [change([S1, S2, S3], [S2, S3])], null, NOW))).toBe("root_change_unsigned");
  expect(refusal(verifyList(list, BOOT, [change([S1, S2, S3], [S1])], null, NOW))).toBe("root_change_unsigned");
});

test("an older, shorter root chain than the trusted one is refused", () => {
  const S4 = signer();
  const longer = [...TO_THREE, change([S2, S3, S4], [S2, S3, S4])];
  const last = trusted(base({ version: 3, bootstrap: false }), longer);
  // Signed by S1 and S2, which the root of three still trusts but the newer chain dropped S1 from.
  expect(refusal(verifyList(signed(base({ version: 4, bootstrap: false }), [S1, S2]), BOOT, TO_THREE, last, NOW))).toBe("root_chain_older");
  expect(refusal(verifyList(signed(base({ version: 4, bootstrap: false }), [S1, S2]), BOOT, [], trusted(base({ version: 3 }), TO_THREE), NOW))).toBe("root_chain_older");
  expect(refusal(verifyList(signed(base({ version: 4, bootstrap: false }), [S3, S4]), BOOT, longer, last, NOW))).toBe("ok");
});

test("a root chain of the same length with a different root change is refused", () => {
  const S4 = signer();
  const other = [change([S1, S2, S4], [S1, S2, S4])];
  const list = signed(base({ version: 3, bootstrap: false }), [S1, S4]);
  expect(refusal(verifyList(list, BOOT, other, null, NOW))).toBe("ok");
  expect(refusal(verifyList(list, BOOT, other, trusted(base({ version: 2, bootstrap: false }), TO_THREE), NOW))).toBe("root_chain_forked");
  // A longer chain that doesn't start with the trusted one is refused too.
  expect(refusal(verifyList(list, BOOT, [...other, change([S1, S2, S4], [S1, S2, S4])], trusted(base({ version: 2, bootstrap: false }), TO_THREE), NOW))).toBe("root_chain_forked");
});

test("an expired list is refused", () => {
  expect(refusal(verifyList(signed(base(), [S1]), BOOT, [], null, new Date("2026-12-10T00:00:00Z")))).toBe("expired");
});

test("a list older than the last trusted one is refused", () => {
  expect(refusal(verifyList(signed(base(), [S1]), BOOT, [], trusted(base({ version: 2 })), NOW))).toBe("older");
});

test("a different list at the trusted version is refused", () => {
  const fork = base({ members: [FOUNDER, NEW, entry("other@trydirex.com", FOUNDER.address)] });
  expect(refusal(verifyList(signed(fork, [S1]), BOOT, [], trusted(base()), NOW))).toBe("forked");
});

test("a list can't declare its own threshold or signers", () => {
  expect(refusal(verifyList(signed({ ...base(), threshold: 1 }, [S1]), BOOT, [], null, NOW))).toBe("malformed");
  expect(refusal(verifyList(signed({ ...base(), signers: [S2.pub] }, [S2]), BOOT, [], null, NOW))).toBe("malformed");
});

test("threshold 1 with three signers is refused, pinned or chained", () => {
  const list = signed(base({ version: 2, bootstrap: false }), [S2]);
  expect(refusal(verifyList(list, { keys: THREE.keys, threshold: 1 }, [], null, NOW))).toBe("bad_threshold");
  expect(refusal(verifyList(list, BOOT, [change([S1, S2, S3], [S1, S2, S3], 1)], null, NOW))).toBe("bad_threshold");
  expect(refusal(verifyList(signed(base({ version: 2, bootstrap: false }), [S2]), THREE, [], null, NOW))).toBe("not_enough_signatures");
  expect(refusal(verifyList(signed(base({ bootstrap: false }), [S1]), BOOT, [], null, NOW))).toBe("bootstrap_mismatch");
});

test("an entry with no inviter, or an inviter who isn't a member, is refused", () => {
  expect(refusal(verifyList(signed(base({ members: [FOUNDER, { ...NEW, invited_by: "" }] }), [S1]), BOOT, [], null, NOW))).toBe("no_inviter");
  expect(refusal(verifyList(signed(base({ members: [FOUNDER, { ...NEW, invited_by: "stranger@elsewhere.test" }] }), [S1]), BOOT, [], null, NOW))).toBe("inviter_not_member");
  expect(refusal(verifyList(signed(base({ members: [FOUNDER, { ...NEW, invited_by: NEW.address }] }), [S1]), BOOT, [], null, NOW))).toBe("inviter_not_member");
  const { invited_by: _, ...missing } = NEW;
  expect(refusal(verifyList(signed({ ...base(), members: [FOUNDER, missing] }, [S1]), BOOT, [], null, NOW))).toBe("malformed");
});

test("an entry with no signer's criteria check, or criteria not met, is refused", () => {
  expect(refusal(verifyList(signed(base({ members: [FOUNDER, { ...NEW, criteria_checked_by: "" }] }), [S1]), BOOT, [], null, NOW))).toBe("no_criteria_check");
  expect(refusal(verifyList(signed(base({ members: [FOUNDER, { ...NEW, criteria_checked_by: S2.pub }] }), [S1]), BOOT, [], null, NOW))).toBe("no_criteria_check");
  expect(refusal(verifyList(signed(base({ members: [FOUNDER, { ...NEW, criteria: { ...NEW.criteria, domain_six_months: false } }] }), [S1]), BOOT, [], null, NOW))).toBe("criteria_not_met");
  const { criteria: _, ...missing } = NEW;
  expect(refusal(verifyList(signed({ ...base(), members: [FOUNDER, missing] }, [S1]), BOOT, [], null, NOW))).toBe("malformed");
});

test("an abuse removal that leaves the inviter able to invite is refused, even fully signed", () => {
  const after = base({ version: 3, bootstrap: false, members: [FOUNDER], removed: [{ address: NEW.address, invited_by: FOUNDER.address, reason: "abuse", removed_in: 3 }] });
  expect(refusal(verifyList(signed(after, [S1, S2, S3]), THREE, [], trusted(base({ version: 2, bootstrap: false }), [], THREE), NOW))).toBe("inviter_may_still_invite");
  expect(refusal(verifyList(signed(base({ ...after, members: [FOUNDER, NEW] }), [S1, S2]), THREE, [], null, NOW))).toBe("removed_still_listed");
});

test("any change other than an abuse removal needs the threshold at three signers", () => {
  const before = base({ version: 2, bootstrap: false });
  const removed = { address: NEW.address, invited_by: FOUNDER.address, reason: "abuse" as const, removed_in: 3 };
  const cases: UnsignedList[] = [
    base({ version: 3, bootstrap: false, members: [FOUNDER, NEW, entry("other@trydirex.com", FOUNDER.address)] }),
    base({ version: 3, bootstrap: false, members: [{ ...FOUNDER, may_invite: false }], removed: [{ ...removed, reason: "left" }] }),
    base({ version: 3, bootstrap: false, members: [{ ...FOUNDER, may_invite: false }], removed: [removed], expires: "2027-06-01T00:00:00Z" }),
    base({ version: 4, bootstrap: false, members: [{ ...FOUNDER, may_invite: false }], removed: [{ ...removed, removed_in: 4 }] }),
  ];
  for (const after of cases) expect(refusal(verifyList(signed(after, [S3]), THREE, [], trusted(before, [], THREE), NOW))).toBe("not_enough_signatures");
  // With no trusted list to compare against, a one-signature removal can't be told from any other change.
  const ok = base({ version: 3, bootstrap: false, members: [{ ...FOUNDER, may_invite: false }], removed: [removed] });
  expect(refusal(verifyList(signed(ok, [S3]), THREE, [], null, NOW))).toBe("not_enough_signatures");
});

test("a new member invited by a member who lost the right to invite is refused; a signer key may still invite", () => {
  const before = base({ members: [{ ...FOUNDER, may_invite: false }, NEW] });
  const by = (inviter: string) => base({ version: 2, members: [...before.members, entry("x@example.com", inviter)] });
  expect(refusal(verifyList(signed(by(FOUNDER.address), [S1]), BOOT, [], trusted(before), NOW))).toBe("inviter_may_not_invite");
  expect(refusal(verifyList(signed(by(NEW.address), [S1]), BOOT, [], trusted(before), NOW))).toBe("ok");
  expect(refusal(verifyList(signed(by(S1.pub), [S1]), BOOT, [], trusted(before), NOW))).toBe("ok");
});

// Reading from the checkout and recording the trusted list.

test("an install reads the list from its checkout, records it, and then refuses an older one", async () => {
  const { signIn, createOrg } = testIdentity();
  const ws = (await createOrg(await signIn())).workspace.id;
  const dir = await mkdtemp(join(tmpdir(), "placement-list-"));
  const write = (list: object, roots?: object) => Promise.all([writeFile(join(dir, "members.json"), JSON.stringify(list)), roots && writeFile(join(dir, "roots.json"), JSON.stringify(roots))]);

  expect(await trustList(ws, { dir: undefined, root: BOOT, now: NOW })).toEqual({ ok: false, reason: "not_configured" });
  expect(await trustList(ws, { dir, root: BOOT, now: NOW })).toEqual({ ok: false, reason: "unreadable" });

  await write(signed(base({ version: 2 }), [S1]));
  expect(refusal((await trustList(ws, { dir, root: BOOT, now: NOW })) as ReturnType<typeof verifyList>)).toBe("ok");
  expect(await inWorkspace(ws, listState)).toMatchObject({ version: 2, contentHash: contentHash(base({ version: 2 })) });

  await write(signed(base(), [S1]));
  expect(await trustList(ws, { dir, root: BOOT, now: NOW })).toEqual({ ok: false, reason: "older" });
  expect(await inWorkspace(ws, listState)).toMatchObject({ version: 2 });

  await write(signed(base({ version: 3, bootstrap: false }), [S2, S3]), TO_THREE);
  expect(refusal((await trustList(ws, { dir, root: BOOT, now: NOW })) as ReturnType<typeof verifyList>)).toBe("ok");
  expect(await inWorkspace(ws, listState)).toMatchObject({ version: 3, rootChainLength: 1, rootChainHash: rootChainHash(TO_THREE) });

  await write(signed(base({ version: 4 }), [S1]), []);
  expect(await trustList(ws, { dir, root: BOOT, now: NOW })).toEqual({ ok: false, reason: "root_chain_older" });

  const other = (await createOrg(await signIn())).workspace.id;
  expect(await inWorkspace(other, listState)).toBeUndefined();
});

test("after a stolen signer key, a release that re-pins the root trusts the founder's lower version", async () => {
  const { signIn, createOrg } = testIdentity();
  const ws = (await createOrg(await signIn())).workspace.id;
  const dir = await mkdtemp(join(tmpdir(), "placement-list-"));
  const write = (list: object) => writeFile(join(dir, "members.json"), JSON.stringify(list));
  const S5 = signer();
  const REPINNED = rootOf(S5);
  const empty = (version: number) => base({ version, members: [] });

  await write(signed(empty(99), [S1]));
  expect(refusal((await trustList(ws, { dir, root: BOOT, now: NOW })) as ReturnType<typeof verifyList>)).toBe("ok");
  await write(signed(empty(5), [S5]));
  expect(await trustList(ws, { dir, root: BOOT, now: NOW })).toEqual({ ok: false, reason: "older" });

  expect(refusal((await trustList(ws, { dir, root: REPINNED, now: NOW })) as ReturnType<typeof verifyList>)).toBe("ok");
  expect(await inWorkspace(ws, listState)).toMatchObject({ version: 5, pinnedRootHash: pinnedRootHash(REPINNED) });
  await write(signed(empty(99), [S1]));
  expect(await trustList(ws, { dir, root: REPINNED, now: NOW })).toEqual({ ok: false, reason: "not_enough_signatures" });
});
