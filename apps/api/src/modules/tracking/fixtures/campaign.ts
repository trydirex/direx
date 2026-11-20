// SPDX-License-Identifier: AGPL-3.0-only
// Tests only: a Campaign whose tracking domain is `domainId`, which keeps that domain from being removed.
import { sql } from "drizzle-orm";
import { withWorkspace } from "@direx/db";

export function campaignUsingDomain(workspaceId: string, ownerUserId: string, domainId: string): Promise<void> {
  return withWorkspace(workspaceId, async (tx) => {
    const { rows } = await tx.execute(sql`insert into marketing_plans (workspace_id, title, created_at, updated_at) values (${workspaceId}, 't', now(), now()) returning id`);
    await tx.execute(
      sql`insert into campaigns (workspace_id, plan_id, owner_user_id, tracking_domain_id, created_at, updated_at) values (${workspaceId}, ${(rows[0] as { id: string }).id}, ${ownerUserId}, ${domainId}, now(), now())`,
    );
  });
}
