// SPDX-License-Identifier: AGPL-3.0-only
// Tests only: Campaigns on a tracking domain, and the facts about a Person that tracking reads.
import { sql } from "drizzle-orm";
import { withWorkspace } from "@direx/db";

/** A Campaign whose tracking domain is `domainId`, which keeps that domain from being removed. */
export async function campaignUsingDomain(workspaceId: string, ownerUserId: string, domainId: string): Promise<void> {
  await trackingCampaign(workspaceId, ownerUserId, domainId, { tracking: false });
}

/** The Workspace's first member. */
export const ownerOf = (workspaceId: string) =>
  withWorkspace(workspaceId, async (tx) => ((await tx.execute(sql`select user_id from workspace_members`)).rows[0] as { user_id: string }).user_id);

/** A Campaign on the domain with its switches as given, both turned on by `ownerUserId`; its id. */
export function trackingCampaign(workspaceId: string, ownerUserId: string, domainId: string, s: { tracking: boolean; perPerson?: boolean }): Promise<string> {
  return withWorkspace(workspaceId, async (tx) => {
    const { rows } = await tx.execute(sql`insert into marketing_plans (workspace_id, title, created_at, updated_at) values (${workspaceId}, 't', now(), now()) returning id`);
    const made = await tx.execute(sql`
      insert into campaigns (workspace_id, plan_id, owner_user_id, tracking_domain_id, tracking_on, tracking_set_by, tracking_wording_version, per_person_on, per_person_set_by, per_person_wording_version, created_at, updated_at)
      values (${workspaceId}, ${(rows[0] as { id: string }).id}, ${ownerUserId}, ${domainId}, ${s.tracking}, ${ownerUserId}, 1, ${s.tracking && (s.perPerson ?? false)}, ${ownerUserId}, 1, now(), now())
      returning id`);
    return (made.rows[0] as { id: string }).id;
  });
}

/** Records the Person's country, stated by a person or inferred. */
export async function personCountry(workspaceId: string, recordedBy: string, personId: string, country: string, confidence: "stated" | "inferred"): Promise<void> {
  await withWorkspace(workspaceId, (tx) =>
    tx.execute(
      sql`insert into person_eligibility (workspace_id, person_id, country, basis, evidence, country_confidence, recorded_by, recorded_at) values (${workspaceId}, ${personId}, ${country}, 'published_address', 'their site', ${confidence}, ${recordedBy}, now())`,
    ),
  );
}
