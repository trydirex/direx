CREATE TABLE "outside_touches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "outside_touches_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "outside_touches_source_ref_key" UNIQUE("workspace_id","source","source_ref"),
	CONSTRAINT "outside_touches_channel_check" CHECK ("outside_touches"."channel" in ('call', 'linkedin', 'x', 'email_other', 'other')),
	CONSTRAINT "outside_touches_direction_check" CHECK ("outside_touches"."direction" in ('outbound', 'inbound')),
	CONSTRAINT "outside_touches_source_check" CHECK ("outside_touches"."source" in ('manual', 'direx_draft')),
	CONSTRAINT "outside_touches_source_ref_check" CHECK (("outside_touches"."source" = 'manual') = ("outside_touches"."source_ref" is null))
);
--> statement-breakpoint
ALTER TABLE "outside_touches" ADD CONSTRAINT "outside_touches_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outside_touches" ADD CONSTRAINT "outside_touches_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outside_touches" ADD CONSTRAINT "outside_touches_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outside_touches_person_idx" ON "outside_touches" USING btree ("workspace_id","person_id","occurred_at");--> statement-breakpoint
--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table.
ALTER TABLE outside_touches ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE outside_touches FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON outside_touches
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- Rows are never edited. Only a person's own manual entry can be removed, and only in its first
-- 10 minutes, to undo a slip; after that it stays as part of the record.
REVOKE UPDATE ON outside_touches FROM direx_app;
--> statement-breakpoint
CREATE POLICY delete_recent_manual ON outside_touches AS RESTRICTIVE FOR DELETE
  USING (source = 'manual' AND created_at > now() - interval '10 minutes');
