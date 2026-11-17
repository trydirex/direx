CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"text" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"plan_id" uuid,
	"started_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "ideas_text_check" CHECK (char_length("ideas"."text") between 1 and 500 and "ideas"."text" = btrim("ideas"."text")),
	CONSTRAINT "ideas_started_check" CHECK ("ideas"."plan_id" is null or "ideas"."started_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_plan_fk" FOREIGN KEY ("workspace_id","plan_id") REFERENCES "public"."marketing_plans"("workspace_id","id") ON DELETE SET NULL ("plan_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ideas_workspace_created_idx" ON "ideas" USING btree ("workspace_id","created_at");
--> statement-breakpoint
-- ideas_plan_fk above is edited by hand: SET NULL ("plan_id") clears only the link when Delete draft removes
-- the plan, so the Idea is open again (ADR 0023 rule 005); drizzle can't write the column list.
-- Forced RLS, same workspace policy as every Workspace table. An Idea is dismissed, never deleted.
ALTER TABLE ideas ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ideas FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON ideas
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON ideas FROM direx_app;
