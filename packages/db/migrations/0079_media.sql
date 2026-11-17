CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"bytes_removed_at" timestamp with time zone,
	CONSTRAINT "media_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "media_kind_check" CHECK ("media"."kind" in ('source', 'clip')),
	CONSTRAINT "media_content_type_check" CHECK ("media"."content_type" in ('video/mp4', 'video/quicktime', 'video/webm')),
	CONSTRAINT "media_bytes_check" CHECK ("media"."bytes" > 0 and "media"."bytes" <= 2147483648),
	CONSTRAINT "media_sha256_check" CHECK ("media"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "media_file_name_check" CHECK (char_length("media"."file_name") between 1 and 255),
	CONSTRAINT "media_removed_after_deleted_check" CHECK ("media"."bytes_removed_at" is null or "media"."deleted_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_sweep_idx" ON "media" USING btree ("workspace_id","kind","created_at");--> statement-breakpoint
-- Forced RLS, same workspace policy as the rest. A delete only marks the row; the sweep removes the bytes.
ALTER TABLE media ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE media FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY workspace_isolation ON media
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
REVOKE DELETE ON media FROM direx_app;
