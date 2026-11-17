// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from "vitest";
import { migrationsPending } from "./modules/credentials/index";
import { listenHost, refusePendingMigrations, withClientIp } from "./startup";

test("dev and test listen on this machine only, and other environments keep the default", () => {
  expect(listenHost({ NODE_ENV: "development" })).toBe("127.0.0.1");
  expect(listenHost({ NODE_ENV: "test" })).toBe("127.0.0.1");
  expect(listenHost({ NODE_ENV: "production" })).toBeUndefined();
  expect(listenHost({})).toBeUndefined();
});

test("start refuses pending or unknown migrations, and names the command", () => {
  const none = { pending: [], unknown: [], drifted: [] };
  expect(() => refusePendingMigrations(none)).not.toThrow();
  expect(() => refusePendingMigrations({ ...none, drifted: ["0000_roles"] })).not.toThrow();
  expect(() => refusePendingMigrations({ ...none, pending: ["0137_x"] })).toThrow(/1 pending\). Stop Direx, run: bun run db:migrate, then start it/);
  expect(() => refusePendingMigrations({ ...none, unknown: ["1"] })).toThrow(/newer than this code/);
});

test("the app role reads the record of a migrated database and finds nothing pending", async () => {
  expect(await migrationsPending()).toEqual({ pending: [], unknown: [], drifted: [] });
});

test("the address a request came from replaces the one it claims, unless a trusted proxy is named", async () => {
  const echo = (req: Request) => new Response(req.headers.get("x-forwarded-for"));
  const ask = async (proxies: string[], headers: Record<string, string>) => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: withClientIp(echo, proxies) });
    try {
      return await (await fetch(`http://127.0.0.1:${server.port}/`, { headers })).text();
    } finally {
      await server.stop(true);
    }
  };
  expect(await ask([], { "x-forwarded-for": "203.0.113.9" })).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  expect(await ask([], {})).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  expect(await ask(["127.0.0.1"], { "x-forwarded-for": "203.0.113.9" })).toMatch(/^203\.0\.113\.9, (::ffff:)?127\.0\.0\.1$/);
});

test("a request with no socket address carries no forwarded address at all", async () => {
  const req = new Request("http://localhost/", { headers: { "x-forwarded-for": "203.0.113.9" } });
  const res = await withClientIp((r) => new Response(String(r.headers.has("x-forwarded-for"))), [])(req, { requestIP: () => null });
  expect(await res.text()).toBe("false");
});
