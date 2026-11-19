CREATE TABLE "campaign_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occurred_on" date,
	"voids" uuid,
	"actor_user_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "campaign_outcomes_mark_key" UNIQUE("workspace_id","campaign_id","person_id","kind","id"),
	CONSTRAINT "campaign_outcomes_voids_key" UNIQUE("voids"),
	CONSTRAINT "campaign_outcomes_kind_check" CHECK ("campaign_outcomes"."kind" in ('meeting', 'deal')),
	CONSTRAINT "campaign_outcomes_occurred_on_check" CHECK (("campaign_outcomes"."voids" is null) = ("campaign_outcomes"."occurred_on" is not null)),
	CONSTRAINT "campaign_outcomes_voids_self_check" CHECK ("campaign_outcomes"."voids" is distinct from "campaign_outcomes"."id")
);
--> statement-breakpoint
ALTER TABLE "campaign_outcomes" ADD CONSTRAINT "campaign_outcomes_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_outcomes" ADD CONSTRAINT "campaign_outcomes_person_fk" FOREIGN KEY ("workspace_id","campaign_id","person_id") REFERENCES "public"."campaign_people"("workspace_id","campaign_id","person_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_outcomes" ADD CONSTRAINT "campaign_outcomes_voids_fk" FOREIGN KEY ("workspace_id","campaign_id","person_id","kind","voids") REFERENCES "public"."campaign_outcomes"("workspace_id","campaign_id","person_id","kind","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE campaign_outcomes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE campaign_outcomes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON campaign_outcomes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A mark is never changed or removed: an undo is a new row that voids it.
REVOKE UPDATE, DELETE ON campaign_outcomes FROM direx_app;
