ALTER TABLE "marketing_plans" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "marketing_plans" ADD CONSTRAINT "marketing_plans_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- ADR 0023: every plan has its Campaign. A plan made before this gets one now, owned by whoever submitted its latest version, else the Workspace's first Owner; archived plans too. Runs as the migration owner across Workspaces, and a plan that already has one keeps it.
INSERT INTO campaigns (workspace_id, plan_id, owner_user_id, created_at, updated_at)
SELECT p.workspace_id, p.id, o.user_id, p.created_at, now()
FROM marketing_plans p
CROSS JOIN LATERAL (
  SELECT coalesce(
    (SELECT v.actor_user_id FROM marketing_plan_versions v WHERE v.workspace_id = p.workspace_id AND v.plan_id = p.id ORDER BY v.version DESC LIMIT 1),
    (SELECT m.user_id FROM workspace_members m WHERE m.workspace_id = p.workspace_id AND m.role = 'owner' ORDER BY m.created_at, m.user_id LIMIT 1)
  ) AS user_id
) o
WHERE o.user_id IS NOT NULL
ON CONFLICT ON CONSTRAINT campaigns_one_per_plan DO NOTHING;
