// SPDX-License-Identifier: AGPL-3.0-only
// The Placement circle's signer, run by the founder on their own machine against the checkout of the
// private list repository. The signer key lives in a file outside the Direx checkout and the list
// directory. Every command that changes the list signs the next version, checks it exactly as an
// install would, and writes members.json only when an install would accept it. Invites and the hashes
// of their join codes stay in signer-state.json next to the list, which is never committed. See docs/placement-signer.md.
//
//   bun scripts/placement-signer.ts init --key-file ~/direx-signer.pem [--dir ~/placement-list]
//   bun scripts/placement-signer.ts invite you@example.com --inviter signer --criteria-named-person \
//     --criteria-business-website --criteria-domain-six-months --founder-controlled --dir ... --key-file ...
//   bun scripts/placement-signer.ts accept reply.eml --dir ... --key-file ...
//   bun scripts/placement-signer.ts remove you@example.com --abuse|--left --dir ... --key-file ...
//   bun scripts/placement-signer.ts sign --dir ... --key-file ...
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify, timingSafeEqual, type KeyObject } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { dkimVerify, type DNSResolver } from "mailauth";
import { canonical, contentHash, isBootstrap, joinSigned, parseJoin, PINNED_ROOT, pinnedRootHash, rootChainHash, unsigned, verifyList, type Criteria, type Join, type Member, type MemberList, type Root, type TrustedList, type UnsignedList } from "../apps/api/src/modules/placement/index";

const DAY = 86_400_000;
/** How long a signed list stays valid; `sign` renews it. */
const LIST_DAYS = 30;
const JOIN_CODE_HOURS = 24;
const MEMBERS = "members.json";
const ROOTS = "roots.json";
const STATE = "signer-state.json";
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPO = resolve(import.meta.dirname, "..");
/** What `--founder-controlled` asserts, recorded with the invite. */
export const ASSERTION = "I control this Mailbox";

export type Signer = { pub: string; priv: KeyObject };
export type Invite = {
  address: string;
  inviter: string;
  criteria: Criteria;
  criteria_checked_by: string;
  founder_controlled: boolean;
  /** The dated stop-rule note the invite relied on, or null when the founder asserted control instead. */
  stop_rule_note: string | null;
  invited_at: string;
  expires: string;
  part1_hash: string;
  part2_hash: string;
  used_at: string | null;
};
type State = { invites: Invite[] };
/** What a join reply proves: who joins, with which member key, and the two code parts it carried. */
export type JoinReply = Join;

