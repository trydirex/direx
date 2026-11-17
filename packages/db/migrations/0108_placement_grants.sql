CREATE TABLE "placement_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "placement_grants_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"answer" text NOT NULL,
	"wording_version" text NOT NULL,
	"answered_by" uuid NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	"stopped_by" uuid,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	CONSTRAINT "placement_grants_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "placement_grants_answer_check" CHECK ("placement_grants"."answer" in ('yes', 'no')),
	CONSTRAINT "placement_grants_stop_check" CHECK (("placement_grants"."stopped_at" is null and "placement_grants"."stopped_by" is null and "placement_grants"."stop_reason" is null) or ("placement_grants"."answer" = 'yes' and "placement_grants"."stopped_at" is not null and "placement_grants"."stopped_by" is not null and length("placement_grants"."stop_reason") between 1 and 500))
);
--> statement-breakpoint
ALTER TABLE "placement_grants" ADD CONSTRAINT "placement_grants_answered_by_user_id_fk" FOREIGN KEY ("answered_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_grants" ADD CONSTRAINT "placement_grants_stopped_by_user_id_fk" FOREIGN KEY ("stopped_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_grants" ADD CONSTRAINT "placement_grants_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_grants" ADD CONSTRAINT "placement_grants_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "placement_grants_current_idx" ON "placement_grants" USING btree ("workspace_id","credential_id","seq");--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE placement_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE placement_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON placement_grants
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- An answer is a record: a new answer adds a row, none is removed, and only the stop is written later.
REVOKE UPDATE, DELETE ON placement_grants FROM direx_app;
--> statement-breakpoint
GRANT UPDATE (stopped_by, stopped_at, stop_reason) ON placement_grants TO direx_app;
