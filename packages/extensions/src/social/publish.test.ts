// SPDX-License-Identifier: AGPL-3.0-only
// Publishing on each network against a local server. Every response here is written from the network's
// docs (or, where they are silent, the shape the plugin must survive) until real posts replace them.
import { type Plugin } from "@direx/plugin-sdk";
import { invoke } from "../test-wire";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { socialNetworks, socialProviders } from "../index";
import { createBlueskyPlugin, linkFacets, rkeyFor } from "./bluesky/plugin";
import { createFacebookPlugin } from "./facebook/plugin";
import { LINKEDIN_VERSION, LINKEDIN_VERSION_SUNSET, createLinkedInPlugin, littleText } from "./linkedin/plugin";
import { findLinks, removeLinks } from "./post";
import { createThreadsPlugin } from "./threads/plugin";
import { createXPlugin, xCount } from "./x/plugin";

type Seen = { method: string; path: string; headers: Headers; body: string };
const seen: Seen[] = [];
let answer: (s: Seen) => Response;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const u = new URL(req.url);
    const s = { method: req.method, path: u.pathname + u.search, headers: req.headers, body: await req.text() };
    seen.push(s);
    return answer(s);
  },
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen.length = 0;
});

const o = { baseUrl: `http://localhost:${server.port}`, timeoutMs: 1000 };
const dead = { baseUrl: "http://localhost:1", timeoutMs: 1000 };
/** A real drop: a handler that throws would only make Bun answer 500. */
const dropping = (path: string) => ({ ...o, fetch: ((url: string, init: RequestInit) => (String(url).includes(path) ? Promise.reject(new TypeError("connection dropped")) : fetch(url, init))) as unknown as typeof fetch });
const token = { accessToken: "SECRET-TOKEN", expiresAt: "2030-01-01T00:00:00.000Z" };
const app = { username: "ana.bsky.social", password: "abcd-efgh-ijkl-mnop" };
const ctx = { workspaceId: "w", log: () => undefined };
const KEY = "action-1";

const prepare = (p: Plugin, input: Partial<{ text: string; followUps: string[]; target: string | null; links: boolean }>) => invoke(p, "prepare", { capability: "social.publish", input: { text: "hi", followUps: [], target: "me", links: true, ...input } }, ctx) as Promise<{ spec: { text: string; followUps: string[] }; count?: { used: number; limit: number } }>;
const spec = (over: object = {}) => ({ text: "hello", followUps: [] as string[], target: "me", ...over });
type Result = { kind: string; retryable?: boolean; permanent?: boolean; credentialRejected?: boolean; detail?: string; providerRef?: string; url?: string; followUps?: { status: string; detail?: string; url?: string }[] };
const execute = (p: Plugin, s: unknown = spec(), credential: unknown = token) => invoke(p, "execute", { capability: "social.publish", spec: s, idempotencyKey: KEY, credential }, ctx) as Promise<Result>;
const form = (s: Seen) => Object.fromEntries(new URLSearchParams(s.body));
const held = { kind: "refused", permanent: false, retryable: false };
const retry = { kind: "refused", permanent: false, retryable: true };
const rejected = { ...retry, credentialRejected: true };
// A throttle or a spam block also tells the host to pause the account.
const limited = { ...retry, providerLimit: "sending_limit" };
const blocked = { ...held, providerLimit: "abuse" };

describe("what counts as a link", () => {
  test.each([["see https://a.com/x now", "see now"], ["see example.com/path, ok", "see, ok"], ["(https://a.com)", ""], ["go to www.a.co.uk.", "go to."], ["two\n\n\nhttps://a.com\n\n\nlines", "two\n\nlines"]])("removes from %j", (from, to) => {
    expect(removeLinks(from)).toBe(to);
  });
  test.each(["e.g. this", "i.e. that", "v1.2 is out", "3.14 pies", "ana@example.com", "@ana.bsky.social", "wait...what", "at 10.30am", "U.S. news", "double  spaced"])("leaves %j alone", (text) => {
    expect(removeLinks(text)).toBe(text);
  });
  test("a closing bracket or full stop isn't part of the URL, a balanced bracket is", () => {
    expect(findLinks("(https://a.com/b). And https://a.com/c_(d)").map((l) => l.url)).toEqual(["https://a.com/b", "https://a.com/c_(d)"]);
  });
  test("removal covers follow-ups, and a post of only a link is refused rather than empty", async () => {
    const p = createBlueskyPlugin(o);
    const r = await prepare(p, { text: "read a.com now", followUps: ["more at https://b.com", "https://c.com"], links: false });
    expect(r.spec).toEqual({ text: "read now", followUps: ["more at"], target: "me" });
    await expect(prepare(p, { text: "https://a.com", links: false })).rejects.toThrow(/empty/);
  });
});