const fail = (message: string): never => {
  throw new Error(message);
};
const inside = (path: string, dir: string) => {
  const r = relative(resolve(dir), resolve(path));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
const sha256 = (s: string) => createHash("sha256").update(s).digest();
const matches = (code: string, hash: string) => timingSafeEqual(sha256(code), Buffer.from(hash, "hex"));
const pubOf = (k: KeyObject) => createPublicKey(k).export({ format: "jwk" }).x ?? fail("not an Ed25519 key");
const later = (now: Date, ms: number) => new Date(now.getTime() + ms).toISOString();

async function readJson<T>(path: string, missing: T): Promise<T> {
  if (!existsSync(path)) return missing;
  return JSON.parse(await readFile(path, "utf8")) as T;
}
const writeJson = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

function keyOutsideInstall(keyFile: string, dir: string | undefined) {
  if (inside(keyFile, REPO) || (dir && inside(keyFile, dir))) fail("the signer key must live outside the Direx checkout and the list directory");
}

/** The root this signer checks against: the pinned one once the founder pinned it, else this key alone. */
export const rootFor = (signer: Signer): Root => (PINNED_ROOT.keys.length > 0 ? PINNED_ROOT : { keys: [signer.pub], threshold: 1 });

/** Makes a new signer key, writes it to `keyFile` (never over an existing file, mode 0600), and with `dir` signs an empty first list. */
export async function init(keyFile: string, dir: string | undefined, now: Date, root?: Root): Promise<Signer> {
  keyOutsideInstall(keyFile, dir);
  if (dir && existsSync(join(dir, MEMBERS))) fail(`${join(dir, MEMBERS)} already exists`);
  // The list folder is made before the key, so a missing folder never leaves a key with no list.
  if (dir) await mkdir(dir, { recursive: true });
  const k = generateKeyPairSync("ed25519");
  await writeFile(keyFile, k.privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  const signer = { pub: pubOf(k.privateKey), priv: k.privateKey };
  if (dir) await publish(dir, signer, root ?? { keys: [signer.pub], threshold: 1 }, { version: 1, expires: later(now, LIST_DAYS * DAY), members: [], removed: [] }, now);
  return signer;
}

export async function loadSigner(keyFile: string, dir: string | undefined): Promise<Signer> {
  keyOutsideInstall(keyFile, dir);
  if (statSync(keyFile).mode & 0o077) fail(`${keyFile} can be read by other users; run chmod 600 on it`);
  const priv = createPrivateKey(await readFile(keyFile));
  return { pub: pubOf(priv), priv };
}

/** Keeps the signer state out of the private repository: it stays on the signer's machine. */
async function ignoreState(dir: string) {
  const path = join(dir, ".gitignore");
  const lines = existsSync(path) ? (await readFile(path, "utf8")).split("\n") : [];
  if (!lines.includes(STATE)) await appendFile(path, `${lines.length > 0 && lines.at(-1) !== "" ? "\n" : ""}${STATE}\n`);
}

const currentList = (dir: string) => readJson<MemberList | null>(join(dir, MEMBERS), null);
const readState = (dir: string) => readJson<State>(join(dir, STATE), { invites: [] });

/**
 * Signs `next` as the following version and writes members.json, but only if an install holding the
 * current list would accept it. Throws, writing nothing, otherwise.
 */
export async function publish(dir: string, signer: Signer, root: Root, next: Omit<UnsignedList, "bootstrap">, now: Date): Promise<MemberList> {
  const chain = await readJson<Root[]>(join(dir, ROOTS), []);
  const prev = await currentList(dir);
  const lastTrusted: TrustedList | null = prev && { version: prev.version, contentHash: contentHash(unsigned(prev)), list: unsigned(prev), rootChainLength: chain.length, rootChainHash: rootChainHash(chain), pinnedRootHash: pinnedRootHash(root) };
  const body: UnsignedList = { ...next, bootstrap: isBootstrap((chain.at(-1) ?? root).keys.length) };
  const list: MemberList = { ...body, signatures: [{ key: signer.pub, sig: edSign(null, Buffer.from(canonical(body)), signer.priv).toString("base64url") }] };
  const verdict = verifyList(list, root, chain, lastTrusted, now);
  if (!verdict.ok) fail(`an install would refuse this list (${verdict.reason}); nothing was written`);
  await writeJson(join(dir, MEMBERS), list);
  return list;
}

/** Whether `inviter` (a member address or a signer key) may invite now. */
async function mayInvite(dir: string, root: Root, list: MemberList | null, inviter: string) {
  const chain = await readJson<Root[]>(join(dir, ROOTS), []);
  if ((chain.at(-1) ?? root).keys.includes(inviter)) return true;
  return list?.members.some((m) => m.address === inviter && m.may_invite) ?? false;
}

/**
 * Records an invite whose admission criteria a signer checked, and makes the two join code parts.
 * Until the founder's dated stop-rule note exists, only a Mailbox the founder controls may be invited.
 */
export async function invite(
  dir: string,
  signer: Signer,
  root: Root,
  opts: { address: string; inviter: string; criteria: Criteria; founderControlled: boolean; stopRuleNote?: string | undefined },
  now: Date,
): Promise<{ part1: string; part2: string; expires: string }> {
  const address = opts.address.toLowerCase();
  if (!ADDRESS.test(address)) fail(`${opts.address} is not an email address`);
  if (opts.stopRuleNote !== undefined && !existsSync(opts.stopRuleNote)) fail(`the stop-rule note ${opts.stopRuleNote} does not exist`);
  if (opts.stopRuleNote === undefined && !opts.founderControlled) fail(`until the stop rule has passed, only a Mailbox you control may join: pass --founder-controlled to assert "${ASSERTION}", or --stop-rule-passed <dated note>`);
  if (!(opts.criteria.named_person && opts.criteria.business_website && opts.criteria.domain_six_months)) fail("every admission criterion must be yes");
  const list = await currentList(dir);
  if (list?.members.some((m) => m.address === address) || list?.removed.some((r) => r.address === address)) fail(`${address} is or was already a member`);
  const inviter = opts.inviter === "signer" ? signer.pub : opts.inviter;
  if (!(await mayInvite(dir, root, list, inviter))) fail(`${inviter} is neither a signer nor a member who may invite`);

  const part1 = randomBytes(16).toString("base64url");
  const part2 = randomBytes(16).toString("base64url");
  const expires = later(now, JOIN_CODE_HOURS * 3_600_000);
  const state = await readState(dir);
  await ignoreState(dir);
  const entry: Invite = {
    address,
    inviter,
    criteria: opts.criteria,
    criteria_checked_by: signer.pub,
    founder_controlled: opts.founderControlled,
    stop_rule_note: opts.stopRuleNote ?? null,
    invited_at: now.toISOString(),
    expires,
    part1_hash: sha256(part1).toString("hex"),
    part2_hash: sha256(part2).toString("hex"),
    used_at: null,
  };
  await writeJson(join(dir, STATE), { invites: [...state.invites.filter((i) => i.address !== address || i.used_at), entry] });
  return { part1, part2, expires };
}

/**
 * Adds the joiner to the list once both code parts match an open invite that has not expired.
 * `receivedAt` is when the join reply arrived; the reply's own checks (DKIM and the member-key
 * signature over both parts) belong to whatever turned the reply into a `JoinReply`.
 */
export async function accept(dir: string, signer: Signer, root: Root, reply: JoinReply, receivedAt: Date): Promise<MemberList> {
  const address = reply.address.toLowerCase();
  const state = await readState(dir);
  const open = state.invites.find((i) => i.address === address && !i.used_at) ?? fail(`no open invite for ${address}`);
  if (receivedAt.getTime() >= Date.parse(open.expires)) fail(`the join code for ${address} expired at ${open.expires}; invite again`);
  if (!(matches(reply.part1, open.part1_hash) && matches(reply.part2, open.part2_hash))) fail(`the join code for ${address} does not match`);
  const prev = await currentList(dir);
  if (!(await mayInvite(dir, root, prev, open.inviter))) fail(`${open.inviter} may no longer invite`);
  const member: Member = {
    address,
    provider: "google",
    key: reply.key,
    invited_by: open.inviter,
    criteria_checked_by: open.criteria_checked_by,
    criteria: open.criteria,
    listed_at: receivedAt.toISOString().slice(0, 10),
    may_invite: true,
    founder_controlled: open.founder_controlled,
  };
  const list = await publish(dir, signer, root, { version: (prev?.version ?? 0) + 1, expires: later(receivedAt, LIST_DAYS * DAY), members: [...(prev?.members ?? []), member], removed: prev?.removed ?? [] }, receivedAt);
  await writeJson(join(dir, STATE), { invites: state.invites.map((i) => (i === open ? { ...i, used_at: receivedAt.toISOString() } : i)) });
  return list;
}

/** The message's header fields, unfolded, names lowercased, in order from the top. */
function headers(head: string): [string, string][] {
  return head
    .replace(/\r?\n[ \t]+/g, " ")
    .split(/\r?\n/)
    .flatMap((line) => {
      const i = line.indexOf(":");
      return i > 0 ? [[line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()] as [string, string]] : [];
    });
}

/** The text of a single-part text/plain message, the only form an install sends a join reply in. */
function textBody(eml: string): { head: [string, string][]; text: string } {
  const blank = /\r?\n\r?\n/.exec(eml) ?? fail("the reply has no body");
  const head = headers(eml.slice(0, blank.index));
  const body = eml.slice(blank.index + blank[0].length);
  const field = (name: string) => head.find(([n]) => n === name)?.[1].toLowerCase() ?? "";
  const type = field("content-type");
  if (type && !/^text\/plain\s*(;|$)/.test(type)) fail("the reply is not a plain text message, so it is not a join reply");
  const encoding = field("content-transfer-encoding") || "7bit";
  if (encoding === "base64") return { head, text: Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8") };
  if (encoding === "7bit" || encoding === "8bit") return { head, text: Buffer.from(body, "latin1").toString("utf8") };
  return fail(`the reply's body is encoded as ${encoding}, which a join reply never is`);
}

/**
 * Turns a join reply email, as downloaded from the signer's Mailbox, into the reply `accept` takes.
 * It must carry a passing DKIM signature from its own From domain over the whole body, and the member
 * key it names must have signed both code parts and the address. Its arrival time is the top
 * Received header: the signer's own mail server wrote that one as the mail arrived, while the Date
 * header is the joiner's to set. `resolver` replaces DNS, for tests.
 */
export async function readJoinReply(eml: Buffer, resolver?: DNSResolver): Promise<{ reply: JoinReply; receivedAt: Date }> {
  const dkim = await dkimVerify(eml, resolver ? { resolver } : {});
  if (dkim.fromFields !== 1 || dkim.headerFrom.length !== 1) fail("the reply must have exactly one From address");
  const from = dkim.headerFrom[0]!.toLowerCase();
  const domain = from.slice(from.lastIndexOf("@") + 1);
  const signed = dkim.results.some((r) => r.status.result === "pass" && r.signingDomain?.toLowerCase() === domain && !r.status.underSized);
  if (!signed) fail(`the reply has no passing DKIM signature from ${domain}, its From domain`);

  const { head, text } = textBody(eml.toString("latin1"));
  const j = parseJoin(text) ?? fail("the reply is not a join reply: it must carry both join code parts, the address, the member key and its signature, exactly as Direx writes them");
  if (j.address !== from) fail(`the reply names ${j.address} but comes from ${from}`);
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: j.key }, format: "jwk" });
  if (!edVerify(null, Buffer.from(joinSigned(j)), key, Buffer.from(j.sig, "base64url"))) fail("the member key did not sign this join reply");

  const received = head.find(([n]) => n === "received")?.[1] ?? fail("the reply has no Received header, so when it arrived is unknown");
  const receivedAt = new Date(received.slice(received.lastIndexOf(";") + 1).trim());
  if (Number.isNaN(receivedAt.getTime())) fail("the reply's top Received header has no date");
  return { reply: { address: j.address, key: j.key, part1: j.part1, part2: j.part2 }, receivedAt };
}

