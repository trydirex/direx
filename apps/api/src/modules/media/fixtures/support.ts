// SPDX-License-Identifier: AGPL-3.0-only
// What this module's tests borrow from other modules' test helpers, and a direct look at the rows.
import { withWorkspace } from "@direx/db";
import { media } from "@direx/db/schema-media";

export { TEST_SECRET, testIdentity } from "../../identity/test-auth";

/** Every media row in a Workspace, deleted ones included. */
export const mediaRows = (workspaceId: string) => withWorkspace(workspaceId, (tx) => tx.select().from(media));
