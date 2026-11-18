// SPDX-License-Identifier: AGPL-3.0-only
// Doctor's production checks (ADR 0024, rule 012): mail that connects and logs in, a Server admin, a
// worker that sweeps and a recent backup. Against this file's database and a fake SMTP server.
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { sandboxStatus } from "../apps/api/src/modules/models/index";
import { backupProblem, checks, lastLedgerSweep, pluginSandboxProblem, workerAlive } from "../scripts/doctor";
import { insertAuthUser, ownerClient, withDatabase } from "./db";

let owner: Awaited<ReturnType<typeof ownerClient>>;
const MAIL = "mail server accepts the login";
const ADMIN = "this server has a Server admin";
const WORKER = "worker ran its ledger sweep in the last 10 minutes";
const BACKUP = "last backup under 26 hours old";

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

test("outside production, none of these checks runs", () => {
  for (const NODE_ENV of [undefined, "development", "test"]) {
    const names = checks({ ...process.env, NODE_ENV }).map((c) => c.name);
    for (const name of [MAIL, ADMIN, WORKER, BACKUP]) expect(names).not.toContain(name);
  }
});

test("the worker's heartbeat is the last completed ledger sweep", async () => {
  const url = thisDatabase().DIREX_DB_OWNER_URL!;
  if (!(await owner.query("select 1 from pgboss.queue where name = 'ledger.sweep'")).rowCount) await owner.query("select pgboss.create_queue('ledger.sweep', $1)", [{ policy: "standard" }]);
  await owner.query("delete from pgboss.job where name = 'ledger.sweep'");
  expect(await lastLedgerSweep(url)).toBeNull();
  await owner.query("insert into pgboss.job (name, state, completed_on) values ('ledger.sweep', 'created', null), ('ledger.sweep', 'completed', now() - interval '3 minutes')");
  const at = await lastLedgerSweep(url);
  expect(Date.now() - at!.getTime()).toBeGreaterThan(170_000);
  expect(await workerAlive(() => lastLedgerSweep(url), { patienceMs: 0 })).toBe(true);
});

const NOW = Date.parse("2026-11-18T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

test("a missing or stale sweep is waited for, a late one counts, and none fails once the patience runs out", async () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  expect(await workerAlive(async () => new Date(NOW - 9 * 60_000), { now: () => NOW, sleep })).toBe(true);
  expect(await workerAlive(async () => new Date(NOW - 11 * 60_000), { now: () => NOW, sleep, patienceMs: 10_000 })).toBe(false);
  expect(sleeps).toEqual([5000, 5000]);
  let calls = 0;
  expect(await workerAlive(async () => (++calls < 3 ? null : new Date(NOW)), { now: () => NOW, sleep })).toBe(true);
  expect(calls).toBe(3);
});

test("a backup under 26 hours old passes; an old one, none yet, none set up or a marker without a time each says what to do", async () => {
  const marker = { DIREX_BACKUP_MARKER: "/var/lib/direx-state/last-backup" };
  expect(backupProblem(marker, () => NOW, () => `${hoursAgo(25.9)}\n`)).toBeNull();
  expect(backupProblem(marker, () => NOW, () => hoursAgo(30))).toBe("the last backup finished 30 hours ago. Check the cron line and state/backup.log (deploy/compose/README.md, Backups)");
  expect(backupProblem({}, () => NOW, () => hoursAgo(1))).toBe("no backups are set up. Set them up as in deploy/compose/README.md, Backups");
  expect(backupProblem(marker, () => NOW, () => "yesterday")).toBe("/var/lib/direx-state/last-backup doesn't hold a time. Run: sh deploy/compose/backup.sh");
  const backup = checks({ ...thisDatabase(), NODE_ENV: "production", DIREX_BACKUP_MARKER: "/nowhere/last-backup" }, { smtpUrl: async () => null }).find((c) => c.name === BACKUP)!;
  expect(await backup.run()).toBe(false);
  expect(await backup.fix()).toBe("no backup has finished yet. Run: sh deploy/compose/backup.sh, then add it to cron (deploy/compose/README.md, Backups)");
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


test("sweep connection and query faults propagate without worker polling", async () => {
  await expect(lastLedgerSweep("postgres://unused:unused@127.0.0.1:1/unused")).rejects.toThrow();
  const url = thisDatabase().DIREX_DB_OWNER_URL!;
  await owner.query("alter schema pgboss rename to pgboss_unavailable");
  try {
    await expect(workerAlive(() => lastLedgerSweep(url))).rejects.toThrow(/pgboss/);
  } finally {
    await owner.query("alter schema pgboss_unavailable rename to pgboss");
  }
});

test("backup clock skew is tolerated for five minutes, and future times beyond it fail", () => {
  const marker = { DIREX_BACKUP_MARKER: "/backup" };
  expect(backupProblem(marker, () => NOW, () => new Date(NOW + 300_000).toISOString())).toBeNull();
  expect(backupProblem(marker, () => NOW, () => new Date(NOW + 300_001).toISOString())).toContain("time in the future");
  expect(backupProblem(marker, () => NOW, () => hoursAgo(26))).toContain("26 hours ago");
});