/**
 * Removes a member. For abuse its inviter loses the right to invite in the same version, and nothing
 * else changes, not even the expiry, so one signer may publish it alone.
 */
export async function remove(dir: string, signer: Signer, root: Root, address: string, reason: "abuse" | "left", now: Date): Promise<MemberList> {
  const prev = (await currentList(dir)) ?? fail("there is no list yet");
  const gone = prev.members.find((m) => m.address === address.toLowerCase()) ?? fail(`${address} is not a member`);
  const version = prev.version + 1;
  const members = prev.members.filter((m) => m !== gone).map((m) => (reason === "abuse" && m.address === gone.invited_by ? { ...m, may_invite: false } : m));
  const removed = [...prev.removed, { address: gone.address, invited_by: gone.invited_by, reason, removed_in: version }];
  return publish(dir, signer, root, { version, expires: reason === "abuse" ? prev.expires : later(now, LIST_DAYS * DAY), members, removed }, now);
}

/** Signs the current list again as the next version with a fresh expiry. */
export async function sign(dir: string, signer: Signer, root: Root, now: Date): Promise<MemberList> {
  const prev = (await currentList(dir)) ?? fail("there is no list yet; run init with --dir");
  return publish(dir, signer, root, { version: prev.version + 1, expires: later(now, LIST_DAYS * DAY), members: prev.members, removed: prev.removed }, now);
}

