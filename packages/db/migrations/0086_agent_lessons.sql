CREATE TABLE "agent_lesson_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lesson_id" uuid,
	"version" integer,
	"item_id" uuid,
	"op" text NOT NULL,
	"evidence_digest" text NOT NULL,
	"person_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_lesson_events_op_check" CHECK ("agent_lesson_events"."op" in ('propose', 'accept', 'dismiss', 'rewrite', 'retire', 'convert'))
);
--> statement-breakpoint
CREATE TABLE "agent_lesson_versions" (
	"workspace_id" uuid NOT NULL,
	"lesson_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"text" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"definition_version" integer,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_lesson_versions_pk" PRIMARY KEY("workspace_id","lesson_id","version"),
	CONSTRAINT "agent_lesson_versions_source_check" CHECK ("agent_lesson_versions"."source" in ('person'))
);
--> statement-breakpoint
CREATE TABLE "agent_lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"state" text NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_lessons_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "agent_lessons_state_check" CHECK ("agent_lessons"."state" in ('live', 'cancelled')),
	CONSTRAINT "agent_lessons_version_check" CHECK ("agent_lessons"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_run_lessons" (
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"lesson_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"digest" text NOT NULL,
	CONSTRAINT "agent_run_lessons_pk" PRIMARY KEY("workspace_id","run_id","lesson_id")
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "lesson_digest" text;--> statement-breakpoint
ALTER TABLE "agent_lesson_events" ADD CONSTRAINT "agent_lesson_events_person_id_user_id_fk" FOREIGN KEY ("person_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lesson_events" ADD CONSTRAINT "agent_lesson_events_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lesson_versions" ADD CONSTRAINT "agent_lesson_versions_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lesson_versions" ADD CONSTRAINT "agent_lesson_versions_lesson_fk" FOREIGN KEY ("workspace_id","lesson_id") REFERENCES "public"."agent_lessons"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_lessons" ADD CONSTRAINT "agent_lessons_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_lessons" ADD CONSTRAINT "agent_run_lessons_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."agent_runs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_lessons" ADD CONSTRAINT "agent_run_lessons_lesson_fk" FOREIGN KEY ("workspace_id","lesson_id") REFERENCES "public"."agent_lessons"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_lesson_events_lesson_idx" ON "agent_lesson_events" USING btree ("workspace_id","lesson_id");--> statement-breakpoint
CREATE INDEX "agent_lessons_agent_idx" ON "agent_lessons" USING btree ("workspace_id","agent","state");--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest.
ALTER TABLE agent_lessons ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_lessons FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_lessons
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_lesson_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_lesson_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_lesson_versions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_lesson_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_lesson_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_lesson_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE agent_run_lessons ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE agent_run_lessons FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON agent_run_lessons
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- A lesson is cancelled, never removed. Its versions, its history and what each run carried never change.
REVOKE DELETE ON agent_lessons FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON agent_lesson_versions FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON agent_lesson_events FROM direx_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON agent_run_lessons FROM direx_app;
