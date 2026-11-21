// SPDX-License-Identifier: AGPL-3.0-only
// Test support for outreach: the identity and ledger helpers its send test runs on, and a Mailbox
// whose provider already passed its header check.
import { credentials } from "@direx/db/schema";
import { mailboxHeaderChecks } from "@direx/db/schema-outreach";
import { eq } from "drizzle-orm";
import { credentialSettings } from "../../credentials/index";
import { inWorkspace } from "../adapters/repo";
import { settingsHash } from "../application/header-check";

export { TEST_SECRET, testIdentity } from "../../identity/test-auth";
export { testLedger } from "../../ledger/test-effects";

/**
 * Records that a test Mailbox's provider passed its header check, as a real probe would, and makes it
 * established, with no ramp, so a test about sending isn't paced by a new Mailbox's 20 a day.
 */
export async function passMailboxCheck(workspaceId: string, credentialId: string) {
  await inWorkspace(workspaceId, async (tx) => {
    const settings = await credentialSettings(tx, credentialId);
    if (!settings) throw new Error("passMailboxCheck: no such Mailbox");
    await tx.insert(mailboxHeaderChecks).values({ workspaceId, credentialId, settingsHash: settingsHash(settings), state: "passed", createdAt: new Date(), settledAt: new Date() });
    await tx.update(credentials).set({ rampLimit: null, rampCleanSince: null }).where(eq(credentials.id, credentialId));
  });
}
