CREATE TABLE "standing_rule_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"change" text NOT NULL,
	"reason" text,
	"facts" jsonb NOT NULL,
	"capability_hash" text NOT NULL,
	"template_revision" integer NOT NULL,
	"actor_user_id" uuid,
	"actor_system" text,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "standing_rule_revisions_change_check" CHECK ("standing_rule_revisions"."change" in ('grant', 'reconfirm', 'suspend', 'revoke')),
	CONSTRAINT "standing_rule_revisions_one_actor_check" CHECK (num_nonnulls("standing_rule_revisions"."actor_user_id", "standing_rule_revisions"."actor_system") = 1)
);
--> statement-breakpoint
CREATE TABLE "standing_rule_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"day" date NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "standing_rule_uses_rule_action_key" UNIQUE("rule_id","action_id")
);
--> statement-breakpoint
CREATE TABLE "standing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"touch_class" text NOT NULL,
	"campaign_id" uuid NOT NULL,
	"step_key" text NOT NULL,
	"template_revision" integer NOT NULL,
	"facts" jsonb NOT NULL,
	"capability_hash" text NOT NULL,
	"daily_cap" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"people_as_of" timestamp with time zone NOT NULL,
	"drafting_agent" text,
	"status" text DEFAULT 'active' NOT NULL,
	"suspended_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "standing_rules_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "standing_rules_status_check" CHECK ("standing_rules"."status" in ('active', 'suspended', 'revoked')),
	CONSTRAINT "standing_rules_suspended_reason_check" CHECK (("standing_rules"."status" = 'suspended') = ("standing_rules"."suspended_reason" is not null)),
	CONSTRAINT "standing_rules_daily_cap_check" CHECK ("standing_rules"."daily_cap" > 0),
	CONSTRAINT "standing_rules_touch_class_check" CHECK ("standing_rules"."touch_class" in ('cold', 'consented_marketing'))
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "standing_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "standing_rule_revisions" ADD CONSTRAINT "standing_rule_revisions_rule_fk" FOREIGN KEY ("workspace_id","rule_id") REFERENCES "public"."standing_rules"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_rule_uses" ADD CONSTRAINT "standing_rule_uses_rule_fk" FOREIGN KEY ("workspace_id","rule_id") REFERENCES "public"."standing_rules"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_rule_uses" ADD CONSTRAINT "standing_rule_uses_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_rules" ADD CONSTRAINT "standing_rules_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_rules" ADD CONSTRAINT "standing_rules_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_rules" ADD CONSTRAINT "standing_rules_step_fk" FOREIGN KEY ("workspace_id","campaign_id","step_key") REFERENCES "public"."campaign_steps"("workspace_id","campaign_id","step_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "standing_rule_revisions_rule_idx" ON "standing_rule_revisions" USING btree ("workspace_id","rule_id");--> statement-breakpoint
CREATE INDEX "standing_rule_uses_day_idx" ON "standing_rule_uses" USING btree ("workspace_id","rule_id","day");--> statement-breakpoint
CREATE INDEX "standing_rules_step_idx" ON "standing_rules" USING btree ("workspace_id","campaign_id","step_key");--> statement-breakpoint
-- Forced RLS on the standing rule tables, same workspace policy as the rest.
ALTER TABLE standing_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE standing_rules FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON standing_rules
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE standing_rule_revisions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE standing_rule_revisions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON standing_rule_revisions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE standing_rule_uses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE standing_rule_uses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON standing_rule_uses
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A rule is revoked, never deleted; revisions are history; a use can be given back but not changed.
REVOKE DELETE ON standing_rules FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON standing_rule_revisions FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE ON standing_rule_uses FROM direx_app;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_standing_rule_fk" FOREIGN KEY ("workspace_id","standing_rule_id") REFERENCES "public"."standing_rules"("workspace_id","id") ON DELETE no action ON UPDATE no action;
