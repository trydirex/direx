// SPDX-License-Identifier: AGPL-3.0-only
// The signer writes only lists an install accepts: invites need the founder's assertion until the
// stop rule has passed, join codes work once and for 24 hours, and an abuse removal always takes the
// inviter's right to invite with it.
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { dkimSign, type DNSResolver } from "mailauth";
import { contentHash, JOIN_SUBJECT, joinSigned, joinText, pinnedRootHash, rootChainHash, unsigned, verifyList, type MemberList, type Root } from "../../apps/api/src/modules/placement/index";
import { accept, init, invite, loadSigner, publish, readJoinReply, remove, sign, type Signer } from "../placement-signer";

const NOW = new Date("2026-11-10T12:00:00Z");
const YES = { named_person: true, business_website: true, domain_six_months: true };
const memberKey = () => generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
const read = async (dir: string) => JSON.parse(await readFile(join(dir, "members.json"), "utf8")) as MemberList;

async function setup(): Promise<{ dir: string; signer: Signer; root: Root }> {
  const dir = await mkdtemp(join(tmpdir(), "placement-list-"));
  const keyFile = join(await mkdtemp(join(tmpdir(), "placement-key-")), "signer.pem");
  const signer = await init(keyFile, undefined, NOW);
  const root = { keys: [signer.pub], threshold: 1 };
  await publish(dir, signer, root, { version: 1, expires: "2026-12-10T00:00:00Z", members: [], removed: [] }, NOW);
  return { dir, signer, root };
}

async function join2(s: Awaited<ReturnType<typeof setup>>, address: string, inviter = "signer", at = NOW) {
  const codes = await invite(s.dir, s.signer, s.root, { address, inviter, criteria: YES, founderControlled: true }, at);
  return accept(s.dir, s.signer, s.root, { address, key: memberKey(), part1: codes.part1, part2: codes.part2 }, at);
}

// Allow.

test("init, invite, accept and sign write lists an install with the same root accepts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "placement-list-"));
  const keyFile = join(await mkdtemp(join(tmpdir(), "placement-key-")), "signer.pem");
  const signer = await init(keyFile, dir, NOW, undefined);
  expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
  await expect(init(keyFile, undefined, NOW)).rejects.toThrow();
  expect((await loadSigner(keyFile, dir)).pub).toBe(signer.pub);
  const root = { keys: [signer.pub], threshold: 1 };
  expect(verifyList(await read(dir), root, [], null, NOW).ok).toBe(true);

  const s = { dir, signer, root };
  await join2(s, "founder@contosohq.example");
  await join2(s, "dominik@trydirex.com", "founder@contosohq.example");
  const signed = await sign(dir, signer, root, new Date("2026-11-20T00:00:00Z"));
  expect(signed).toMatchObject({ version: 4, bootstrap: true });
  expect(signed.members.map((m) => [m.address, m.invited_by === signer.pub ? "signer" : m.invited_by, m.founder_controlled])).toEqual([
    ["founder@contosohq.example", "signer", true],
    ["dominik@trydirex.com", "founder@contosohq.example", true],
  ]);
  expect(verifyList(await read(dir), root, [], null, new Date("2026-11-20T00:00:00Z")).ok).toBe(true);
  const state = JSON.parse(await readFile(join(dir, "signer-state.json"), "utf8")) as { invites: { part1_hash: string; used_at: string | null }[] };
  expect(state.invites.every((i) => i.used_at && /^[0-9a-f]{64}$/.test(i.part1_hash))).toBe(true);
  expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("signer-state.json\n");
});

test("with the stop-rule note in place an invite needs no founder assertion", async () => {
  const s = await setup();
  const note = join(s.dir, "2026-12-08-stop-rule.md");
  await writeFile(note, "passed");
  await writeFile(join(s.dir, ".gitignore"), "notes/");
  await expect(invite(s.dir, s.signer, s.root, { address: "a@b.com", inviter: "signer", criteria: YES, founderControlled: false, stopRuleNote: note }, NOW)).resolves.toHaveProperty("part2");
  await invite(s.dir, s.signer, s.root, { address: "c@d.com", inviter: "signer", criteria: YES, founderControlled: true }, NOW);
  expect(await readFile(join(s.dir, ".gitignore"), "utf8")).toBe("notes/\nsigner-state.json\n");
});

test("a left member goes; its inviter keeps the right to invite", async () => {
  const s = await setup();
  await join2(s, "a@b.com");
  await join2(s, "c@d.com", "a@b.com");
  const list = await remove(s.dir, s.signer, s.root, "c@d.com", "left", NOW);
  expect(list.members.map((m) => [m.address, m.may_invite])).toEqual([["a@b.com", true]]);
  expect(list.removed).toEqual([{ address: "c@d.com", invited_by: "a@b.com", reason: "left", removed_in: 4 }]);
});