const USAGE = `usage: bun scripts/placement-signer.ts <command> [--dir <list checkout>] [--key-file <signer key>]
  init --key-file <new file> [--dir <dir>]
  invite <address> --inviter <member address|signer key|signer> --criteria-named-person --criteria-business-website --criteria-domain-six-months (--founder-controlled | --stop-rule-passed <note>)
  accept <reply.eml>
  remove <address> (--abuse | --left)
  sign
--dir defaults to DIREX_PLACEMENT_LIST and --key-file to DIREX_PLACEMENT_SIGNER_KEY.`;

async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      "key-file": { type: "string" },
      inviter: { type: "string" },
      "criteria-named-person": { type: "boolean" },
      "criteria-business-website": { type: "boolean" },
      "criteria-domain-six-months": { type: "boolean" },
      "founder-controlled": { type: "boolean" },
      "stop-rule-passed": { type: "string" },
      abuse: { type: "boolean" },
      left: { type: "boolean" },
    },
  });
  const [command, address] = positionals;
  // For accept, the positional is the join reply email file.
  const dir = v.dir ?? process.env.DIREX_PLACEMENT_LIST;
  const keyFile = v["key-file"] ?? process.env.DIREX_PLACEMENT_SIGNER_KEY ?? fail(USAGE);
  const now = new Date();

  if (command === "init") {
    const signer = await init(keyFile, dir, now);
    console.log(`signer public key: ${signer.pub}`);
    console.log(`paste into PINNED_ROOT in apps/api/src/modules/placement/domain/root.ts:\nexport const PINNED_ROOT: Root = { keys: ["${signer.pub}"], threshold: 1 };`);
    if (dir) console.log(`wrote an empty bootstrap list to ${join(dir, MEMBERS)}`);
    return;
  }
  if (!dir) throw new Error(USAGE);
  const signer = await loadSigner(keyFile, dir);
  const root = rootFor(signer);
  if (PINNED_ROOT.keys.length === 0) console.error("note: no root is pinned in this release yet, so lists are checked against this key alone and installs refuse them until it is pinned");

  if (command === "invite" && address) {
    const criteria = { named_person: !!v["criteria-named-person"], business_website: !!v["criteria-business-website"], domain_six_months: !!v["criteria-domain-six-months"] };
    const codes = await invite(dir, signer, root, { address, inviter: v.inviter ?? fail(USAGE), criteria, founderControlled: !!v["founder-controlled"], stopRuleNote: v["stop-rule-passed"] }, now);
    if (v["founder-controlled"]) console.log(`recorded your assertion: "${ASSERTION}" (${address})`);
    console.log(`join code part 1 (email it by hand from your own address to ${address}): ${codes.part1}`);
    console.log(`join code part 2 (paste it into the joining install's join form): ${codes.part2}`);
    console.log(`both expire at ${codes.expires}`);
  } else if (command === "accept" && address) {
    const { reply, receivedAt } = await readJoinReply(await readFile(address));
    const list = await accept(dir, signer, root, reply, receivedAt);
    console.log(`added ${reply.address} (reply arrived ${receivedAt.toISOString()}); wrote version ${list.version} to ${join(dir, MEMBERS)}`);
  } else if (command === "remove" && address && v.abuse !== v.left) {
    const list = await remove(dir, signer, root, address, v.abuse ? "abuse" : "left", now);
    console.log(`removed ${address}; wrote version ${list.version} to ${join(dir, MEMBERS)}`);
  } else if (command === "sign") {
    const list = await sign(dir, signer, root, now);
    console.log(`signed version ${list.version}, valid until ${list.expires}; wrote ${join(dir, MEMBERS)}`);
  } else {
    fail(USAGE);
  }
  console.log("commit and push the list directory to the private repository");
}

if (import.meta.main) {
  main().catch((e: unknown) => {
    console.error(`placement-signer: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
