// SPDX-License-Identifier: AGPL-3.0-only
// Joining the Placement circle from a Mailbox, through a real sign-in, the vault's member key, the
// Dispatcher and the Gmail plugin against the fake Gmail. The join reply goes out only under a live
// grant, as one Action per pair of codes, without X-Direx-Action, and its mail on both sides is
// placement mail that outreach never sees.
import { createPublicKey, verify } from "node:crypto";
import { createGmailPlugin } from "@direx/extensions";
import { startFakeGmail } from "@direx/extensions/gmail/fake";
import { afterAll, expect, test } from "vitest";
import { ownerClient } from "../../../../../test/db";
import { createVault, credentialLabel, credentialReady, rootKeyFromEnv } from "../credentials/index";
import { approverMayApprove, workspaceLive } from "../identity/index";
import { testIdentity } from "../identity/test-auth";
import { testLedger } from "../ledger/test-effects";
import type { Deployment } from "../models/index";
import { EMAIL_RECEIVED, loadPlugins, MAIL_SENT, type CatalogueEvent } from "../plugins/index";
import { touchCheck } from "../schedule/index";
import { inWorkspace } from "./adapters/repo";
import { createJoin, createPlacement, isPlacementCapability, joinSigned, parseJoin, PLACEMENT_WORDING_VERSION, placementGranted, placementGrantVersion, placementRoutes, routePlacement } from "./index";

const JOIN = "com.trydirex.gmail/placement.join";
const fake = startFakeGmail();
afterAll(() => fake.stop());
const plugins = loadPlugins({
  sources: [{ mode: "in_process", plugin: createGmailPlugin({ baseUrl: fake.url, timeoutMs: 1000 }) }],
  credentials: async () => ({ accessToken: fake.token, expiresAt: "" }),
  confinement: "none",
  log: () => {},
});
const deployment: { value: Deployment } = { value: "self_host" };
const { ledger, clock } = await testLedger({
  effects: plugins.effects,
  resolvers: { credential: credentialLabel, placement_grant: placementGrantVersion },
  checks: [workspaceLive(), approverMayApprove((c) => (isPlacementCapability(c) ? "rule.grant" : undefined)), placementGranted(() => deployment.value), touchCheck({ effects: plugins.effects, now: () => clock.at }), credentialReady],
});
const vault = createVault({ rootKey: rootKeyFromEnv({ DIREX_MASTER_KEY: "11".repeat(32) })!, now: () => clock.at });
const placement = createPlacement({ ledger: () => ledger, deployment: () => deployment.value, now: () => clock.at });
const join = createJoin({
  placement,
  ledger: () => ledger,
  joinFor: async () => ({ id: JOIN, dedupe: "blind", prepare: (ws, input) => plugins.prepare(ws, JOIN, input) }),
  memberKeys: () => vault.memberKeys,
  deployment: () => deployment.value,
});

const { routes, call, signIn, createOrg, addMember } = testIdentity();
routes.route("/", placementRoutes({ placement: () => placement, join: () => join }));
const ownerCookie = await signIn();
const W = (await createOrg(ownerCookie)).workspace.id;
const ownerId = ((await (await call("/api/me", ownerCookie)).json()) as { user: { id: string } }).user.id;
const admin = await addMember(ownerCookie, W, "admin");
const db = await ownerClient();
afterAll(() => db.end());

const mailbox = async () => {
  const address = `${crypto.randomUUID().slice(0, 8)}@acme.test`;
  const r = await vault.create({ workspaceId: W, actorUserId: ownerId, scope: "workspace", kind: "api_key", key: address, name: "Mailbox", meta: {}, value: { key: "x" } });
  if (!r.ok) throw new Error(r.reason);
  return { id: r.credential.id, address };
};
const yes = (m: { id: string; address: string }) => call(`/api/w/${W}/mailboxes/${m.id}/placement`, ownerCookie, { method: "POST", body: { answer: "yes", wordingVersion: PLACEMENT_WORDING_VERSION, confirmAddress: m.address } });
const code = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
const codes = () => ({ part1: code(), part2: code(), signer: "Signer@Circle.test", messageId: "CAp1-x@mail.gmail.com" });
const post = (m: string, body: unknown, cookie = ownerCookie) => call(`/api/w/${W}/mailboxes/${m}/placement/join`, cookie, { method: "POST", body });
const joinActions = async (credentialId: string) => (await db.query("select id from actions where credential_id = $1 and capability = $2", [credentialId, JOIN])).rows.length;
const key = () => ({ workspaceId: W, credentialId: null, pluginId: "com.trydirex.gmail", eventId: crypto.randomUUID() });
const received = (inReplyTo: string, text = "Thanks, you're in."): CatalogueEvent => ({ ...key(), trigger: EMAIL_RECEIVED, data: { headers: { from: "signer@circle.test", subject: "Re: Joining", date: "", inReplyTo, references: "" }, text } });

