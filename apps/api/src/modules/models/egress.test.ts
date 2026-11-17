// SPDX-License-Identifier: AGPL-3.0-only
// The sandbox's egress proxy: which addresses count as public, how targets are matched, and a real
// tunnel over a Unix socket (ADR 0026 rule 007).
import { mkdtempSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  checkedAddress,
  defaultAddressRule,
  exactTargets,
  hostMatches,
  isPublicAddress,
  manifestHosts,
  normalizeHost,
  parseConnect,
  startEgressProxy,
} from "./adapters/runtime/egress";

describe("isPublicAddress", () => {
  test.each(["8.8.8.8", "93.184.215.14", "2606:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"])("%s is public", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
  test.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "255.255.255.255", "224.0.0.1", "240.0.0.1", "198.18.0.1", "192.0.2.1", "203.0.113.9",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1",
    "64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::", "2001:0:4136:e378::1", "2001:db8::1", "3fff::1", "fe80::1%eth0",
    "not-an-address", "",
  ])("%s is not public", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
  test("172.32.0.1 sits just outside 172.16.0.0/12", () => {
    expect(isPublicAddress("172.32.0.1")).toBe(true);
  });
});

describe("targets", () => {
  test("hosts are normalised: case, a trailing dot, IDN, brackets", () => {
    expect(normalizeHost("Example.COM.")).toBe("example.com");
    expect(normalizeHost("bücher.de")).toBe("xn--bcher-kva.de");
    expect(normalizeHost("[::1]")).toBe("::1");
    expect(normalizeHost("a..b")).toBeNull();
    expect(normalizeHost("exa mple.com")).toBeNull();
  });

  test("a wildcard covers labels below its base, never the base or a lookalike", () => {
    expect(hostMatches("api.example.com", ["*.example.com"])).toBe(true);
    expect(hostMatches("a.b.example.com", ["*.example.com"])).toBe(true);
    expect(hostMatches("example.com", ["*.example.com"])).toBe(false);
    expect(hostMatches("evilexample.com", ["*.example.com"])).toBe(false);
    expect(hostMatches("example.com", ["example.com"])).toBe(true);
    expect(hostMatches("www.example.com", ["example.com"])).toBe(false);
  });

  test("manifest hosts are reachable on 443 only; CLI entries are exact host and port", () => {
    expect(manifestHosts(["example.com"])({ host: "example.com", port: 443 })).toBe(true);
    expect(manifestHosts(["example.com"])({ host: "example.com", port: 80 })).toBe(false);
    expect(exactTargets(["api.anthropic.com:443"])({ host: "api.anthropic.com", port: 443 })).toBe(true);
    expect(exactTargets(["api.anthropic.com:443"])({ host: "api.anthropic.com", port: 8443 })).toBe(false);
  });

  test("CONNECT waits for the whole header, keeps the bytes after it, and refuses anything else", () => {
    expect(parseConnect(Buffer.from("CONNECT example.com:443 HTTP/1.1\r\nHost: exa"))).toBe("incomplete");
    const done = parseConnect(Buffer.from("CONNECT Example.com.:443 HTTP/1.1\r\nHost: x\r\n\r\nHELLO"));
    expect(done).toMatchObject({ target: { host: "example.com", port: 443 } });
    expect(done !== "bad" && done !== "incomplete" && done.rest.toString()).toBe("HELLO");
    expect(parseConnect(Buffer.from("CONNECT [2606:4700::1111]:443 HTTP/1.1\r\n\r\n"))).toMatchObject({ target: { host: "2606:4700::1111", port: 443 } });
    expect(parseConnect(Buffer.from("GET / HTTP/1.1\r\n\r\n"))).toBe("bad");
    expect(parseConnect(Buffer.from("CONNECT example.com:0 HTTP/1.1\r\n\r\n"))).toBe("bad");
    expect(parseConnect(Buffer.from("CONNECT x".padEnd(9000, "x")))).toBe("bad");
  });
});

