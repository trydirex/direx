// SPDX-License-Identifier: AGPL-3.0-only
// The one way out of a sandbox: a CONNECT proxy on a Unix socket. It tunnels only to a target the
// caller allows, and only to an address it checked itself, so a name that resolves to this server,
// a private network or a special range is refused (ADR 0026 rule 007). A refusal closes the
// connection, so the client sees a network error and never mistakes it for the provider's answer.
import { lookup } from "node:dns/promises";
import { createConnection, createServer, isIP, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { domainToASCII } from "node:url";

const MAX_HEADER_BYTES = 8 * 1024;
const HANDSHAKE_MS = 10_000;
const IDLE_MS = 5 * 60_000;

// IANA special-purpose registries (IPv4 and IPv6), plus multicast and reserved space.
const V4_BLOCKED = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
  "192.0.0.0/24", "192.0.2.0/24", "192.31.196.0/24", "192.52.193.0/24", "192.88.99.0/24", "192.168.0.0/16",
  "192.175.48.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
];
// Inside 2000::/3, the only global unicast space, these are still special.
const V6_BLOCKED = ["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"];

function v4ToBig(ip: string): bigint {
  return ip.split(".").reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
}

function v6ToBig(ip: string): bigint {
  // An embedded dotted quad (::ffff:1.2.3.4) becomes two hex groups first.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(ip)?.[1];
  let text = ip;
  if (dotted) {
    const v4 = v4ToBig(dotted);
    text = ip.slice(0, -dotted.length) + `${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const left = head ? head.split(":") : [];
  const right = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n);
}

function inCidr(value: bigint, cidr: string, bits: 32 | 128): boolean {
  const [base, len] = cidr.split("/") as [string, string];
  const shift = BigInt(bits - Number(len));
  const b = bits === 32 ? v4ToBig(base) : v6ToBig(base);
  return value >> shift === b >> shift;
}

function v4Public(ip: string): boolean {
  if (ip === "255.255.255.255") return false;
  const n = v4ToBig(ip);
  return !V4_BLOCKED.some((c) => inCidr(n, c, 32));
}

const big4 = (n: bigint) => [n >> 24n, (n >> 16n) & 255n, (n >> 8n) & 255n, n & 255n].join(".");

/** True only for an address on the public internet. Embedded IPv4 forms are judged by their IPv4 address. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4Public(ip);
  if (family !== 6) return false;
  const n = v6ToBig(ip.toLowerCase().split("%")[0]!);
  // IPv4-mapped and the NAT64 well-known prefix carry an IPv4 address in the low 32 bits.
  if (inCidr(n, "::ffff:0:0/96", 128) || inCidr(n, "64:ff9b::/96", 128)) return v4Public(big4(n & 0xffffffffn));
  if (!inCidr(n, "2000::/3", 128)) return false;
  return !V6_BLOCKED.some((c) => inCidr(n, c, 128));
}

/** Lowercase, no trailing dot, IDN as punycode; null when it isn't a usable host name or address. */
export function normalizeHost(host: string): string | null {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare)) return bare.toLowerCase();
  const ascii = domainToASCII(bare.replace(/\.$/, "").toLowerCase());
  return ascii && /^[a-z0-9.-]+$/.test(ascii) && !ascii.includes("..") ? ascii : null;
}

/** An exact host, or `*.base` for one or more labels below base (never base itself). */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p));
}

export type ConnectTarget = { host: string; port: number };

/** The CONNECT line, once the whole header has arrived; "incomplete" until then. */
export function parseConnect(head: Buffer): { target: ConnectTarget; rest: Buffer } | "incomplete" | "bad" {
  const end = head.indexOf("\r\n\r\n");
  if (end < 0) return head.length > MAX_HEADER_BYTES ? "bad" : "incomplete";
  const m = /^CONNECT (\[[0-9a-fA-F:.]+\]|[^\s:[\]]+):(\d{1,5}) HTTP\/1\.[01]\r\n/.exec(head.subarray(0, end + 2).toString("latin1"));
  const host = m && normalizeHost(m[1]!);
  const port = Number(m?.[2]);
  if (!host || !(port > 0 && port < 65536)) return "bad";
  return { target: { host, port }, rest: head.subarray(end + 4) };
}

export type EgressRules = {
  /** Whether the client may ask for this normalised target at all. */
  allow: (target: ConnectTarget) => boolean;
  /** Whether a resolved address may be reached. Defaults to public addresses that aren't this server's. */
  allowAddress?: (address: string) => boolean;
  /** Resolves a name to every address it has. */
  resolve?: (host: string) => Promise<string[]>;
  onRefused?: (target: string, why: string) => void;
};

const ownAddresses = () =>
  new Set(Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((a) => a.address.toLowerCase().split("%")[0]!)));

/** Public and not one of this machine's own addresses. */
export function defaultAddressRule(): (address: string) => boolean {
  const own = ownAddresses();
  return (address) => isPublicAddress(address) && !own.has(address.toLowerCase());
}

const resolveAll = async (host: string) => (isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address));

/** Picks the address to connect to, or says why there is none. Every answer must pass, so a mixed answer is refused. */
export async function checkedAddress(target: ConnectTarget, rules: EgressRules): Promise<{ address: string } | { refused: string }> {
  if (!rules.allow(target)) return { refused: "not an allowed host" };
  let addresses: string[];
  try {
    addresses = await (rules.resolve ?? resolveAll)(target.host);
  } catch {
    return { refused: "the name did not resolve" };
  }
  const ok = rules.allowAddress ?? defaultAddressRule();
  if (addresses.length === 0 || !addresses.every(ok)) return { refused: "it resolves to an address that may not be reached" };
  return { address: addresses[0]! };
}

function tunnel(client: Socket, rules: EgressRules) {
  let head = Buffer.alloc(0);
  const handshake = setTimeout(() => client.destroy(), HANDSHAKE_MS);
  client.setTimeout(IDLE_MS, () => client.destroy());
  client.on("error", () => client.destroy());
  client.on("close", () => clearTimeout(handshake));
  const onData = async (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const parsed = parseConnect(head);
    if (parsed === "incomplete") return;
    client.off("data", onData);
    client.pause();
    if (parsed === "bad") {
      rules.onRefused?.("?", "not a CONNECT request");
      return client.destroy();
    }
    const name = `${parsed.target.host}:${parsed.target.port}`;
    const picked = await checkedAddress(parsed.target, rules);
    if ("refused" in picked) {
      rules.onRefused?.(name, picked.refused);
      return client.destroy();
    }
    const upstream = createConnection({ host: picked.address, port: parsed.target.port }, () => {
      clearTimeout(handshake);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (parsed.rest.length) upstream.write(parsed.rest);
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
    upstream.setTimeout(IDLE_MS, () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  };
  client.on("data", onData);
}

/** Listens on a Unix socket until closed. */
export function startEgressProxy(socketPath: string, rules: EgressRules): Promise<Server> {
  const server = createServer((client) => tunnel(client, rules));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

/** Exact `host:port` entries, as CLI runs list them. */
export const exactTargets = (entries: readonly string[]) => (t: ConnectTarget) => entries.includes(`${t.host}:${t.port}`);

/** Manifest hosts on port 443 only, as plugins list them. */
export const manifestHosts = (patterns: readonly string[]) => (t: ConnectTarget) => t.port === 443 && hostMatches(t.host, patterns);
