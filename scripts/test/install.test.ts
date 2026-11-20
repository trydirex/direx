// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

// Exercise the installer without Docker or a real server. Record only commands, using synthetic
// configuration; the mock never prints bootstrap links or reads a real vault.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "direx-install-"));
  mkdirSync(join(dir, "bin"));
  for (const file of ["install.sh", ".env.template"]) copyFileSync(join("deploy/compose", file), join(dir, file));
  writeFileSync(join(dir, "bin/docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$INSTALL_LOG"
case "$*" in
  "compose stop direx") exit "\${FAIL_STOP:-0}" ;;
  "compose run --rm --no-deps direx bun run db:migrate") exit "\${FAIL_MIGRATE:-0}" ;;
  "compose run --rm --no-deps -T direx bun apps/api/src/secrets.ts list") [ -n "\${NO_SMTP:-}" ] || printf 'smtp.url: set\\n' ;;
  "compose run --rm -T direx bun apps/api/src/secrets.ts set smtp.url"*) cat >/dev/null; exit "\${FAIL_SET:-0}" ;;
esac
exit 0
`, { mode: 0o755 });
  const run = (extra: Record<string, string> = {}, args = ["--version", "test"]) => spawnSync("sh", [join(dir, "install.sh"), ...args], {
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, CI: "true", INSTALL_LOG: join(dir, "commands"),
      DIREX_INSTALL_BASE_URL: "http://example.test", DIREX_INSTALL_MAIL_FROM: "Direx <test@example.test>", ...extra },
    encoding: "utf8",
  });
  const commands = () => readFileSync(join(dir, "commands"), "utf8").trim().split("\n");
  return { dir, run, commands, clear: () => writeFileSync(join(dir, "commands"), ""), close: () => rmSync(dir, { recursive: true, force: true }) };
}

const stop = "compose stop direx";
const migrate = "compose run --rm --no-deps direx bun run db:migrate";
const start = "compose up -d --wait direx";

test("fresh install and rerun stop old writers before migrating and starting Direx", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 2; i++) {
      expect(f.run().status).toBe(0);
      const commands = f.commands();
      expect(commands).toContain(stop);
      expect(commands.indexOf(migrate)).toBeGreaterThan(commands.indexOf(stop));
      expect(commands.indexOf(start)).toBeGreaterThan(commands.indexOf(migrate));
      f.clear();
    }
  } finally { f.close(); }
});

test.each(["FAIL_STOP", "FAIL_MIGRATE"])("a %s failure prevents startup; a successful retry stops writers before migration", (failure) => {
  const f = fixture();
  try {
    expect(f.run({ [failure]: "1" }).status).toBe(1);
    expect(f.commands()).toContain(stop);
    expect(f.commands()).not.toContain(start);
    if (failure === "FAIL_STOP") expect(f.commands()).not.toContain(migrate);
    else expect(f.commands()).toContain(migrate);
    f.clear();
    expect(f.run().status).toBe(0);
    expect(f.commands().indexOf(migrate)).toBeGreaterThan(f.commands().indexOf(stop));
    expect(f.commands().indexOf(start)).toBeGreaterThan(f.commands().indexOf(migrate));
  } finally { f.close(); }
});

const setMail = "compose run --rm -T direx bun apps/api/src/secrets.ts set smtp.url";

test("stored mail is kept, and --mail sets it up again before Direx starts", () => {
  const f = fixture();
  try {
    const first = f.run();
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("mail is already set up; to change it: sh install.sh --mail");
    expect(f.commands()).not.toContain(setMail);
    f.clear();
    expect(f.run({ DIREX_INSTALL_SMTP_URL: "smtp://u:p@mail.test:25" }, ["--mail"]).status).toBe(0);
    expect(f.commands().indexOf(setMail)).toBeGreaterThan(f.commands().indexOf(migrate));
    expect(f.commands().indexOf(start)).toBeGreaterThan(f.commands().indexOf(setMail));
  } finally { f.close(); }
});

test("mail that fails its check stops the install before Direx starts, and prints no URL", () => {
  const f = fixture();
  try {
    const r = f.run({ NO_SMTP: "1", FAIL_SET: "1", DIREX_INSTALL_SMTP_URL: "smtp://u:hunter2@mail.test:25" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("mail isn't working, so it wasn't stored");
    expect(f.commands()).toContain(setMail);
    expect(f.commands()).not.toContain(start);
    expect(r.stdout + r.stderr).not.toContain("hunter2");
  } finally { f.close(); }
});

test("in CI the test email goes to DIREX_INSTALL_MAIL_TEST_TO", () => {
  const f = fixture();
  try {
    expect(f.run({ NO_SMTP: "1", DIREX_INSTALL_SMTP_URL: "smtp://u:p@mail.test:25", DIREX_INSTALL_MAIL_TEST_TO: "alice@example.com" }).status).toBe(0);
    expect(f.commands()).toContain(`${setMail} --test-to alice@example.com`);
  } finally { f.close(); }
});
