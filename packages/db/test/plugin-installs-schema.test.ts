// SPDX-License-Identifier: AGPL-3.0-only
// Database-level guarantees of third-party plugin installs (ADR 0026 rules 001 and 002): only a
// Server admin installs, through the system functions; a Workspace's turn-on counts only for the
// install and permissions that exist now; each Workspace sees only its own turn-on.
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { withWorkspace } from "../src/index";
import { organizations, workspaces } from "../src/schema";
import { appClient, insertAuthUser, ownerClient } from "../../../test/db";

let app: pg.Client;
let owner: pg.Client;
const ADMIN = crypto.randomUUID();
const STRANGER = crypto.randomUUID();
const ID = "com.example.links";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const FILE1 = "1".repeat(64);
const FILE2 = "2".repeat(64);
const manifest = (version = "1.0.0") => ({ id: ID, version });

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

const newWorkspace = async () => {
  const id = crypto.randomUUID();
  const orgId = crypto.randomUUID();
  const at = new Date();
  await withWorkspace(id, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name: "Org", createdAt: at });
    await tx.insert(workspaces).values({ id, orgId, name: "W", createdAt: at });
  });
  return id;
};
const enter = (w: string | "") => app.query("select set_config('app.workspace_id', $1, false)", [w]);
const install = (actor: string, mode: string, version = "1.0.0", hash = H1, file = FILE1) =>
  app.query("select system.install_plugin($1, $2, $3, $4, $5, $6, $7) as id", [actor, mode, ID, version, manifest(version), hash, file]);
const installs = async () => (await app.query("select * from system.installed_plugins()")).rows;
const turnOn = (w: string, installId: string, hash = H1) =>
  app.query("insert into workspace_plugins (workspace_id, plugin_id, install_id, permission_hash, enabled_by, enabled_at) values ($1, $2, $3, $4, $5, now())", [w, ID, installId, hash, ADMIN]);
const isOn = async () => (await app.query("select system.plugin_turned_on($1) as on", [ID])).rows[0].on as boolean;

let W: string;
let OTHER: string;
beforeAll(async () => {
  app = await appClient();
  owner = await ownerClient();
  await insertAuthUser(ADMIN);
  await insertAuthUser(STRANGER);
  W = await newWorkspace();
  OTHER = await newWorkspace();
});
afterAll(async () => {
  await app.end();
  await owner.end();
});
beforeEach(async () => {
  await enter("");
  await owner.query("delete from system.plugin_installs; delete from system.plugin_install_events");
  await owner.query("insert into system.server_admins (user_id) values ($1) on conflict do nothing", [ADMIN]);
});

test("direx_app holds no privilege on the install tables and can't run the CLI's or the inner functions", async () => {
  for (const t of ["plugin_installs", "plugin_install_events"]) {
    const { rows } = await app.query("select has_table_privilege('direx_app', $1, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') as p", [`system.${t}`]);
    expect(rows[0].p, t).toBe(false);
  }
  expect(await codeOf(app.query("select system.cli_install_plugin('install', $1, '1.0.0', $2, $3, $4)", [ID, manifest(), H1, FILE1]))).toBe("42501");
  expect(await codeOf(app.query("select system.cli_remove_plugin($1)", [ID]))).toBe("42501");
  expect(await codeOf(app.query("select system.put_plugin_install(null, 'cli', 'install', $1, '1.0.0', $2, $3, $4)", [ID, manifest(), H1, FILE1]))).toBe("42501");
  expect(await codeOf(app.query("select system.drop_plugin_install(null, 'cli', $1)", [ID]))).toBe("42501");
});