// Block.

test("in bootstrap an invite without --founder-controlled is refused, and so is a missing stop-rule note", async () => {
  const s = await setup();
  await expect(invite(s.dir, s.signer, s.root, { address: "a@b.com", inviter: "signer", criteria: YES, founderControlled: false }, NOW)).rejects.toThrow(/I control this Mailbox/);
  await expect(invite(s.dir, s.signer, s.root, { address: "a@b.com", inviter: "signer", criteria: YES, founderControlled: false, stopRuleNote: join(s.dir, "none.md") }, NOW)).rejects.toThrow(/does not exist/);
  await expect(readFile(join(s.dir, "signer-state.json"))).rejects.toThrow();
});

test("an invite with a criterion not met, or from a member who may not invite, is refused", async () => {
  const s = await setup();
  await expect(invite(s.dir, s.signer, s.root, { address: "a@b.com", inviter: "signer", criteria: { ...YES, domain_six_months: false }, founderControlled: true }, NOW)).rejects.toThrow(/criterion/);
  await expect(invite(s.dir, s.signer, s.root, { address: "a@b.com", inviter: "x@y.com", criteria: YES, founderControlled: true }, NOW)).rejects.toThrow(/may invite/);
});

test("a wrong or swapped join code, an expired one, and a second use are refused", async () => {
  const s = await setup();
  const codes = await invite(s.dir, s.signer, s.root, { address: "a@b.com", inviter: "signer", criteria: YES, founderControlled: true }, NOW);
  const reply = { address: "a@b.com", key: memberKey(), ...codes };
  await expect(accept(s.dir, s.signer, s.root, { ...reply, part2: "wrong" }, NOW)).rejects.toThrow(/does not match/);
  await expect(accept(s.dir, s.signer, s.root, { ...reply, part1: codes.part2, part2: codes.part1 }, NOW)).rejects.toThrow(/does not match/);
  await expect(accept(s.dir, s.signer, s.root, reply, new Date(NOW.getTime() + 24 * 3_600_000 + 60_000))).rejects.toThrow(/expired/);
  expect((await read(s.dir)).members).toEqual([]);
  await accept(s.dir, s.signer, s.root, reply, NOW);
  await expect(accept(s.dir, s.signer, s.root, reply, NOW)).rejects.toThrow(/no open invite/);
});

test("an abuse removal takes the inviter's right to invite, and a list leaving it is never written", async () => {
  const s = await setup();
  await join2(s, "a@b.com");
  await join2(s, "c@d.com", "a@b.com");
  const before = await read(s.dir);
  const body = unsigned(before);
  const leaving = { version: before.version + 1, expires: before.expires, members: body.members.filter((m) => m.address !== "c@d.com"), removed: [{ address: "c@d.com", invited_by: "a@b.com", reason: "abuse" as const, removed_in: before.version + 1 }] };
  await expect(publish(s.dir, s.signer, s.root, leaving, NOW)).rejects.toThrow(/inviter_may_still_invite/);
  expect(await read(s.dir)).toEqual(before);

  const list = await remove(s.dir, s.signer, s.root, "c@d.com", "abuse", NOW);
  expect(list.members).toEqual([{ ...before.members[0], may_invite: false }]);
  expect(verifyList(list, s.root, [], { version: before.version, contentHash: contentHash(body), list: body, rootChainLength: 0, rootChainHash: rootChainHash([]), pinnedRootHash: pinnedRootHash(s.root) }, NOW).ok).toBe(true);
  await expect(invite(s.dir, s.signer, s.root, { address: "e@f.com", inviter: "a@b.com", criteria: YES, founderControlled: true }, NOW)).rejects.toThrow(/may invite/);
});

test("a signer key inside the list directory is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "placement-list-"));
  await expect(init(join(dir, "signer.pem"), dir, NOW)).rejects.toThrow(/outside/);
});

// Join replies as .eml files, DKIM-signed with a throwaway key whose DNS record only this resolver knows.

const dkimKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const dkimRecord = `v=DKIM1; k=rsa; p=${dkimKey.publicKey.export({ type: "spki", format: "der" }).toString("base64")}`;
const resolver: DNSResolver = async (name, type) => {
  if (type === "TXT" && (name === "s1._domainkey.joiner.test" || name === "s1._domainkey.other.test")) return [[dkimRecord]];
  throw Object.assign(new Error(`no ${type} for ${name}`), { code: "ENOTFOUND" });
};
const ADDRESS = "dominik@joiner.test";