// Block.

test("with no live grant nothing is created; on the cloud the route isn't there", async () => {
  const m = await mailbox();
  const r = await post(m.id, codes());
  expect([r.status, await r.json()]).toEqual([409, { error: "not_granted" }]);
  expect(await joinActions(m.id)).toBe(0);
  await yes(m);
  deployment.value = "cloud";
  try {
    expect((await post(m.id, codes())).status).toBe(404);
  } finally {
    deployment.value = "self_host";
  }
  expect(await joinActions(m.id)).toBe(0);
});

test("only the granter sends the join, and codes, addresses and Message-IDs must look right", async () => {
  const m = await mailbox();
  await yes(m);
  expect((await post(m.id, codes(), admin.cookie)).status).toBe(403);
  expect((await post(m.id, { ...codes(), part2: "short" })).status).toBe(400);
  expect((await post(m.id, { ...codes(), signer: "not an address" })).status).toBe(400);
  expect((await post(m.id, { ...codes(), messageId: "<no at sign>" })).status).toBe(400);
  expect((await post(m.id, { ...codes(), extra: true })).status).toBe(400);
  expect(await joinActions(m.id)).toBe(0);
});

// Allow.

test("a granted Mailbox sends one signed join reply to the part 1 email, without X-Direx-Action, and its mail is placement mail", async () => {
  const m = await mailbox();
  await yes(m);
  const body = codes();
  const r = await post(m.id, body);
  expect(r.status).toBe(200);
  const { actionId } = (await r.json()) as { actionId: string };
  // Pressing it again with the same codes gives the same Action.
  expect(await (await post(m.id, { ...body, part1: ` ${body.part1} ` })).json()).toEqual({ actionId });
  expect(await joinActions(m.id)).toBe(1);

  const before = fake.sent.length;
  await ledger.run(W, actionId);
  const action = (await ledger.getAction(W, actionId))!;
  expect(action).toMatchObject({ state: "sent", correlationKey: expect.stringMatching(/^<.+>$/) });
  expect(fake.sent).toHaveLength(before + 1);
  const raw = Buffer.from(fake.sent.at(-1)!.raw, "base64url").toString();
  expect(raw).not.toContain("X-Direx-Action");
  expect(raw).toContain("To: signer@circle.test");
  expect(raw).toContain("In-Reply-To: <CAp1-x@mail.gmail.com>");
  const j = parseJoin(Buffer.from(raw.split("\r\n\r\n")[1]!, "base64").toString())!;
  expect(j).toMatchObject({ address: m.address, part1: body.part1, part2: body.part2, key: await vault.memberKeys.publicKey(W, m.id) });
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: j.key }, format: "jwk" });
  expect(verify(null, Buffer.from(joinSigned(j)), pub, Buffer.from(j.sig, "base64url"))).toBe(true);

  // The joiner's Sent copy and a reply to it, and the join reply reaching the signer's own Mailbox.
  await inWorkspace(W, async (tx) => {
    expect(await routePlacement(tx, { ...key(), trigger: MAIL_SENT, data: { messageId: action.correlationKey!, recipients: [], sentAt: 0, xDirexAction: null, listUnsubscribe: null, precedence: null } })).toBe(true);
    expect(await routePlacement(tx, received(action.correlationKey!))).toBe(true);
    expect(await routePlacement(tx, received("<other@mail.gmail.com>", Buffer.from(raw.split("\r\n\r\n")[1]!, "base64").toString()))).toBe(true);
    expect(await routePlacement(tx, received("<other@mail.gmail.com>"))).toBe(false);
  });
});
