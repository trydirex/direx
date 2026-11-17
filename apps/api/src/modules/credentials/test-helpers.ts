// SPDX-License-Identifier: AGPL-3.0-only
// Test only: Workspaces, members and raw reads as the app role, for the vault suites, and
// the credential routes behind identity's real sign-in.
import { expect } from "vitest";
import { appClient, insertAuthUser } from "../../../../../test/db";
import { createIdentity, logMailer, type Mail } from "../identity/index";
import type { Vault } from "./application/secrets";
import { credentialRoutes, type KeyConnect, type MailboxConnect } from "./routes";

export function vaultDb() {
  let c: Awaited<ReturnType<typeof appClient>> | undefined;
  const client = async () => (c ??= await appClient());

  /** One statement inside a Workspace. */
  async function q(workspaceId: string, text: string, params: unknown[] = []) {
    const db = await client();
    await db.query("begin");
    try {
      await db.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
      const r = await db.query(text, params);
      await db.query("commit");
      return r.rows;
    } catch (e) {
      await db.query("rollback");
      throw e;
    }
  }

  async function newUser() {
    const id = crypto.randomUUID();
    await insertAuthUser(id);
    return id;
  }

  async function addMember(ws: string, userId: string, role = "marketer") {
    await q(ws, "insert into workspace_members (workspace_id, user_id, role, created_at) values ($1, $2, $3, now())", [ws, userId, role]);
  }

  async function newWorkspace() {
    const owner = await newUser();
    const org = crypto.randomUUID();
    const ws = crypto.randomUUID();
    const db = await client();
    await db.query("begin");
    await db.query("select set_config('app.workspace_id', $1, true)", [ws]);
    await db.query("insert into organizations (id, name, created_at) values ($1, 'O', now())", [org]);
    await db.query("insert into workspaces (id, org_id, name, created_at) values ($1, $2, 'W', now())", [ws, org]);
    await db.query("insert into workspace_members (workspace_id, user_id, role, created_at) values ($1, $2, 'owner', now())", [ws, owner]);
    await db.query("commit");
    return { ws, owner };
  }

  const events = (ws: string, id: string) =>
    q(ws, "select consumer, outcome, error_code from credential_access_events where credential_id = $1 order by id", [id]);

  return { q, newUser, addMember, newWorkspace, events, close: () => c?.end() };
}

/** identity's routes plus the credential routes, with magic-link sign-in through an in-memory outbox. */
export function testApp(vault: Vault, baseURL = "http://direx.test", mailboxes?: MailboxConnect, keys?: KeyConnect, linkNetwork?: (connection: string) => string | undefined) {
  const outbox: Mail[] = [];
  const identity = createIdentity(() => ({
    baseURL: "http://localhost:3000",
    secret: "test-secret-that-is-at-least-32-characters",
    devMode: true,
    mailer: logMailer(outbox),
  }));
  const app = identity.routes;
  app.route("/", credentialRoutes({ auth: identity.auth, vault: () => vault, baseURL: () => baseURL, ...(mailboxes ? { mailboxes } : {}), ...(keys ? { keys } : {}), ...(linkNetwork ? { linkNetwork } : {}) }));

  const call = (path: string, cookie?: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? "GET",
      headers: { ...(cookie && { cookie }), ...(init.body !== undefined && { "content-type": "application/json" }) },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });

  /** Signs a new person in; returns their session cookie and user id. */
  async function signIn(email = `${crypto.randomUUID()}@example.com`) {
    const res = await call("/api/auth/sign-in/magic-link", undefined, { method: "POST", body: { email, callbackURL: "/" } });
    expect(res.status).toBe(200);
    const link = [...outbox].reverse().find((m) => m.to === email)!.text.match(/https?:\/\/\S+/)![0];
    const verified = await app.request(link);
    const cookie = verified.headers.get("set-cookie")!.split(";")[0]!;
    const me = (await (await call("/api/me", cookie)).json()) as { user: { id: string } };
    return { cookie, userId: me.user.id };
  }

  /** A new Workspace and its Owner. */
  async function workspace() {
    const owner = await signIn();
    const res = await call("/api/orgs", owner.cookie, { method: "POST", body: { name: "Acme", workspaceName: "Acme marketing" } });
    expect(res.status).toBe(201);
    return { ws: ((await res.json()) as { workspace: { id: string } }).workspace.id, owner };
  }

  return { app, call, signIn, workspace };
}
