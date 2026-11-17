CREATE TABLE "note_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"note_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "notes_workspace_id_id_key" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "note_comments" ADD CONSTRAINT "note_comments_note_fk" FOREIGN KEY ("workspace_id","note_id") REFERENCES "public"."notes"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "note_comments_workspace_id_note_id_idx" ON "note_comments" USING btree ("workspace_id","note_id");