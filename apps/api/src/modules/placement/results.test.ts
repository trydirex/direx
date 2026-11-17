// SPDX-License-Identifier: AGPL-3.0-only
// The results screen's data, over HTTP: per ISO week, plain and content checks apart, the checks sent,
// the reports counted and each verdict at least 3 counted reports agree on. Fewer show no verdict.
// Every answer carries the bootstrap flag, and the reports this Mailbox sent other members.
import { afterAll, expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { createVault, rootKeyFromEnv } from "../credentials/index";
import { testIdentity } from "../identity/test-auth";
import { fakeEffect, testLedger } from "../ledger/test-effects";
import type { Deployment } from "../models/index";
import { inWorkspace, insertProbe, saveListState } from "./adapters/repo";
import { BOOTSTRAP_NOTE, FEWER_THAN_AGREEING } from "./application/results";
import { createPlacement, placementRoutes } from "./index";
import { PlacementResults } from "./routes";

const SEND = "test/placement.send";
const REPORT = "test/placement.report";
const deployment: { value: Deployment } = { value: "self_host" };
const { ledger, clock } = await testLedger({ effects: { [SEND]: fakeEffect("blind").capability, [REPORT]: fakeEffect("blind").capability }, checks: [] });
const placement = createPlacement({ ledger: () => ledger, deployment: () => deployment.value, now: () => clock.at });
const { routes, call, signIn, createOrg, addMember } = testIdentity();
routes.route("/", placementRoutes({ placement: () => placement, join: () => { throw new Error("not here"); } }));
const ownerCookie = await signIn();
const W = (await createOrg(ownerCookie)).workspace.id;
const ownerId = ((await (await call("/api/me", ownerCookie)).json()) as { user: { id: string } }).user.id;
const viewer = await addMember(ownerCookie, W, "viewer");
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });
const db = await ownerClient();
afterAll(() => db.end());
const q = async (text: string, params: unknown[] = []) => (await db.query(text, params)).rows;