describe("checkedAddress", () => {
  const allowAll = { allow: () => true };
  test("a target that isn't allowed is refused before any lookup", async () => {
    let looked = false;
    const r = await checkedAddress({ host: "a.example", port: 443 }, { allow: () => false, resolve: async () => ((looked = true), ["8.8.8.8"]) });
    expect(r).toEqual({ refused: "not an allowed host" });
    expect(looked).toBe(false);
  });
  test("every answer must be reachable, so a name with one private answer is refused", async () => {
    expect(await checkedAddress({ host: "a.example", port: 443 }, { ...allowAll, resolve: async () => ["8.8.8.8", "10.0.0.1"] })).toEqual({
      refused: "it resolves to an address that may not be reached",
    });
    expect(await checkedAddress({ host: "a.example", port: 443 }, { ...allowAll, resolve: async () => [] })).toMatchObject({ refused: expect.any(String) });
  });
  test("a name that doesn't resolve is refused", async () => {
    const r = await checkedAddress({ host: "a.example", port: 443 }, { ...allowAll, resolve: async () => Promise.reject(new Error("ENOTFOUND")) });
    expect(r).toEqual({ refused: "the name did not resolve" });
  });
  test("a checked public answer is the address it connects to", async () => {
    expect(await checkedAddress({ host: "a.example", port: 443 }, { ...allowAll, resolve: async () => ["8.8.8.8", "8.8.4.4"] })).toEqual({ address: "8.8.8.8" });
  });
  test("an address literal is checked as itself, and localhost resolves to a refused address", async () => {
    expect(await checkedAddress({ host: "127.0.0.1", port: 443 }, allowAll)).toMatchObject({ refused: expect.any(String) });
    expect(await checkedAddress({ host: "localhost", port: 443 }, allowAll)).toMatchObject({ refused: expect.any(String) });
  });
  test("the default rule refuses this machine's loopback and accepts a public address", () => {
    const ok = defaultAddressRule();
    expect(ok("127.0.0.1")).toBe(false);
    expect(ok("::1")).toBe(false);
    expect(ok("8.8.8.8")).toBe(true);
  });
});

describe("the proxy", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function echo(): Promise<number> {
    const s = createServer((c) => c.pipe(c));
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return (s.address() as { port: number }).port;
  }

  async function proxy(rules: Parameters<typeof startEgressProxy>[1]) {
    const path = join(mkdtempSync(join(tmpdir(), "direx-egress-")), "proxy.sock");
    servers.push(await startEgressProxy(path, rules));
    return path;
  }

  /** Everything the client receives until the proxy closes, or until `want` has arrived. */
  function exchange(path: string, chunks: string[], want?: string): Promise<string> {
    return new Promise((resolve) => {
      let got = "";
      const c = connect(path, async () => {
        for (const chunk of chunks) {
          c.write(chunk);
          await Bun.sleep(20);
        }
      });
      c.on("data", (d) => {
        got += d.toString();
        if (want && got.includes(want)) c.end();
      });
      c.on("close", () => resolve(got));
      c.on("error", () => resolve(got));
    });
  }

  test("a CONNECT split across chunks tunnels, and bytes sent with the header reach the far end", async () => {
    const port = await echo();
    const path = await proxy({ allow: exactTargets([`127.0.0.1:${port}`]), allowAddress: (a) => a === "127.0.0.1" });
    const got = await exchange(path, [`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHo`, "st: x\r\n\r\nHELLO"], "HELLO");
    expect(got).toBe("HTTP/1.1 200 Connection Established\r\n\r\nHELLO");
  });

  test("a refused target gets no answer at all: the connection just closes, and the refusal is logged", async () => {
    const port = await echo();
    const refused: string[] = [];
    const path = await proxy({ allow: exactTargets([`127.0.0.1:${port}`]), onRefused: (t, why) => refused.push(`${t} ${why}`) });
    expect(await exchange(path, [`CONNECT 127.0.0.1:${port} HTTP/1.1\r\n\r\n`])).toBe("");
    expect(await exchange(path, ["CONNECT other.example:443 HTTP/1.1\r\n\r\n"])).toBe("");
    expect(await exchange(path, ["GET / HTTP/1.1\r\n\r\n"])).toBe("");
    expect(refused).toEqual([
      `127.0.0.1:${port} it resolves to an address that may not be reached`,
      "other.example:443 not an allowed host",
      "? not a CONNECT request",
    ]);
  });
});
