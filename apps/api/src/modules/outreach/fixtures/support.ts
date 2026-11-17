// SPDX-License-Identifier: AGPL-3.0-only
// Test support for outreach: the identity and ledger helpers its send test runs on, and a Mailbox
// whose provider already passed its header check.
import { mailboxHeaderChecks } from "@direx/db/schema-outreach";
import { credentialSettings } from "../../credentials/index";
import { inWorkspace } from "../adapters/repo";
import { settingsHash } from "../application/header-check";

export { TEST_SECRET, testIdentity } from "../../identity/test-auth";
export { testLedger } from "../../ledger/test-effects";

/** Records that a test Mailbox's provider passed its header check, as a real probe would. */
export async function passMailboxCheck(workspaceId: string, credentialId: string) {
  await inWorkspace(workspaceId, async (tx) => {
    const settings = await credentialSettings(tx, credentialId);
    if (!settings) throw new Error("passMailboxCheck: no such Mailbox");
    await tx.insert(mailboxHeaderChecks).values({ workspaceId, credentialId, settingsHash: settingsHash(settings), state: "passed", createdAt: new Date(), settledAt: new Date() });
  });
}
