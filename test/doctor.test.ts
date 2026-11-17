// SPDX-License-Identifier: AGPL-3.0-only
// Doctor's production checks (ADR 0024, rule 012): mail that connects and logs in, and a Server
// admin. Against this file's database and a fake SMTP server.
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { sandboxStatus } from "../apps/api/src/modules/models/index";
import { checks, pluginSandboxProblem } from "../scripts/doctor";
import { insertAuthUser, ownerClient, withDatabase } from "./db";

let owner: Awaited<ReturnType<typeof ownerClient>>;
const MAIL = "mail server accepts the login";
const ADMIN = "this server has a Server admin";

/** An SMTP server that offers a login and accepts it only when `accept`. */
function fakeSmtp(accept: boolean) {
  return Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open: (s) => void s.write("220 fake\r\n"),
      data: (s, buf) => {
        for (const line of buf.toString().split("\r\n").filter(Boolean)) {
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === "EHLO") s.write("250-fake\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (cmd === "AUTH") s.write(accept ? "235 ok\r\n" : "535 no\r\n");
          else if (cmd === "QUIT") s.end("221 bye\r\n");
          else s.write("250 ok\r\n");
        }
      },
    },
  });
}

// The owner URL names the base database; this file's own is the one in the app URL, as ownerClient reads it.
const thisDatabase = () => ({ ...process.env, DIREX_DB_OWNER_URL: withDatabase(process.env.DIREX_DB_OWNER_URL!, new URL(process.env.DIREX_DB_APP_URL!).pathname.slice(1)) });
const production = (smtpUrl: string | null) => {
  const list = checks({ ...thisDatabase(), NODE_ENV: "production" }, { smtpUrl: async () => smtpUrl });
  return (name: string) => list.find((c) => c.name === name)!;
};

beforeAll(async () => {
  owner = await ownerClient();
});
afterAll(() => owner.end());
beforeEach(async () => {
  await owner.query("delete from system.server_admins");
});

test("mail fails when the SMTP server refuses the login, and passes when it accepts", async () => {
  for (const accept of [false, true]) {
    const server = fakeSmtp(accept);
    try {
      const mail = production(`smtp://direx:secret@127.0.0.1:${server.port}?ignoreTLS=true`)(MAIL);
      expect(await mail.run(), `accept=${accept}`).toBe(accept);
      expect(await mail.fix()).toContain("bun apps/api/src/secrets.ts set smtp.url");
    } finally {
      server.stop(true);
    }
  }
  expect(await production(null)(MAIL).run()).toBe(false);
});

test("a server with no Server admin fails, with the command that fixes it", async () => {
  const admin = production(null)(ADMIN);
  expect(await admin.run()).toBe(false);
  expect(await admin.fix()).toBe("run: bun run server-admin --invite, then open the link it prints and sign in");

  const id = crypto.randomUUID();
  await insertAuthUser(id);
  await owner.query("insert into system.server_admins (user_id) values ($1)", [id]);
  expect(await admin.run()).toBe(true);
});

test("in production the checkout's own Docker and Postgres port aren't checked, and the database URLs may come from the environment", async () => {
  const urls = { DIREX_DB_OWNER_URL: "postgres://o:p@db:5432/direx", DIREX_DB_APP_URL: "postgres://a:p@db:5432/direx" };
  const names = (NODE_ENV?: string) => checks({ ...urls, NODE_ENV }).map((c) => c.name);
  expect(names()).toEqual(expect.arrayContaining(["Docker daemon", "Postgres port"]));
  expect(names("production")).not.toContain("Docker daemon");
  expect(names("production")).not.toContain("Postgres port");
  const fromEnv = (env: Record<string, string>) => checks(env).find((c) => c.name === ".env has both database URLs")!.run();
  expect(await fromEnv({ ...urls, NODE_ENV: "production" })).toBe(true);
  expect(await fromEnv({ NODE_ENV: "production" })).toBe(false);
});

test("outside production, neither check runs", () => {
  for (const NODE_ENV of [undefined, "development", "test"]) {
    const names = checks({ ...process.env, NODE_ENV }).map((c) => c.name);
    expect(names).not.toContain(MAIL);
    expect(names).not.toContain(ADMIN);
  }
});

test("with no plugin installed there is nothing to confine; with one, the report is the sandbox's own (ADR 0026 rule 009)", async () => {
  const url = thisDatabase().DIREX_DB_OWNER_URL!;
  const clear = async () => {
    await owner.query("delete from system.plugin_installs");
    await owner.query("delete from system.plugin_install_events");
  };
  await clear();
  expect(await pluginSandboxProblem(url)).toBeNull();
  await owner.query("select system.cli_install_plugin('install', 'com.example.doctor', '1.0.0', $1, $2, $3)", [{ id: "com.example.doctor", version: "1.0.0" }, "a".repeat(64), "1".repeat(64)]);
  try {
    const status = await sandboxStatus();
    expect(await pluginSandboxProblem(url)).toBe(status.ok ? null : `1 installed plugin won't start: ${status.reason}`);
    const check = checks(thisDatabase()).find((c) => c.name === "installed plugins can run in the sandbox")!;
    expect(await check.run()).toBe(status.ok);
  } finally {
    await clear();
  }
});
