// SPDX-License-Identifier: AGPL-3.0-only
// Test support: the newsletter's jobs on a real ledger with the worker's checks, against the fake Kit
// and two fake beehiiv accounts, one on a plan whose API won't send.
import { createBeehiivPlugin, createFakeBeehiiv, createFakeKit, createKitPlugin, firstPartyPlugins } from "@direx/extensions";
import { afterAll } from "vitest";
import { appClient } from "../../../../../../test/db";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../../credentials/index";
import { approverFromMember, can } from "../../identity/index";
import { seedMember } from "../../identity/fixtures/member";
import { createItems } from "../../items/index";
import { person, testLedger } from "../../ledger/test-effects";
import { loadPlugins, newsletterLists } from "../../plugins/index";
import { touchCheck } from "../../schedule/index";
import { createNewsletter, issueDesk, newsletterAfterSend, newsletterKinds, newsletterWeekly } from "../index";

export { person };

export async function newsletterWorld() {
  const clock = { at: new Date("2026-11-08T05:00:00Z") }; // Sunday 06:00 in Berlin, the draft day for Tuesday 09:00
  const kit = createFakeKit();
  const subscriptions = [{ email: "reader@example.com", status: "active", created: 1_700_000_000 }];
  const beehiiv = createFakeBeehiiv({ key: "beehiiv-pro", subscriptions });
  const beehiivFree = createFakeBeehiiv({ key: "beehiiv-free", subscriptions, sendApi: false });
  // One beehiiv plugin, two accounts: each request goes to the fake whose key it carries.
  const beehiivFetch = ((input: string | URL | Request, init?: RequestInit) =>
    (new Headers(init?.headers).get("authorization")?.includes(beehiivFree.key) ? beehiivFree : beehiiv).fetch(input, init)) as typeof fetch;
  const keys = new Map<string, string>();
  const plugins = loadPlugins({
    sources: [
      { mode: "in_process", plugin: createKitPlugin({ fetch: kit.fetch, now: () => clock.at.getTime() }) },
      { mode: "in_process", plugin: createBeehiivPlugin({ fetch: beehiivFetch, now: () => clock.at.getTime() }) },
    ],
    credentials: async (_ws, credentialId) => ({ key: keys.get(credentialId!)! }),
    confinement: "none",
    log: () => {},
  });
  const { ledger } = await testLedger({ effects: plugins.effects, resolvers: { credential: credentialLabel }, checks: [touchCheck({ effects: plugins.effects, now: () => clock.at }), credentialReady], now: () => clock.at });
  const items = createItems({ ledger, kinds: newsletterKinds(), now: () => clock.at });
  const who = { approverId: approverFromMember(person), may: (p: string) => can("owner", p as "item.approve") };
  const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });
  const lists = newsletterLists(firstPartyPlugins().map((p) => p.manifest));
  const newsletter = createNewsletter({ credentials: (ws) => vault.list(ws), lists: () => ["kit", "beehiiv"], now: () => clock.at });
  const weekly = newsletterWeekly({ items: () => items, lists: () => lists, credentials: (ws) => vault.list(ws), now: () => clock.at });
  const desk = issueDesk({ items: () => items, now: () => clock.at });
  const counts = { statsReads: 0 };
  const afterSend = newsletterAfterSend({
    items: () => items,
    ledger: () => ledger,
    lists: () => lists,
    query: (ws, capability, input, credentialId) => {
      if (capability.endsWith("/newsletter.stats")) counts.statsReads++;
      return plugins.query(ws, capability, input, credentialId);
    },
    now: () => clock.at,
  });

  const db = await appClient();
  afterAll(() => db.end());
  async function rows(ws: string, sql: string) {
    await db.query("begin");
    await db.query("select set_config('app.workspace_id', $1, true)", [ws]);
    const r = await db.query(sql);
    await db.query("commit");
    return r.rows;
  }

  /** A Workspace with its Tuesday 09:00 Berlin issue on, sent through this key or copied to Substack. */
  async function workspace(list: { connection: "kit" | "beehiiv"; key: string } | "substack") {
    const W = crypto.randomUUID();
    await seedMember(W, person.userId);
    let credentialId: string | null = null;
    if (list !== "substack") {
      const made = await vault.create({ workspaceId: W, actorUserId: person.userId, scope: "workspace", kind: "api_key", key: `api_key:${list.connection}`, connection: list.connection, name: list.connection, meta: {}, value: { key: list.key } });
      if (!made.ok) throw new Error(made.reason);
      keys.set(made.credential.id, list.key);
      credentialId = made.credential.id;
    }
    const saved = await newsletter.saveSettings(W, { list: list === "substack" ? "substack" : "connected", credentialId, weekday: 2, sendTime: "09:00", timeZone: "Europe/Berlin", enabled: true });
    if (!saved.ok) throw new Error(saved.reason);
    return { W, credentialId };
  }

  /** The newest issue Item of a Workspace. */
  const latestIssue = async (W: string) => (await items.list(W, { offset: 0, limit: 50 })).items.filter((i) => i.workArea === "newsletter" && i.kind !== "newsletter_skipped").sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]!;

  /** Writes and approves the Item, then runs it at its due time if it is an Action. */
  async function writeAndApprove(W: string, itemId: string, title = "Week 45") {
    await desk.revise(W, itemId, { title, markdown: "Hello." }, person.userId);
    const submitted = await desk.submit(W, itemId, person.userId);
    if (!submitted.ok) throw new Error(submitted.reason);
    const approved = await items.approve(W, itemId, submitted.issue.item.revision, who);
    if (!approved.ok) throw new Error(approved.reason);
    const actionId = await items.actionIdOf(W, itemId);
    if (!actionId) return null;
    clock.at = (await ledger.getAction(W, actionId))!.dueAt!;
    await ledger.run(W, actionId);
    return (await ledger.getAction(W, actionId))!;
  }

  return { clock, kit, beehiiv, beehiivFree, ledger, items, who, newsletter, weekly, desk, afterSend, counts, rows, workspace, latestIssue, writeAndApprove };
}
