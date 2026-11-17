// SPDX-License-Identifier: AGPL-3.0-only
// Manual smoke test for a connected Gmail Mailbox: sends one message from it through the
// ledger, with the vault's access token. Development only. It approves in the name of the
// user id it is given, which no real path may do (approvals come from a signed-in
// session), and it skips the schedule's coordination rules.
//
// Stop the API first, so its worker does not take the Action, then:
//   NODE_ENV=development bun apps/api/scripts/gmail-smoke.ts <workspaceId> <credentialId> <yourUserId> <to>
import { createGmailPlugin, GOOGLE_PROVIDER } from "@direx/extensions";
import { createBoss } from "../src/jobs/boss";
import { credentialLabel, credentialReady, vaultFromEnv } from "../src/modules/credentials/index";
import { authConfigFromEnv } from "../src/modules/identity/index";
import { approverIdFromSession, createLedger } from "../src/modules/ledger/index";
import { loadPlugins } from "../src/modules/plugins/index";

if (process.env.NODE_ENV !== "development") throw new Error("gmail-smoke runs only with NODE_ENV=development");
const [workspaceId, credentialId, userId, to] = process.argv.slice(2);
if (!workspaceId || !credentialId || !userId || !to) throw new Error("usage: gmail-smoke.ts <workspaceId> <credentialId> <yourUserId> <to>");

const SEND = "com.trydirex.gmail/email.send";
const vault = vaultFromEnv(authConfigFromEnv(), undefined, { googleApps: [GOOGLE_PROVIDER] });
const plugins = loadPlugins({ sources: [{ mode: "in_process", plugin: createGmailPlugin() }], credentials: vault.credentials, confinement: "none" });
const boss = createBoss();
await boss.start();
try {
  const ledger = createLedger({ boss, signingKeys: vault.approvalKeys, effects: plugins.effects, checks: [credentialReady], resolvers: { credential: credentialLabel } });
  const { spec, preview } = await plugins.prepare(workspaceId, SEND, {
    to: [to],
    subject: "Direx smoke test",
    text: "Sent from a connected Mailbox by the Direx credential vault smoke test.",
  });
  console.log(preview);
  const actor = { userId };
  const { action } = await ledger.createAction(workspaceId, { idempotencyKey: crypto.randomUUID(), capability: SEND, dedupe: "queryable", spec, actor, credentialId });
  await ledger.submitForApproval(workspaceId, action.id, actor);
  const approved = await ledger.approve(workspaceId, action.id, { approverId: approverIdFromSession(userId), draftVersion: 1, snapshot: [] });
  if (!approved.ok) throw new Error(`approve refused: ${approved.reason}`);
  await ledger.run(workspaceId, action.id);
  const done = await ledger.getAction(workspaceId, action.id);
  console.log({ actionId: action.id, state: done?.state, holdReason: done?.holdReason, providerRef: done?.providerRef });
} finally {
  await plugins.close();
  await boss.stop({ graceful: false, close: true });
}