test("only a Server admin installs, and every change is recorded with who and what (rule 001)", async () => {
  expect(await codeOf(install(STRANGER, "install"))).toBe("DX403");
  const first = (await install(ADMIN, "install")).rows[0].id as string;
  expect(await codeOf(install(ADMIN, "install"))).toBe("DXINS");
  expect((await install(ADMIN, "upgrade", "1.1.0", H1, FILE2)).rows[0].id).toBe(first);
  await app.query("select system.remove_plugin($1, $2)", [ADMIN, ID]);
  expect(await codeOf(app.query("select system.remove_plugin($1, $2)", [ADMIN, ID]))).toBe("DX404");
  expect(await codeOf(install(ADMIN, "upgrade"))).toBe("DX404");
  await owner.query("select system.cli_install_plugin('install', $1, '1.0.0', $2, $3, $4)", [ID, manifest(), H1, FILE1]);
  const { rows } = await owner.query("select action, version, entry_sha256, via, by_user_id from system.plugin_install_events order by id");
  expect(rows).toEqual([
    { action: "install", version: "1.0.0", entry_sha256: FILE1, via: "web", by_user_id: ADMIN },
    { action: "upgrade", version: "1.1.0", entry_sha256: FILE2, via: "web", by_user_id: ADMIN },
    { action: "remove", version: null, entry_sha256: null, via: "web", by_user_id: ADMIN },
    { action: "install", version: "1.0.0", entry_sha256: FILE1, via: "cli", by_user_id: null },
  ]);
});

test("a manifest whose id or version disagrees with the row is refused", async () => {
  expect(await codeOf(app.query("select system.install_plugin($1, 'install', $2, '1.0.0', $3, $4, $5)", [ADMIN, ID, { id: "com.example.other", version: "1.0.0" }, H1, FILE1]))).toBe("DXARG");
  expect(await codeOf(app.query("select system.install_plugin($1, 'install', $2, '1.0.0', $3, $4, $5)", [ADMIN, ID, manifest("2.0.0"), H1, FILE1]))).toBe("DXARG");
  expect(await codeOf(app.query("select system.install_plugin($1, 'sideload', $2, '1.0.0', $3, $4, $5)", [ADMIN, ID, manifest(), H1, FILE1]))).toBe("DXARG");
});

test("every change bumps the generation and tells listeners", async () => {
  const listener = await appClient();
  const heard: string[] = [];
  listener.on("notification", (n) => heard.push(n.payload ?? ""));
  await listener.query("listen plugins");
  try {
    await install(ADMIN, "install");
    const g1 = (await installs())[0].generation as string;
    await install(ADMIN, "upgrade", "1.1.0", H1, FILE2);
    const g2 = (await installs())[0].generation as string;
    await app.query("select system.remove_plugin($1, $2)", [ADMIN, ID]);
    expect(BigInt(g2)).toBeGreaterThan(BigInt(g1));
    await new Promise((r) => setTimeout(r, 100));
    expect(heard).toHaveLength(3);
    expect(heard.slice(0, 2)).toEqual([g1, g2]);
  } finally {
    await listener.end();
  }
});

test("turn-on counts only for the current install and permissions, and only in its own Workspace (rule 002)", async () => {
  const installId = (await install(ADMIN, "install")).rows[0].id as string;
  await enter(W);
  expect(await isOn()).toBe(false);
  await turnOn(W, installId);
  expect(await isOn()).toBe(true);

  // Another Workspace neither sees the row nor counts as on, and can't write one for W.
  await enter(OTHER);
  expect((await app.query("select * from workspace_plugins")).rows).toEqual([]);
  expect(await isOn()).toBe(false);
  expect(await codeOf(turnOn(W, installId))).toBe("42501");
  await enter("");
  expect(await isOn()).toBe(false);

  // A bytes-only upgrade keeps it on; new permissions don't.
  await install(ADMIN, "upgrade", "1.1.0", H1, FILE2);
  await enter(W);
  expect(await isOn()).toBe(true);
  await install(ADMIN, "upgrade", "1.2.0", H2, FILE2);
  expect(await isOn()).toBe(false);

  // A reinstall is a new install: the old yes doesn't carry over, even with the same permissions.
  await app.query("select system.remove_plugin($1, $2)", [ADMIN, ID]);
  const again = (await install(ADMIN, "install", "1.0.0", H2)).rows[0].id as string;
  expect(again).not.toBe(installId);
  await enter(W);
  expect(await isOn()).toBe(false);
  await app.query("update workspace_plugins set install_id = $1, permission_hash = $2 where plugin_id = $3", [again, H2, ID]);
  expect(await isOn()).toBe(true);
  await app.query("delete from workspace_plugins where plugin_id = $1", [ID]);
  expect(await isOn()).toBe(false);
});
