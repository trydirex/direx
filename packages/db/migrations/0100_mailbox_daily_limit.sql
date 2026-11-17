CREATE TABLE "mailbox_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"day" text NOT NULL,
	"slot" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mailbox_reservations_day_check" CHECK ("mailbox_reservations"."day" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint
CREATE TABLE "mailbox_setting_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "mailbox_setting_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "daily_limit" integer DEFAULT 50 NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "send_from" integer DEFAULT 540 NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "send_until" integer DEFAULT 1020 NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "send_weekends" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "time_zone" text DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "mailbox_reservations" ADD CONSTRAINT "mailbox_reservations_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_reservations" ADD CONSTRAINT "mailbox_reservations_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_setting_changes" ADD CONSTRAINT "mailbox_setting_changes_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_setting_changes" ADD CONSTRAINT "mailbox_setting_changes_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mailbox_reservations_day_idx" ON "mailbox_reservations" USING btree ("workspace_id","credential_id","day");--> statement-breakpoint
CREATE INDEX "mailbox_reservations_action_idx" ON "mailbox_reservations" USING btree ("workspace_id","action_id","created_at");--> statement-breakpoint
CREATE INDEX "mailbox_setting_changes_credential_idx" ON "mailbox_setting_changes" USING btree ("workspace_id","credential_id","changed_at");--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_daily_limit_check" CHECK ("credentials"."daily_limit" between 1 and 500);--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_send_hours_check" CHECK (0 <= "credentials"."send_from" and "credentials"."send_from" < "credentials"."send_until" and "credentials"."send_until" <= 1440);--> statement-breakpoint
-- Forced RLS, same Workspace policy as the rest. Both tables are append-only.
ALTER TABLE mailbox_reservations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mailbox_reservations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON mailbox_reservations
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON mailbox_reservations FROM direx_app;
--> statement-breakpoint
ALTER TABLE mailbox_setting_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mailbox_setting_changes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON mailbox_setting_changes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON mailbox_setting_changes FROM direx_app;
--> statement-breakpoint
-- Every live email already given a time holds its day, so the limit counts it from the start.
INSERT INTO mailbox_reservations (workspace_id, action_id, credential_id, day, slot, created_at)
SELECT a.workspace_id, a.id, a.credential_id,
  to_char(coalesce(i.planned_at, a.due_at) AT TIME ZONE w.time_zone, 'YYYY-MM-DD'),
  coalesce(i.planned_at, a.due_at), now()
FROM actions a
JOIN workspaces w ON w.id = a.workspace_id
LEFT JOIN items i ON i.workspace_id = a.workspace_id AND i.action_id = a.id
WHERE a.credential_id IS NOT NULL
  AND a.capability LIKE '%/email.send'
  AND a.state NOT IN ('cancelled', 'blocked')
  AND coalesce(i.planned_at, a.due_at) IS NOT NULL;
--> statement-breakpoint
-- The app may change a Workspace's time zone and nothing else about the row.
GRANT UPDATE (time_zone) ON workspaces TO direx_app;
