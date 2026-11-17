// SPDX-License-Identifier: AGPL-3.0-only
// A content test's yes: who may give it, for which step, and which receivers a content check may
// reach with and without it. The yes is bound into each check's approval and goes stale when a newer
// yes for the step or new words replace it.
import { expect, test } from "vitest";
import { appClient, ownerClient } from "../../../../../test/db";
import { createVault, rootKeyFromEnv } from "../credentials/index";
import { testIdentity } from "../identity/test-auth";
import type { Deployment } from "../models/index";
import { inWorkspace } from "./adapters/repo";
import { CONTENT_TEST_WORDING_VERSION, contentTestVersion, contentTestWording, createContentTests } from "./index";

const deployment: { value: Deployment } = { value: "self_host" };
const tests = createContentTests({ deployment: () => deployment.value });
const { call, signIn, createOrg, addMember } = testIdentity();
const ownerCookie = await signIn();
const W = (await createOrg(ownerCookie)).workspace.id;
const ownerId = ((await (await call("/api/me", ownerCookie)).json()) as { user: { id: string } }).user.id;
const viewer = await addMember(ownerCookie, W, "viewer");
const owner = { userId: ownerId, role: "owner" as const };
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => new Date() });

/** A Campaign with a template step A, a template step B and a per-Person step P. Its plan is left out. */
const C = crypto.randomUUID();
{
  const c = await ownerClient();
  try {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query("insert into campaigns (id, workspace_id, plan_id, owner_user_id, created_at, updated_at) values ($1, $2, $3, $4, now(), now())", [C, W, crypto.randomUUID(), ownerId]);
    for (const [key, mode] of [["a", "template"], ["b", "template"], ["p", "per_person"]])
      await c.query("insert into campaign_steps (workspace_id, campaign_id, step_key, type, drafting_mode, updated_at) values ($1, $2, $3, 'email', $4, now())", [W, C, key, mode]);
    await c.query("commit");
  } finally {
    await c.end();
  }
}

const OWN = `${crypto.randomUUID().slice(0, 8)}@acme.test`;
const created = await vault.create({ workspaceId: W, actorUserId: ownerId, scope: "workspace", kind: "api_key", key: OWN, connection: "gmail", name: "Mailbox", meta: {}, value: { key: "x" } });
if (!created.ok) throw new Error(created.reason);
const MEMBER = "kim@circle.test";
const OTHER = "lee@circle.test";

const yes = (stepKey: string, receivers: string[], who: { userId: string; role: "owner" | "viewer" } = owner, wordingVersion = CONTENT_TEST_WORDING_VERSION) =>
  tests.record(W, who, { campaignId: C, stepKey, receivers, wordingVersion });
const bind = (stepKey: string, receiver: string) => tests.binding(W, { campaignId: C, stepKey, receiver });

test("the words name every receiving address and say copies can be kept", () => {
  const words = contentTestWording([MEMBER, OTHER]);
  for (const named of [MEMBER, OTHER, "may keep a copy", "Alex at Example Ltd"]) expect(words).toContain(named);
});

test("with no yes a content check goes only to this Workspace's own Mailbox", async () => {
  expect(await bind("a", OWN.toUpperCase())).toEqual([]);
  expect(await bind("a", MEMBER)).toBeNull();
});

test("a yes reaches only the step and the receivers it named, and binds into the approval", async () => {
  const r = await yes("a", [` ${MEMBER.toUpperCase()} `]);
  if (!r.ok) throw new Error(r.reason);
  const snapshot = await bind("a", MEMBER);
  expect(snapshot).toEqual([{ kind: "placement_content_test", id: r.id, version: `${ownerId}:${CONTENT_TEST_WORDING_VERSION}` }]);
  expect(await inWorkspace(W, (tx) => contentTestVersion(tx, r.id))).toBe(snapshot![0]!.version);
  // A yes for step A is not a yes for step B, nor for a receiver it did not name.
  expect(await bind("b", MEMBER)).toBeNull();
  expect(await bind("a", OTHER)).toBeNull();
  // A newer yes for the step replaces it: the old binding goes stale and only the new receivers count.
  const later = await yes("a", [OTHER]);
  if (!later.ok) throw new Error(later.reason);
  expect(await inWorkspace(W, (tx) => contentTestVersion(tx, r.id))).toBeNull();
  expect(await bind("a", MEMBER)).toBeNull();
  expect(await bind("a", OTHER)).toHaveLength(1);
});

test("a yes is refused from a viewer, on old words, for a per-Person step, without receivers, and on the cloud", async () => {
  expect(await yes("b", [MEMBER], { userId: viewer.userId, role: "viewer" })).toEqual({ ok: false, reason: "forbidden" });
  expect(await yes("b", [MEMBER], owner, "2020-01-01")).toEqual({ ok: false, reason: "stale_wording" });
  expect(await yes("p", [MEMBER])).toEqual({ ok: false, reason: "not_found" });
  expect(await yes("missing", [MEMBER])).toEqual({ ok: false, reason: "not_found" });
  expect(await yes("b", [])).toEqual({ ok: false, reason: "bad_receivers" });
  expect(await yes("b", ["not an address"])).toEqual({ ok: false, reason: "bad_receivers" });
  deployment.value = "cloud";
  try {
    expect(await yes("b", [MEMBER])).toEqual({ ok: false, reason: "not_available" });
    expect(await bind("a", OWN)).toBeNull();
  } finally {
    deployment.value = "self_host";
  }
  expect(await bind("b", MEMBER)).toBeNull();
});

test("a yes can't be changed or removed, and another Workspace can't see it", async () => {
  const r = await yes("b", [MEMBER]);
  if (!r.ok) throw new Error(r.reason);
  const c = await appClient();
  try {
    await c.query("select set_config('app.workspace_id', $1, false)", [W]);
    await expect(c.query("update placement_content_tests set receivers = '{x@y.z}' where id = $1", [r.id])).rejects.toThrow(/permission denied/);
    await expect(c.query("delete from placement_content_tests where id = $1", [r.id])).rejects.toThrow(/permission denied/);
    await c.query("select set_config('app.workspace_id', $1, false)", [crypto.randomUUID()]);
    expect((await c.query("select id from placement_content_tests where id = $1", [r.id])).rows).toHaveLength(0);
  } finally {
    await c.end();
  }
});