const mailbox = async (workspaceId = W) => {
  const r = await vault.create({ workspaceId, actorUserId: ownerId, scope: "workspace", kind: "api_key", key: `${crypto.randomUUID().slice(0, 8)}@acme.test`, name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!r.ok) throw new Error(r.reason);
  return r.credential.id;
};
const action = async (credentialId: string, capability: string, state: string) => {
  const { action } = await ledger.createAction(W, { idempotencyKey: crypto.randomUUID(), capability, dedupe: "blind", spec: {}, credentialId, actor: { system: "placement" } });
  await q("update actions set state = $1 where id = $2", [state, action.id]);
  return action.id;
};
/** A check this Mailbox sent `peer` on `day`, with the verdict a report counted for it, if any. */
const sent = async (m: string, day: string, kind: "plain" | "content", reported: string | null, o: { state?: string; skipReason?: string } = {}) =>
  inWorkspace(W, async (tx) =>
    insertProbe(tx, {
      workspaceId: W,
      credentialId: m,
      direction: "send",
      day,
      listVersion: 1,
      kind,
      seq: kind === "plain" ? 0 : 1,
      peer: `${crypto.randomUUID().slice(0, 8)}@circle.test`,
      expectedAt: new Date(`${day}T10:00:00Z`),
      actionId: await action(m, SEND, o.state ?? "sent"),
      skipReason: o.skipReason ?? null,
      reportedVerdict: reported,
      reportedAt: reported ? clock.at : null,
      createdAt: clock.at,
    }),
  );
const results = async (m: string, cookie = ownerCookie) => call(`/api/w/${W}/mailboxes/${m}/placement/results`, cookie);
const body = async (m: string) => PlacementResults.parse(await (await results(m)).json());
const list = (bootstrap: boolean) => inWorkspace(W, (tx) => saveListState(tx, { workspaceId: W, version: 1, contentHash: "c".repeat(64), list: { version: 1, expires: "2027-01-01T00:00:00Z", bootstrap, members: [], removed: [] }, rootChainLength: 0, rootChainHash: "", pinnedRootHash: "", trustedAt: clock.at }));

// Block.

test("2 agreeing reports show no verdict, and plain and content checks never add up", async () => {
  const m = await mailbox();
  // Week 50: 2 plain and 2 content checks reported spam; together they would be 4.
  for (const kind of ["plain", "content"] as const) for (const day of ["2026-12-07", "2026-12-08"]) await sent(m, day, kind, "spam");
  // Not sent, or skipped: neither counts as sent.
  await sent(m, "2026-12-09", "plain", null, { state: "cancelled" });
  await sent(m, "2026-12-10", "plain", null, { skipReason: "sender_mx" });
  const [week] = (await body(m)).weeks;
  expect(week).toEqual({
    week: "2026-W50",
    plain: { sent: 2, counted: 2, verdicts: [], note: FEWER_THAN_AGREEING },
    content: { sent: 2, counted: 2, verdicts: [], note: FEWER_THAN_AGREEING },
    difference: [],
  });
});

test("an answer without the bootstrap flag is refused by the response schema", async () => {
  const m = await mailbox();
  const { bootstrap: _, ...rest } = await body(m);
  expect(PlacementResults.safeParse(rest).success).toBe(false);
});

test("on Direx's cloud, or for a Mailbox of another Workspace, there are no results", async () => {
  const m = await mailbox();
  deployment.value = "cloud";
  expect((await results(m)).status).toBe(404);
  deployment.value = "self_host";
  const otherCookie = await signIn();
  const other = (await createOrg(otherCookie)).workspace.id;
  expect((await call(`/api/w/${other}/mailboxes/${m}/placement/results`, otherCookie)).status).toBe(404);
});

// Allow.

test("3 agreeing reports show the verdict with the checks sent and the agreeing count, and the difference only where both kinds show it", async () => {
  await list(true);
  const m = await mailbox();
  // Week 49: 4 plain checks, 3 reported primary and 1 missing; 3 content checks reported spam, 1 not yet reported.
  for (const day of ["2026-11-30", "2026-12-01", "2026-12-02"]) await sent(m, day, "plain", "primary");
  await sent(m, "2026-12-03", "plain", "missing");
  for (const day of ["2026-12-01", "2026-12-02", "2026-12-03"]) await sent(m, day, "content", "spam");
  await sent(m, "2026-12-04", "content", null);
  // Week 50: 3 plain and 3 content checks in spam.
  for (const kind of ["plain", "content"] as const) for (const day of ["2026-12-07", "2026-12-08", "2026-12-09"]) await sent(m, day, kind, "spam");
  const r = await body(m);
  expect([r.bootstrap, r.bootstrapNote]).toEqual([true, BOOTSTRAP_NOTE]);
  expect(r.weeks).toEqual([
    {
      week: "2026-W50",
      plain: { sent: 3, counted: 3, verdicts: [{ verdict: "spam", reports: 3 }], note: null },
      content: { sent: 3, counted: 3, verdicts: [{ verdict: "spam", reports: 3 }], note: null },
      difference: [{ verdict: "spam", plain: 3, content: 3 }],
    },
    {
      week: "2026-W49",
      plain: { sent: 4, counted: 4, verdicts: [{ verdict: "primary", reports: 3 }], note: null },
      content: { sent: 4, counted: 3, verdicts: [{ verdict: "spam", reports: 3 }], note: null },
      difference: [],
    },
  ]);
  // Any member reads it; a list signed by 3 or more no longer says bootstrap.
  expect((await results(m, viewer.cookie)).status).toBe(200);
  await list(false);
  expect(await body(m)).toMatchObject({ bootstrap: false, bootstrapNote: null });
});

test("the reports this Mailbox sent show each sender, day, verdict and the report's state and time", async () => {
  const m = await mailbox();
  const report = await action(m, REPORT, "sent");
  const at = (await q("select updated_at from actions where id = $1", [report]))[0]!.updated_at as Date;
  const receive = (day: string, kind: "plain" | "content", verdict: string, reportActionId: string | null) =>
    inWorkspace(W, (tx) => insertProbe(tx, { workspaceId: W, credentialId: m, direction: "receive", day, listVersion: 1, kind, seq: 0, peer: "kim@circle.test", expectedAt: new Date(`${day}T10:00:00Z`), verdict, reportActionId, createdAt: clock.at }));
  await receive("2026-12-10", "plain", "primary", report);
  await receive("2026-12-10", "content", "missing", report);
  // Read, not reported yet.
  await receive("2026-12-11", "plain", "spam", null);
  expect((await body(m)).reportsSent).toEqual([
    { sender: "kim@circle.test", day: "2026-12-10", kind: "content", verdict: "missing", state: "sent", holdReason: null, at: at.toISOString() },
    { sender: "kim@circle.test", day: "2026-12-10", kind: "plain", verdict: "primary", state: "sent", holdReason: null, at: at.toISOString() },
  ]);
});