describe("Bluesky", () => {
  const p = createBlueskyPlugin(o);
  const session = () => Response.json({ did: "did:plc:1", handle: "ana.bsky.social", accessJwt: "JWT", refreshJwt: "r" });
  const creates = () => seen.filter((s) => s.path.endsWith("createRecord")).map((s) => JSON.parse(s.body));
  let n = 0;
  const created = () => {
    n++;
    return Response.json({ uri: `at://did:plc:1/app.bsky.feed.post/r${n}`, cid: `c${n}` });
  };
  /** Sign-in works; createRecord answers as given. */
  const on = (create: (i: number) => Response) => {
    let i = 0;
    answer = (s) => (s.path.endsWith("createSession") ? session() : create(i++));
  };

  test("publishes on a valid, derived rkey with a fresh createdAt, and links to the post", async () => {
    on(created);
    const before = Date.now();
    const r = await execute(p, spec(), app);
    const [c] = creates();
    expect(seen[1]!.headers.get("authorization")).toBe("Bearer JWT");
    expect(c).toMatchObject({ repo: "did:plc:1", collection: "app.bsky.feed.post", rkey: rkeyFor(KEY), record: { $type: "app.bsky.feed.post", text: "hello" } });
    expect(Date.parse(c.record.createdAt)).toBeGreaterThanOrEqual(before);
    expect(c.record.facets).toBeUndefined();
    expect(r).toMatchObject({ kind: "sent", url: `https://bsky.app/profile/did:plc:1/post/${rkeyFor(KEY)}` });
    expect(r.followUps).toBeUndefined();
  });

  test("the rkey is a TID: 13 characters, top bit zero, stable, within the year before the fixed date", () => {
    const k = rkeyFor(KEY);
    expect(k).toMatch(/^[234567abcdefghij][234567a-z]{12}$/);
    expect(rkeyFor(KEY)).toBe(k);
    expect(rkeyFor("action-2")).not.toBe(k);
    expect(rkeyFor(KEY, 0)).not.toBe(k);
    const value = [...k].reduce((v, ch) => (v << 5n) | BigInt("234567abcdefghijklmnopqrstuvwxyz".indexOf(ch)), 0n);
    const ms = Number((value >> 10n) / 1000n);
    expect(ms).toBeLessThanOrEqual(Date.UTC(2026, 9, 1));
    expect(ms).toBeGreaterThan(Date.UTC(2025, 9, 1));
  });

  test("a resend uses the same rkey", async () => {
    on(() => new Response(null, { status: 500 }));
    await expect(execute(p, spec(), app)).rejects.toThrow();
    on(created);
    await execute(p, spec(), app);
    expect(new Set(creates().map((c) => c.rkey)).size).toBe(1);
  });

  test("facets count UTF-8 bytes, past a non-ASCII character", async () => {
    const text = "héllo 👋 https://a.com/é.";
    expect(linkFacets(text)).toEqual([{ index: { byteStart: 12, byteEnd: 28 }, features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://a.com/é" }] }]);
    expect(linkFacets("bare a.com has no scheme")).toEqual([]);
    on(created);
    await execute(p, spec({ text }), app);
    expect(creates()[0].record.facets).toHaveLength(1);
  });

  test("limit: 300 graphemes passes, 301 doesn't, and bytes are checked too", async () => {
    expect((await prepare(p, { text: "👨‍👩‍👧‍👦".repeat(100) + "a".repeat(200) })).count).toEqual({ used: 300, limit: 300 });
    await expect(prepare(p, { text: "a".repeat(301) })).rejects.toThrow("301 of 300 characters");
    await expect(prepare(p, { text: "a̐".repeat(100) + "👨‍👩‍👧‍👦".repeat(120) })).rejects.toThrow(/of 3000 bytes/);
    await expect(prepare(p, { followUps: ["a".repeat(301)] })).rejects.toThrow("follow-up 1: 301 of 300 characters");
  });

  test.each([
    [400, { error: "InvalidRequest" }, held],
    [400, { error: "InvalidSwap" }, held],
    [429, { error: "RateLimitExceeded" }, limited],
    [401, { error: "InvalidToken" }, rejected],
  ])("create answering %i %j is refused", async (status, body, want) => {
    on(() => Response.json(body, { status }));
    expect(await execute(p, spec(), app)).toMatchObject(want);
  });

  test.each([[500, {}], [503, {}], [401, { error: "ExpiredToken" }], [404, {}]])("create answering %i %j is unknown", async (status, body) => {
    on(() => Response.json(body, { status }));
    await expect(execute(p, spec(), app)).rejects.toThrow();
  });

  test("a dropped connection is unknown only once it reaches create; before that nothing can have posted", async () => {
    expect(await execute(createBlueskyPlugin(dead), spec(), app)).toMatchObject(retry);
    answer = session;
    await expect(execute(createBlueskyPlugin(dropping("createRecord")), spec(), app)).rejects.toThrow("connection dropped");
  });

  test("sign-in: wrong password needs a reconnect, a rate limit and an outage retry, no credential holds", async () => {
    answer = () => new Response(null, { status: 401 });
    expect(await execute(p, spec(), app)).toMatchObject(rejected);
    answer = () => new Response(null, { status: 429 });
    expect(await execute(p, spec(), app)).toMatchObject(retry);
    answer = () => new Response(null, { status: 503 });
    expect(await execute(p, spec(), app)).toMatchObject(retry);
    expect(await execute(p, spec(), null)).toMatchObject(held);
    seen.length = 0;
    expect(await execute(p, spec(), { ...app, password: "my main password" })).toMatchObject(rejected);
    expect(seen).toHaveLength(0);
  });

  test("follow-ups thread as replies, each on its own rkey", async () => {
    on(created);
    const r = await execute(p, spec({ followUps: ["one", "two"] }), app);
    const [post, one, two] = creates();
    expect(post.record.reply).toBeUndefined();
    expect(one.rkey).toBe(rkeyFor(KEY, 0));
    expect(two.rkey).toBe(rkeyFor(KEY, 1));
    const root = { uri: expect.stringContaining("at://"), cid: expect.any(String) };
    expect(one.record.reply).toEqual({ root, parent: root });
    expect(two.record.reply.parent.cid).not.toBe(two.record.reply.root.cid);
    expect(r.followUps!.map((f) => f.status)).toEqual(["posted", "posted"]);
    expect(r.followUps![1]!.url).toContain(rkeyFor(KEY, 1));
  });

  test("a refused follow-up fails and stops the next; a 5xx is uncertain and stops the next; the post stays sent", async () => {
    on((i) => (i === 0 ? created() : Response.json({ error: "InvalidRequest" }, { status: 400 })));
    let r = await execute(p, spec({ followUps: ["one", "two"] }), app);
    expect(r.kind).toBe("sent");
    expect(r.followUps!.map((f) => f.status)).toEqual(["failed", "failed"]);
    expect(r.followUps![1]!.detail).toMatch(/follow-up 1/);
    seen.length = 0;
    on((i) => (i === 0 ? created() : new Response(null, { status: 500 })));
    r = await execute(p, spec({ followUps: ["one", "two"] }), app);
    expect(r.followUps!.map((f) => f.status)).toEqual(["uncertain", "failed"]);
    expect(r.followUps![0]!.detail).toMatch(/may have posted/);
    expect(creates()).toHaveLength(2);
  });

  const reconcile = (credential: unknown = app) => invoke(p, "reconcile", { capability: "social.publish", correlationKey: KEY, idempotencyKey: KEY, credential }, ctx);
  test("reconcile: found is sent, RecordNotFound is not sent, anything else is unknown", async () => {
    const rkey = rkeyFor(KEY);
    answer = (s) => (s.path.endsWith("createSession") ? session() : Response.json({ uri: `at://did:plc:1/app.bsky.feed.post/${rkey}`, cid: "c", value: {} }));
    expect(await reconcile()).toEqual({ kind: "sent", providerRef: `at://did:plc:1/app.bsky.feed.post/${rkey}`, url: `https://bsky.app/profile/did:plc:1/post/${rkey}` });
    expect(seen[1]!.path).toBe(`/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3A1&collection=app.bsky.feed.post&rkey=${rkey}`);
    answer = (s) => (s.path.endsWith("createSession") ? session() : Response.json({ error: "RecordNotFound" }, { status: 400 }));
    expect(await reconcile()).toEqual({ kind: "not_sent" });
    answer = (s) => (s.path.endsWith("createSession") ? session() : new Response(null, { status: 500 }));
    expect(await reconcile()).toEqual({ kind: "unknown" });
    answer = () => new Response(null, { status: 401 });
    expect(await reconcile()).toEqual({ kind: "unknown" });
    expect(await reconcile(null)).toEqual({ kind: "unknown" });
  });
});

describe("LinkedIn", () => {
  const p = createLinkedInPlugin(o);
  const ok = () => new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:9" } });

  test("posts as the member, with the headers, escaped text and the URN from the header", async () => {
    answer = ok;
    const r = await execute(p, spec({ text: "a_b #1 (ok)" }));
    const s = seen[0]!;
    expect(s.path).toBe("/rest/posts");
    expect(s.headers.get("authorization")).toBe("Bearer SECRET-TOKEN");
    expect(s.headers.get("linkedin-version")).toBe(LINKEDIN_VERSION);
    expect(s.headers.get("x-restli-protocol-version")).toBe("2.0.0");
    expect(JSON.parse(s.body)).toEqual({
      author: "urn:li:person:me",
      commentary: "a\\_b \\#1 \\(ok\\)",
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
    expect(r).toEqual({ kind: "sent", providerRef: "urn:li:share:9", url: "https://www.linkedin.com/feed/update/urn:li:share:9/" });
  });

  test("every one of the 15 reserved characters is escaped, and others aren't", () => {
    const reserved = "|{}@[]()<>#\\*_~";
    expect(reserved).toHaveLength(15);
    expect(littleText(reserved)).toBe([...reserved].map((c) => `\\${c}`).join(""));
    expect(littleText("plain, text. ok!")).toBe("plain, text. ok!");
  });

  test("the pinned version is at least 60 days from its sunset. Bump it when this fails", () => {
    expect(LINKEDIN_VERSION).toMatch(/^\d{6}$/);
    expect(Date.parse(LINKEDIN_VERSION_SUNSET) - Date.now()).toBeGreaterThan(60 * 24 * 60 * 60_000);
  });

  test("limit, in code points", async () => {
    expect((await prepare(p, { text: "a".repeat(3000) })).count).toEqual({ used: 3000, limit: 3000 });
    await expect(prepare(p, { text: "a".repeat(3001) })).rejects.toThrow("3001 of 3000 characters");
    await expect(prepare(p, { target: null })).rejects.toThrow(/account/);
    await expect(prepare(p, { followUps: ["more"] })).rejects.toThrow(/no follow-ups/);
  });

  test.each([[400, held], [422, held], [426, held], [401, rejected], [403, rejected], [409, retry], [429, limited]])("%i is refused", async (status, want) => {
    answer = () => new Response(null, { status });
    expect(await execute(p)).toMatchObject(want);
  });

  test.each([500, 503, 504, 404])("%i is unknown", async (status) => {
    answer = () => new Response(null, { status });
    await expect(execute(p)).rejects.toThrow();
  });

  test("a drop, or a success with no id, is unknown; no credential is refused", async () => {
    await expect(execute(createLinkedInPlugin(dead))).rejects.toThrow();
    answer = () => new Response(null, { status: 201 });
    await expect(execute(p)).rejects.toThrow();
    expect(await execute(p, spec(), null)).toMatchObject(held);
  });
});

describe("X", () => {
  const p = createXPlugin(o);

  test("posts the text and reads nothing back", async () => {
    answer = () => Response.json({ data: { id: "42", text: "hello", edit_history_post_ids: ["42"] } }, { status: 201 });
    expect(await execute(p)).toEqual({ kind: "sent", providerRef: "42", url: "https://x.com/i/status/42" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/2/tweets");
    expect(JSON.parse(seen[0]!.body)).toEqual({ text: "hello" });
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer SECRET-TOKEN");
  });

  test("weights: Latin and punctuation 1, CJK 2, any emoji sequence 2, any URL 23, after NFC", () => {
    expect(xCount("Hi, there! \u2014 ok")).toBe(15);
    expect(xCount("日本")).toBe(4);
    expect(xCount("👾")).toBe(2);
    expect(xCount("👨‍👩‍👧‍👦")).toBe(2);
    expect(xCount("🇩🇪")).toBe(2);
    expect(xCount("é")).toBe(1);
    expect(xCount(`https://example.com/${"a".repeat(100)}`)).toBe(23);
    expect(xCount("see example.com ok")).toBe(4 + 23 + 3);
    expect(xCount("e.g. v1.2")).toBe(9);
  });

  test("limit: exactly 280 passes, 281 is refused with the count", async () => {
    expect((await prepare(p, { text: "a".repeat(280) })).count).toEqual({ used: 280, limit: 280 });
    expect((await prepare(p, { text: `https://a.com/long ${"a".repeat(256)}` })).count).toEqual({ used: 280, limit: 280 });
    await expect(prepare(p, { text: "a".repeat(281) })).rejects.toThrow("281 of 280 characters");
    await expect(prepare(p, { text: "日".repeat(141) })).rejects.toThrow("282 of 280 characters");
  });

  test("links go on Direx's app, stay on the Workspace's own, and near misses stay either way", async () => {
    expect((await prepare(p, { text: "read example.com, e.g. v1.2 https://a.com", links: false })).spec.text).toBe("read, e.g. v1.2");
    expect((await prepare(p, { text: "read example.com", links: true })).spec.text).toBe("read example.com");
    expect((await prepare(p, { text: "e.g. v1.2", links: false })).spec.text).toBe("e.g. v1.2");
    await expect(prepare(p, { followUps: ["more"] })).rejects.toThrow(/no follow-ups/);
  });

  test.each([
    [400, { title: "Invalid Request", type: "https://api.x.com/2/problems/invalid-request" }, held],
    [401, { title: "Unauthorized" }, rejected],
    [403, { title: "Forbidden", type: "https://api.x.com/2/problems/client-forbidden" }, held],
    [429, { title: "Too Many Requests", type: "https://api.x.com/2/problems/rate-limit-exceeded" }, limited],
    [429, { title: "Usage cap", type: "https://api.x.com/2/problems/usage-capped" }, held],
  ])("%i %j is refused", async (status, body, want) => {
    answer = () => Response.json(body, { status });
    expect(await execute(p)).toMatchObject(want);
  });

  test.each([500, 502, 503, 504, 402])("%i is unknown", async (status) => {
    answer = () => new Response(null, { status });
    await expect(execute(p)).rejects.toThrow();
  });

  test("a drop, or a 201 with only errors, is unknown; no credential is refused; no token in a detail", async () => {
    await expect(execute(createXPlugin(dead))).rejects.toThrow();
    answer = () => Response.json({ errors: [{ title: "partial" }] }, { status: 201 });
    await expect(execute(p)).rejects.toThrow();
    expect(await execute(p, spec(), null)).toMatchObject(held);
    answer = () => Response.json({ detail: "SECRET-TOKEN" }, { status: 400 });
    expect(JSON.stringify(await execute(p))).not.toContain("SECRET-TOKEN");
  });
});

describe("Facebook", () => {
  const p = createFacebookPlugin(o);
  const pages = () => Response.json({ data: [{ id: "me", access_token: "PAGE-TOKEN" }, { id: "other", access_token: "OTHER" }] });
  /** Page tokens work; everything else answers as given. */
  const on = (rest: (s: Seen) => Response) => {
    answer = (s) => (s.path.startsWith("/me/accounts") ? pages() : rest(s));
  };
  const happy = (s: Seen) => (s.method === "GET" ? Response.json({ permalink_url: "https://www.facebook.com/me/posts/1" }) : s.path.endsWith("/feed") ? Response.json({ id: "me_1" }) : Response.json({ id: "c1" }));

  test("posts with the Page's token, fetched at call time, then reads the permalink", async () => {
    on(happy);
    const r = await execute(p);
    const [accounts, post, read] = seen;
    expect(accounts!.headers.get("authorization")).toBe("Bearer SECRET-TOKEN");
    expect(post!.path).toBe("/me/feed");
    expect(post!.headers.get("authorization")).toBe("Bearer PAGE-TOKEN");
    expect(form(post!)).toEqual({ message: "hello" });
    expect(read!.path).toBe("/me_1?fields=permalink_url");
    expect(r).toEqual({ kind: "sent", providerRef: "me_1", url: "https://www.facebook.com/me/posts/1" });
    expect(JSON.stringify(r)).not.toContain("PAGE-TOKEN");
  });

  test("a failed permalink read still ends sent, with no url", async () => {
    on((s) => (s.method === "GET" ? new Response(null, { status: 500 }) : Response.json({ id: "me_1" })));
    expect(await execute(p)).toEqual({ kind: "sent", providerRef: "me_1" });
  });

  test("no client limit: no count, and a very long text passes to the network", async () => {
    const r = await prepare(p, { text: "a".repeat(100_000) });
    expect(r.count).toBeUndefined();
    await expect(prepare(p, { target: null })).rejects.toThrow(/account/);
  });

  // The HTTP status varies on purpose: Meta states none, so the code alone decides.
  test.each([
    [100, undefined, held],
    [506, undefined, held],
    [1609005, undefined, held],
    [368, undefined, blocked],
    [190, undefined, rejected],
    [102, undefined, rejected],
    [190, 460, rejected],
    [999, 459, rejected],
    [492, undefined, rejected],
    [10, undefined, rejected],
    [200, undefined, rejected],
    [299, undefined, rejected],
    [3, undefined, rejected],
    [4, undefined, limited],
    [17, undefined, limited],
    [32, undefined, limited],
    [341, undefined, limited],
    [613, undefined, limited],
    [80001, undefined, limited],
  ])("code %i, subcode %s, is refused at any status", async (code, error_subcode, want) => {
    for (const status of [200, 400, 403]) {
      on(() => Response.json({ error: { code, error_subcode, message: "SECRET-TOKEN" } }, { status }));
      const r = await execute(p);
      expect(r).toMatchObject(want);
      expect(JSON.stringify(r)).not.toContain("SECRET-TOKEN");
    }
  });

  test.each([[1, 400], [2, 400], [999, 400], [190, 500]])("code %i with status %i is unknown", async (code, status) => {
    on(() => Response.json({ error: { code } }, { status }));
    await expect(execute(p)).rejects.toThrow();
  });

  test("before the post nothing is unknown: a dead login, throttling, an outage, a lost Page", async () => {
    answer = () => Response.json({ error: { code: 190 } }, { status: 400 });
    expect(await execute(p)).toMatchObject(rejected);
    answer = () => Response.json({ error: { code: 4 } }, { status: 403 });
    expect(await execute(p)).toMatchObject(limited);
    answer = () => new Response(null, { status: 500 });
    expect(await execute(p)).toMatchObject(retry);
    expect(await execute(createFacebookPlugin(dead))).toMatchObject(retry);
    on(happy);
    expect(await execute(p, spec({ target: "gone" }))).toMatchObject(held);
    expect(await execute(p, spec(), null)).toMatchObject(held);
  });

  test("a drop on the post itself is unknown", async () => {
    on(happy);
    await expect(execute(createFacebookPlugin(dropping("/feed")))).rejects.toThrow("connection dropped");
  });

  test("follow-ups are comments; a refusal fails, a drop is uncertain, and neither fails the post", async () => {
    on(happy);
    let r = await execute(p, spec({ followUps: ["one"] }));
    const comment = seen.find((s) => s.path.endsWith("/comments"))!;
    expect(comment.path).toBe("/me_1/comments");
    expect(form(comment)).toEqual({ message: "one" });
    expect(r.followUps).toEqual([{ status: "posted" }]);
    on((s) => (s.path.endsWith("/comments") ? Response.json({ error: { code: 368 } }) : happy(s)));
    r = await execute(p, spec({ followUps: ["one", "two"] }));
    expect(r.kind).toBe("sent");
    expect(r.followUps!.map((f) => f.status)).toEqual(["failed", "failed"]);
    on((s) => (s.path.endsWith("/comments") ? new Response(null, { status: 503 }) : happy(s)));
    r = await execute(p, spec({ followUps: ["one", "two"] }));
    expect(r.followUps!.map((f) => f.status)).toEqual(["uncertain", "failed"]);
    on(happy);
    r = await execute(createFacebookPlugin(dropping("/comments")), spec({ followUps: ["one"] }));
    expect(r).toMatchObject({ kind: "sent", followUps: [{ status: "uncertain" }] });
  });
});

describe("Threads", () => {
  const waits: number[] = [];
  let clock = 0;
  const options = { ...o, now: () => clock, wait: async (ms: number) => void waits.push(ms) };
  const p = createThreadsPlugin(options);
  beforeEach(() => {
    waits.length = 0;
    clock = 0;
  });
  const happy = (s: Seen) => {
    if (s.method === "GET") return Response.json(s.path.includes("fields=status") ? { status: "FINISHED", id: "c1" } : { permalink: "https://www.threads.com/@ana/post/abc" });
    return Response.json({ id: s.path.endsWith("/threads") ? "c1" : "m1" });
  };
  const publishes = () => seen.filter((s) => s.path.endsWith("/threads_publish"));

  test("two steps with the wait between, never auto_publish_text, then the permalink", async () => {
    answer = happy;
    const r = await execute(p);
    const [step1, status, step2, read] = seen;
    expect(step1!.path).toBe("/v1.0/me/threads");
    expect(form(step1!)).toEqual({ media_type: "TEXT", text: "hello", access_token: "SECRET-TOKEN" });
    expect(status!.path).toBe("/c1?fields=status,error_message");
    expect(step2!.path).toBe("/v1.0/me/threads_publish");
    expect(form(step2!)).toEqual({ creation_id: "c1", access_token: "SECRET-TOKEN" });
    expect(read!.path).toBe("/m1?fields=permalink");
    expect(waits).toEqual([30_000]);
    expect(seen.some((s) => s.body.includes("auto_publish_text"))).toBe(false);
    expect(r).toEqual({ kind: "sent", providerRef: "m1", url: "https://www.threads.com/@ana/post/abc" });
  });

  test("the manifest declares the longer timeout, and blind", () => {
    expect(p.manifest.capabilities.find((c) => c.name === "social.publish")).toMatchObject({ dedupe: "blind", timeoutMs: 300_000, risk: "medium", reachesPerson: false, media: "read" });
  });

  test("a failed permalink read still ends sent, with no url", async () => {
    answer = (s) => (s.path.includes("fields=permalink") ? new Response(null, { status: 500 }) : happy(s));
    expect(await execute(p)).toEqual({ kind: "sent", providerRef: "m1" });
  });

  test("limit: emoji count as bytes, 500 passes, 501 doesn't; six links and four follow-ups are refused", async () => {
    expect((await prepare(p, { text: "a".repeat(496) + "👾" })).count).toEqual({ used: 500, limit: 500 });
    await expect(prepare(p, { text: "a".repeat(497) + "👾" })).rejects.toThrow("501 of 500 characters");
    const links = (n: number) => Array.from({ length: n }, (_, i) => `https://a.com/${i}`).join(" ");
    expect(await prepare(p, { text: `${links(5)} https://a.com/0` })).toBeTruthy();
    await expect(prepare(p, { text: links(6) })).rejects.toThrow("6 of 5 links");
    await expect(prepare(p, { followUps: ["1", "2", "3", "4"] })).rejects.toThrow("4 of 3 follow-ups");
    expect(await prepare(p, { followUps: ["1", "2", "3"] })).toBeTruthy();
  });

  test.each([
    [400, { error: { message: "THREADS_API__LINK_LIMIT_EXCEEDED" } }, held],
    [400, { error: { code: 100 } }, held],
    [401, {}, rejected],
    [400, { error: { code: 190 } }, rejected],
    [429, {}, limited],
    [403, { error: { code: 4 } }, limited],
    [500, {}, retry],
  ])("step 1 answering %i %j is refused, never unknown", async (status, body, want) => {
    answer = () => Response.json(body, { status });
    expect(await execute(p)).toMatchObject(want);
    expect(waits).toEqual([]);
  });

  test("a drop on step 1 is refused, since no post can exist yet", async () => {
    expect(await execute(createThreadsPlugin({ ...options, ...dead }))).toMatchObject(retry);
  });

  test.each([["ERROR", held], ["EXPIRED", retry]])("a container in %s doesn't reach step 2", async (status, want) => {
    answer = (s) => (s.path.includes("fields=status") ? Response.json({ status, error_message: "UNKNOWN" }) : happy(s));
    expect(await execute(p)).toMatchObject(want);
    expect(publishes()).toHaveLength(0);
  });

  test("a failed status read goes on to step 2", async () => {
    answer = (s) => (s.path.includes("fields=status") ? new Response(null, { status: 500 }) : happy(s));
    expect(await execute(p)).toMatchObject({ kind: "sent" });
  });

  test.each([[401, {}, rejected], [400, { error: { code: 190 } }, rejected], [429, {}, limited]])("step 2 answering %i %j is refused", async (status, body, want) => {
    answer = (s) => (s.path.endsWith("/threads_publish") ? Response.json(body, { status }) : happy(s));
    expect(await execute(p)).toMatchObject(want);
  });

  test.each([[500, {}], [400, { error: { code: 100 } }], [200, {}]])("step 2 answering %i %j is unknown", async (status, body) => {
    answer = (s) => (s.path.endsWith("/threads_publish") ? Response.json(body, { status }) : happy(s));
    await expect(execute(p)).rejects.toThrow();
  });

  test("a drop on step 2 is unknown; no credential is refused", async () => {
    answer = happy;
    await expect(execute(createThreadsPlugin({ ...options, ...dropping("/threads_publish") }))).rejects.toThrow("connection dropped");
    expect(await execute(p, spec(), null)).toMatchObject(held);
  });

  test("follow-ups chain with reply_to_id and their own wait", async () => {
    let n = 0;
    answer = (s) => (s.path.endsWith("/threads_publish") ? Response.json({ id: `m${++n}` }) : happy(s));
    const r = await execute(p, spec({ followUps: ["one", "two"] }));
    const steps = seen.filter((s) => s.path.endsWith("/threads")).map(form);
    expect(steps[1]!.reply_to_id).toBe("m1");
    expect(steps[2]!.reply_to_id).toBe("m2");
    expect(waits).toHaveLength(3);
    expect(r.followUps!.map((f) => f.status)).toEqual(["posted", "posted"]);
  });

  test("a follow-up's step 1 failing is failed even on a 5xx; its step 2 dropping is uncertain; the post stays sent", async () => {
    let posted = false;
    answer = (s) => {
      if (s.path.endsWith("/threads") && posted) return new Response(null, { status: 500 });
      if (s.path.endsWith("/threads_publish")) posted = true;
      return happy(s);
    };
    let r = await execute(p, spec({ followUps: ["one", "two"] }));
    expect(r.kind).toBe("sent");
    expect(r.followUps!.map((f) => f.status)).toEqual(["failed", "failed"]);
    let publishCount = 0;
    answer = (s) => (s.path.endsWith("/threads_publish") && ++publishCount > 1 ? new Response(null, { status: 500 }) : happy(s));
    r = await execute(p, spec({ followUps: ["one", "two"] }));
    expect(r.followUps!.map((f) => f.status)).toEqual(["uncertain", "failed"]);
  });

  test("a follow-up that might not finish inside the timeout isn't started", async () => {
    answer = happy;
    const slow = createThreadsPlugin({ ...options, wait: async () => void (clock += 230_000) });
    const r = await execute(slow, spec({ followUps: ["one", "two"] }));
    expect(r.kind).toBe("sent");
    expect(r.followUps!.map((f) => f.status)).toEqual(["failed", "failed"]);
    expect(r.followUps![0]!.detail).toMatch(/time/);
    expect(publishes()).toHaveLength(1);
  });
});

describe("what each network declares", () => {
  const net = (c: string) => socialNetworks().find((n) => n.connection === c)!;
  const feature = (c: string, key: string) => net(c).features.find((f) => f.key === key);

  test("publish and links are built on the five networks, Instagram and LinkedIn Pages stay out, and nothing shows as live", () => {
    for (const c of ["linkedin", "x", "bluesky", "facebook", "threads"]) {
      expect(feature(c, "publish")?.built).toBe(true);
      expect(feature(c, "links")?.built).toBe(true);
      expect(net(c).availability).toEqual({ cloud: "awaiting_approval", self_host: "awaiting_approval" });
    }
    expect(feature("instagram", "publish")?.built).toBe(false);
    expect(feature("linkedin_page", "publish")?.built).toBe(false);
  });

  test("follow-ups are built only where allowed", () => {
    for (const c of ["bluesky", "facebook", "threads"]) expect(feature(c, "follow_ups")?.built).toBe(true);
    for (const c of ["linkedin", "x"]) expect(feature(c, "follow_ups")).toBeUndefined();
  });

  test("X: posts need no media scope, links need the Workspace's own app, and its limits are declared", () => {
    expect(feature("x", "publish")?.scopes).toEqual(["tweet.write"]);
    expect(feature("x", "links")?.needsOwnApp).toBe(true);
    expect(net("x")).toMatchObject({ monthlyPostLimit: 500, noIdenticalAcrossAccounts: true });
  });

  test("each provider asks for the posting scopes without requiring them, so a partial grant offers a reconnect", () => {
    const want: Record<string, string[]> = {
      linkedin: ["w_member_social"],
      x: ["tweet.write"],
      facebook: ["pages_manage_posts", "pages_read_engagement", "pages_manage_engagement"],
      threads: ["threads_content_publish", "threads_manage_replies"],
    };
    for (const [c, scopes] of Object.entries(want)) {
      const provider = socialProviders().find((x) => x.connection === c)!;
      expect(provider.scopes).toEqual(expect.arrayContaining(scopes));
      for (const s of scopes) expect(provider.requiredScopes).not.toContain(s);
    }
    expect(net("bluesky").features.every((f) => f.scopes.length === 0)).toBe(true);
  });
});