/** A join reply as the signer downloads it: signed by the joiner's domain, then stamped on arrival. */
async function eml(
  codes: { part1: string; part2: string },
  opts: { arrived?: Date; dkimDomain?: string; text?: (t: string) => string; signWith?: KeyObject; tamper?: (m: string) => string } = {},
) {
  const member = generateKeyPairSync("ed25519");
  const key = member.publicKey.export({ format: "jwk" }).x!;
  const j = { address: ADDRESS, key, ...codes };
  const sig = edSign(null, Buffer.from(joinSigned(j)), opts.signWith ?? member.privateKey).toString("base64url");
  const text = (opts.text ?? ((t) => t))(joinText({ ...j, sig }));
  const message = [
    `From: ${ADDRESS}`,
    "To: signer@circle.test",
    `Subject: ${JOIN_SUBJECT}`,
    "Date: Tue, 10 Nov 2026 12:00:00 +0000",
    "Message-ID: <join-1@joiner.test>",
    "In-Reply-To: <p1@circle.test>",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text).toString("base64"),
    "",
  ].join("\r\n");
  const signed = await dkimSign(message, { signatureData: [{ signingDomain: opts.dkimDomain ?? "joiner.test", selector: "s1", privateKey: dkimKey.privateKey.export({ type: "pkcs8", format: "pem" }) }] });
  const arrived = (opts.arrived ?? new Date(NOW.getTime() + 60_000)).toUTCString();
  const file = join(await mkdtemp(join(tmpdir(), "join-reply-")), "reply.eml");
  await writeFile(file, `Received: by mx.circle.test; ${arrived}\r\n${signed.signatures}${(opts.tamper ?? ((m) => m))(message)}`);
  return { file, key };
}
const acceptEml = async (s: Awaited<ReturnType<typeof setup>>, file: string) => {
  const { reply, receivedAt } = await readJoinReply(await readFile(file), resolver);
  return accept(s.dir, s.signer, s.root, reply, receivedAt);
};
const invited = async (s: Awaited<ReturnType<typeof setup>>) => invite(s.dir, s.signer, s.root, { address: ADDRESS, inviter: "signer", criteria: YES, founderControlled: true }, NOW);

test("a good join reply within 24 hours adds the Mailbox with its member key, once", async () => {
  const s = await setup();
  const codes = await invited(s);
  const { file, key } = await eml(codes, { arrived: new Date(NOW.getTime() + 24 * 3_600_000 - 60_000) });
  const list = await acceptEml(s, file);
  expect(list.members).toMatchObject([{ address: ADDRESS, key, listed_at: "2026-11-11" }]);
  expect(verifyList(await read(s.dir), s.root, [], null, NOW).ok).toBe(true);
  await expect(acceptEml(s, file)).rejects.toThrow(/no open invite/);
});

test("a reply DKIM-signed by another domain, or whose signature fails, is refused", async () => {
  const s = await setup();
  const codes = await invited(s);
  await expect(acceptEml(s, (await eml(codes, { dkimDomain: "other.test" })).file)).rejects.toThrow(/no passing DKIM signature from joiner.test/);
  await expect(acceptEml(s, (await eml(codes, { tamper: (m) => m.replace(`Subject: ${JOIN_SUBJECT}`, "Subject: Changed") })).file)).rejects.toThrow(/no passing DKIM/);
  expect((await read(s.dir)).members).toEqual([]);
});

test("a reply missing part 2, with the parts swapped, or signed by another member key is refused", async () => {
  const s = await setup();
  const codes = await invited(s);
  const noPart2 = await eml(codes, { text: (t) => t.replace(/^Part 2: .*\n/m, "") });
  await expect(acceptEml(s, noPart2.file)).rejects.toThrow(/not a join reply/);
  await expect(acceptEml(s, (await eml({ part1: codes.part2, part2: codes.part1 })).file)).rejects.toThrow(/does not match/);
  await expect(acceptEml(s, (await eml(codes, { signWith: generateKeyPairSync("ed25519").privateKey })).file)).rejects.toThrow(/did not sign/);
  expect((await read(s.dir)).members).toEqual([]);
});

test("a reply that arrived 24 hours and 1 minute after the invite is refused", async () => {
  const s = await setup();
  const codes = await invited(s);
  await expect(acceptEml(s, (await eml(codes, { arrived: new Date(NOW.getTime() + 24 * 3_600_000 + 60_000) })).file)).rejects.toThrow(/expired/);
});
