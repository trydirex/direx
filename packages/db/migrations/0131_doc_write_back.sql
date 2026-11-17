CREATE TABLE "doc_write_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "doc_write_grants_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"mapping_hash" text NOT NULL,
	"answer" text NOT NULL,
	"wording_version" text NOT NULL,
	"answered_by" uuid NOT NULL,
	"answered_at" timestamp with time zone NOT NULL,
	"stopped_by" uuid,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	CONSTRAINT "doc_write_grants_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "doc_write_grants_answer_check" CHECK ("doc_write_grants"."answer" in ('yes', 'no')),
	CONSTRAINT "doc_write_grants_hash_check" CHECK ("doc_write_grants"."mapping_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "doc_write_grants_stop_check" CHECK (("doc_write_grants"."stopped_at" is null and "doc_write_grants"."stopped_by" is null and "doc_write_grants"."stop_reason" is null) or ("doc_write_grants"."answer" = 'yes' and "doc_write_grants"."stopped_at" is not null and length("doc_write_grants"."stop_reason") between 1 and 500))
);
--> statement-breakpoint
ALTER TABLE "doc_rows" ADD COLUMN "written_state" text;--> statement-breakpoint
ALTER TABLE "doc_rows" ADD COLUMN "written_option_id" text;--> statement-breakpoint
ALTER TABLE "doc_rows" ADD COLUMN "written_edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "doc_rows" ADD COLUMN "generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_rows" ADD COLUMN "write_action_id" uuid;--> statement-breakpoint
ALTER TABLE "doc_sources" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "doc_sources" ADD COLUMN "write_back" jsonb;--> statement-breakpoint
ALTER TABLE "doc_sources" ADD COLUMN "mapping_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "doc_write_grants" ADD CONSTRAINT "doc_write_grants_answered_by_user_id_fk" FOREIGN KEY ("answered_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_write_grants" ADD CONSTRAINT "doc_write_grants_stopped_by_user_id_fk" FOREIGN KEY ("stopped_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_write_grants" ADD CONSTRAINT "doc_write_grants_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_write_grants" ADD CONSTRAINT "doc_write_grants_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."doc_sources"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_write_grants" ADD CONSTRAINT "doc_write_grants_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "doc_write_grants_current_idx" ON "doc_write_grants" USING btree ("workspace_id","source_id","seq");--> statement-breakpoint
ALTER TABLE "doc_sources" ADD CONSTRAINT "doc_sources_credential_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."credentials"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Forced RLS, same workspace policy as every Workspace table. Answers are appended and only a stop is
-- written later, as for placement_grants (0108).
ALTER TABLE doc_write_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE doc_write_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON doc_write_grants
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE UPDATE, DELETE ON doc_write_grants FROM direx_app;
--> statement-breakpoint
GRANT UPDATE (stopped_by, stopped_at, stop_reason) ON doc_write_grants TO direx_app;
