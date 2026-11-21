CREATE TABLE "social_pace_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "social_pace_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"network_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb NOT NULL,
	"changed_by" uuid NOT NULL,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "social_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"network_id" text NOT NULL,
	"day" text NOT NULL,
	"slot" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "social_reservations_day_check" CHECK ("social_reservations"."day" ~ '^\d{4}-\d{2}-\d{2}$')
);
--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "posting_from" integer;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "posting_until" integer;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "posting_weekends" boolean;--> statement-breakpoint
ALTER TABLE "social_accounts" ADD COLUMN "gap_minutes" integer;--> statement-breakpoint
ALTER TABLE "social_pace_changes" ADD CONSTRAINT "social_pace_changes_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_pace_changes" ADD CONSTRAINT "social_pace_changes_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_reservations" ADD CONSTRAINT "social_reservations_action_fk" FOREIGN KEY ("workspace_id","action_id") REFERENCES "public"."actions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "social_reservations" ADD CONSTRAINT "social_reservations_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "social_pace_changes_account_idx" ON "social_pace_changes" USING btree ("workspace_id","credential_id","network_id","changed_at");--> statement-breakpoint
CREATE INDEX "social_reservations_day_idx" ON "social_reservations" USING btree ("workspace_id","credential_id","network_id","day");--> statement-breakpoint
CREATE INDEX "social_reservations_action_idx" ON "social_reservations" USING btree ("workspace_id","action_id","created_at");--> statement-breakpoint
ALTER TABLE "social_accounts" ADD CONSTRAINT "social_accounts_pace_check" CHECK (("social_accounts"."posting_from" is null) = ("social_accounts"."posting_until" is null) and ("social_accounts"."posting_from" is null or (0 <= "social_accounts"."posting_from" and "social_accounts"."posting_from" < "social_accounts"."posting_until" and "social_accounts"."posting_until" <= 1440)) and ("social_accounts"."gap_minutes" is null or "social_accounts"."gap_minutes" between 0 and 720));--> statement-breakpoint
-- Forced RLS, same Workspace policy as the rest. Both tables are append-only.
ALTER TABLE social_reservations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE social_reservations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON social_reservations
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON social_reservations FROM direx_app;
--> statement-breakpoint
ALTER TABLE social_pace_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE social_pace_changes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON social_pace_changes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON social_pace_changes FROM direx_app;
--> statement-breakpoint
-- Every live, unsent post with a future time holds its account's day from the start (ADR 0038).
-- Days already over budget or inside a gap stay as they are; dispatch still holds what is over.
INSERT INTO social_reservations (workspace_id, action_id, credential_id, network_id, day, slot, created_at)
SELECT p.workspace_id, a.id, p.credential_id, p.network_id,
  to_char(i.planned_at AT TIME ZONE w.time_zone, 'YYYY-MM-DD'), i.planned_at, now()
FROM social_posts p
JOIN actions a ON a.workspace_id = p.workspace_id AND a.id = p.action_id
JOIN items i ON i.workspace_id = a.workspace_id AND i.action_id = a.id
JOIN workspaces w ON w.id = a.workspace_id
WHERE p.credential_id IS NOT NULL
  AND a.capability LIKE '%/social.publish'
  AND a.state IN ('draft', 'needs_approval', 'scheduled')
  AND i.planned_at > now()
  AND NOT EXISTS (SELECT 1 FROM social_reservations r WHERE r.workspace_id = a.workspace_id AND r.action_id = a.id);
